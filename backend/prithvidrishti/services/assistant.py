"""
Evidence-grounded assistant.

The answer's facts and its map actions are assembled deterministically from
the event service — the same data the dashboard shows. A language model, when
one is configured, may only add a short narrative over that evidence; it never
supplies numbers and cannot override the assessment. With no model configured
the assistant still works.

Map actions are a closed set the frontend executes:
  select_event {event_id} · highlight_events {event_ids} · fit_bounds {bbox}
"""

from __future__ import annotations

import re
from typing import Any

from prithvidrishti.services.events import SEVERITY_ORDER, EventDetail, EventSummary

MAX_MESSAGE_CHARS = 500

_OVERRIDE = re.compile(
    r"\b(ignore|disregard|forget|override)\b.*\b(evidence|data|instructions?|satellite|forecast)\b"
    r"|\b(pretend|just say|tell me (it|the area) is safe|say (it|the area) is safe)\b", re.I)
_WHY = re.compile(r"\b(why|explain|reason|because|driv)", re.I)
_RANK = re.compile(r"\b(highest|most|worst|top|rank|biggest|severe|serious|priorit)", re.I)
_STATUS = re.compile(r"\b(system|status|health|online|operational|working|providers?)\b", re.I)
_PLACE = re.compile(r"\b(?:show|go to|zoom to|fly to|take me to|where is|find)\s+(?:me\s+)?(.{2,80})", re.I)
_EXPOSURE = re.compile(r"\b(exposure|exposed|population|people|infrastructure|assets?|facilit)", re.I)


def _answer(title: str, summary: str, **extra: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "title": title, "summary": summary, "risk_level": None, "factors": [],
        "confidence": None, "evidence": [], "caveats": [], "items": [], "statements": [],
    }
    base.update(extra)
    return base


def classify(message: str, has_selection: bool) -> str:
    """Intent for a user message. Pure — exported for tests."""
    if _OVERRIDE.search(message):
        return "override_attempt"
    if _WHY.search(message) and has_selection:
        return "explain_event"
    if _RANK.search(message):
        return "rank_events"
    if _STATUS.search(message) and not _WHY.search(message):
        return "system_status"
    if _PLACE.search(message):
        return "go_to_place"
    if _WHY.search(message):
        return "explain_event"
    return "overview"


def explain_event(detail: EventDetail) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    event = detail.event
    factors = [f"{c.name.capitalize()}: {c.basis}" for c in detail.risk.components]
    confidence = (
        event.confidence.label if event.confidence.label
        else f"{event.confidence.value:.0%} ensemble agreement"
        if event.confidence.value is not None else "Not provided by the source")
    answer = _answer(
        title=event.title,
        summary=detail.risk.explanation,
        statements=detail.statements,
        risk_level=event.severity,
        factors=factors,
        confidence=confidence,
        evidence=[{"role": e.role, "source": e.source, "data_status": e.data_status}
                  for e in detail.evidence],
        caveats=[f"{n['item']}: {n['reason']}" for n in detail.not_available]
                + ([event.data_status_note] if event.data_status_note else []),
    )
    return answer, [{"type": "select_event", "event_id": event.id}]


def rank_events(events: list[EventSummary], message: str) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    current = [e for e in events if e.status != "past"] or events
    if not current:
        return _answer("No events", "There are no events to rank right now."), []
    wants_exposure = bool(_EXPOSURE.search(message))
    ranked = sorted(current, key=lambda e: e.updated_at, reverse=True)
    ranked.sort(key=lambda e: SEVERITY_ORDER[e.severity], reverse=True)
    measured = [e for e in ranked if e.population_exposed.status == "available"]
    caveats = []
    by_exposure = wants_exposure and bool(measured)
    if by_exposure:
        ranked = sorted(measured, key=lambda e: e.population_exposed.value or 0, reverse=True)
        if len(measured) < len(current):
            caveats.append(f"{len(current) - len(measured)} event(s) have no measured population "
                           "exposure and are not ranked here.")
    elif wants_exposure:
        caveats.append(
            "No current event has a measured population exposure — that needs a satellite "
            "flood or surface-water analysis. The ranking below uses severity.")
    top = ranked[:5]
    items = [{
        "event_id": e.id, "title": e.title, "severity": e.severity,
        "detail": (f"About {e.population_exposed.value:,.0f} people in the detected extent "
                   f"(range {e.population_exposed.low:,.0f}–{e.population_exposed.high:,.0f}). {e.headline}"
                   if by_exposure else e.headline),
        "data_status": e.data_status,
    } for e in top]
    answer = _answer(
        title="Highest population exposure" if by_exposure else "Highest-severity events",
        summary=(f"{len(current)} current event(s). The most severe is "
                 f"{top[0].title} ({top[0].severity.upper()}): {top[0].headline}."),
        risk_level=top[0].severity,
        items=items,
        evidence=[{"role": "Event list", "source": e.source.provider, "data_status": e.data_status}
                  for e in top[:3]],
        caveats=caveats,
    )
    return answer, [{"type": "highlight_events", "event_ids": [e.id for e in top]}]


def overview(events: list[EventSummary]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    current = [e for e in events if e.status != "past"]
    high = [e for e in current if SEVERITY_ORDER[e.severity] >= 2]
    summary = (f"{len(current)} current event(s), {len(high)} rated high or critical; "
               f"{len(events) - len(current)} past event(s) in the feed.")
    return _answer(
        title="Current situation",
        summary=summary,
        items=[{"event_id": e.id, "title": e.title, "severity": e.severity,
                "detail": e.headline, "data_status": e.data_status} for e in current[:5]],
        caveats=["Ask “why is this high risk?” with an event selected, “which events are "
                 "most severe?”, “show Kathmandu”, or “system status”."],
    ), ([{"type": "highlight_events", "event_ids": [e.id for e in current[:5]]}] if current else [])


def override_refusal() -> tuple[dict[str, Any], list[dict[str, Any]]]:
    return _answer(
        title="I can only report what the evidence shows",
        summary=("I can't set the evidence aside or declare an area safe. Assessments "
                 "come from the forecast model and data feeds, and I report them as they are."),
        caveats=["Select an event and ask why it is rated the way it is to see the evidence."],
    ), []


def system_status(groups: list[dict[str, Any]]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    bad = [g for g in groups if g["state"] not in ("operational",)]
    summary = ("All services are operational." if not bad else
               f"{len(groups) - len(bad)} of {len(groups)} services are operational.")
    return _answer(
        title="System status", summary=summary,
        items=[{"title": g["name"], "severity": None, "detail": f"{g['state_label']} — {g['detail']}",
                "data_status": None, "event_id": None} for g in groups],
    ), []


def place_query(message: str) -> str | None:
    m = _PLACE.search(message)
    if not m:
        return None
    return m.group(1).strip(" ?.!").removeprefix("the ").strip() or None
