"""
Unified environmental-event model.

Turns what the platform actually knows into one event shape the dashboard can
render: the forecast agent's ensemble forecasts and GDACS's global flood feed
today; the ``type`` field is open so satellite detections and change events
can join later without a frontend rewrite.

Honesty rules (enforced here, tested in tests/test_events.py):
  * every number is traceable to a field the backend produced or an external
    feed returned — nothing is generated;
  * anything not measured is a ``Measure`` with status ``unavailable`` or
    ``not_assessed`` and a plain-language reason;
  * ``data_status`` is ``live`` only when no simulated input fed the result.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

DataStatus = Literal["live", "demo"]
Severity = Literal["low", "medium", "high", "critical"]
MeasureStatus = Literal["available", "unavailable", "not_assessed"]

# Hazard-probability bands. 0.7 / 0.9 are the orchestrator's IMMINENT and
# EVACUATION phase thresholds, so severity and phase can never disagree.
SEVERITY_BANDS: tuple[tuple[float, Severity], ...] = (
    (0.9, "critical"), (0.7, "high"), (0.3, "medium"), (0.0, "low"),
)
GDACS_SEVERITY: dict[str, Severity] = {"green": "low", "orange": "high", "red": "critical"}
SEVERITY_ORDER: dict[str, int] = {"low": 0, "medium": 1, "high": 2, "critical": 3}

POPULATION_UNAVAILABLE = (
    "No population dataset is integrated yet, so exposure cannot be computed."
)
EXTENT_UNAVAILABLE = (
    "No observed flood extent: satellite flood detection is not implemented yet."
)
VULNERABILITY_UNAVAILABLE = "No vulnerability dataset is integrated."


class Measure(BaseModel):
    """A quantity that may be known, unknown, or simply not computed yet."""

    status: MeasureStatus
    value: float | None = None
    low: float | None = None
    high: float | None = None
    unit: str = ""
    source: str | None = None
    reason: str | None = None
    # True when ``value`` is a floor (e.g. a provider result that was truncated).
    lower_bound: bool = False

    @classmethod
    def unavailable(cls, reason: str, unit: str = "") -> Measure:
        return cls(status="unavailable", reason=reason, unit=unit)

    @classmethod
    def not_assessed(cls, reason: str, unit: str = "") -> Measure:
        return cls(status="not_assessed", reason=reason, unit=unit)


class EventSource(BaseModel):
    provider: str
    kind: Literal["forecast_model", "external_feed", "satellite_detection"]
    url: str | None = None


class Confidence(BaseModel):
    """What the confidence number means differs by source — say which."""

    value: float | None = None
    kind: Literal["ensemble_agreement", "detection_class", "not_provided"] = "not_provided"
    # Qualitative class for detections ("Probable", "High confidence"…).
    label: str | None = None
    explanation: str = ""


class EventSummary(BaseModel):
    id: str
    type: str = "flood"
    kind: Literal["forecast", "reported", "detected"]
    title: str
    location_name: str
    center: dict[str, float]
    bbox: dict[str, float] | None = None
    detected_at: str
    updated_at: str
    ended_at: str | None = None
    status: Literal["forecast", "active", "past"]
    source: EventSource
    data_status: DataStatus
    data_status_note: str | None = None
    severity: Severity
    confidence: Confidence
    affected_area_km2: Measure
    population_exposed: Measure
    assets_exposed: Measure
    headline: str


class RiskComponent(BaseModel):
    name: Literal["hazard", "exposure", "vulnerability"]
    status: MeasureStatus | Literal["partial"]
    score: float | None = Field(None, ge=0.0, le=1.0)
    label: str
    basis: str
    details: list[dict[str, Any]] = Field(default_factory=list)


class RiskAssessment(BaseModel):
    level: Severity
    complete: bool
    basis: str
    explanation: str
    components: list[RiskComponent]


class EvidenceItem(BaseModel):
    role: str
    source: str
    kind: Literal["observation", "model", "dataset", "external_report", "trigger"]
    timestamp: str | None = None
    version: str | None = None
    detail: str = ""
    url: str | None = None
    data_status: DataStatus = "live"


class EventDetail(BaseModel):
    event: EventSummary
    what_happened: str
    why_it_matters: str
    risk: RiskAssessment
    uncertainty: list[dict[str, Any]]
    evidence: list[EvidenceItem]
    not_available: list[dict[str, str]]
    history: list[dict[str, Any]]
    # Sentences tagged OBSERVED / INFERRED / UNCERTAIN / RECOMMENDED.
    statements: list[dict[str, str]] = Field(default_factory=list)
    metrics: list[dict[str, Any]] = Field(default_factory=list)
    quality_flags: list[str] = Field(default_factory=list)
    risk_method: dict[str, Any] | None = None
    has_geometry: bool = False
    # ForestGuard: independent datasets that support (or do not support) a detection.
    supporting_evidence: list[dict[str, Any]] = Field(default_factory=list)
    hotspots: list[dict[str, Any]] = Field(default_factory=list)
    fusion: dict[str, Any] | None = None
    # Knowledge-graph relationships of a detection, as readable rows.
    relationships: list[dict[str, str]] = Field(default_factory=list)


# ── helpers ──────────────────────────────────────────────────────────


def severity_from_probability(p: float) -> Severity:
    for threshold, label in SEVERITY_BANDS:
        if p >= threshold:
            return label
    return "low"


def _iso(value: Any) -> str:
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value or "")


def _dump(obj: Any) -> dict[str, Any]:
    return obj if isinstance(obj, dict) else obj.model_dump()


def _slug(text: str) -> str:
    return "".join(c if c.isalnum() else "-" for c in text.lower()).strip("-")[:48] or "area"


def _pretty(watershed_id: str) -> str:
    words = watershed_id.replace("_", " ").strip().split()
    words = [w for w in words if not w.isdigit()]
    return " ".join(w.capitalize() for w in words) or watershed_id


def percentile(sorted_values: list[float], q: float) -> float | None:
    """Nearest-rank percentile on pre-sorted data; None for an empty list."""
    if not sorted_values:
        return None
    idx = min(len(sorted_values) - 1, max(0, round(q * (len(sorted_values) - 1))))
    return sorted_values[idx]


def bbox_center(bbox: dict[str, float]) -> dict[str, float]:
    return {
        "lat": round((bbox["south"] + bbox["north"]) / 2, 5),
        "lng": round((bbox["west"] + bbox["east"]) / 2, 5),
    }


def _at_least(assets: dict[str, Any]) -> str:
    """'at least ' when the provider truncated the result, else ''."""
    return "at least " if assets.get("truncated") else ""


def _assets_measure(assets: dict[str, Any] | None) -> Measure:
    if assets is None:
        return Measure.not_assessed(
            "Critical facilities have not been queried for this area yet.", "facilities")
    if assets.get("status") != "available":
        return Measure.unavailable(
            assets.get("reason") or "OpenStreetMap query failed.", "facilities")
    return Measure(status="available", value=float(assets["total"]), unit="facilities",
                   source="OpenStreetMap (Overpass)",
                   lower_bound=bool(assets.get("truncated")))


# ── forecast events ──────────────────────────────────────────────────


def forecast_stats(forecast: dict[str, Any]) -> dict[str, Any]:
    """Ensemble statistics actually present in a FloodForecast payload."""
    members = forecast.get("ensemble_members") or []
    depths = sorted(float(m["peak_depth_m"]) for m in members)
    disagreements = forecast.get("zone_disagreements") or []
    top = disagreements[0] if disagreements else {}
    timing = forecast.get("timing") or {}
    return {
        "members": len(members),
        "depth_p5": percentile(depths, 0.05),
        "depth_p50": percentile(depths, 0.50),
        "depth_p95": percentile(depths, 0.95),
        "agreement": top.get("agreement_strength"),
        "dominant_outcome": top.get("dominant_outcome"),
        "peak_time": _iso(timing.get("peak_time")) or None,
        "earliest_peak": _iso(timing.get("earliest_peak")) or None,
        "latest_peak": _iso(timing.get("latest_peak")) or None,
    }


def _forecast_is_demo(forecast: dict[str, Any], tag: dict[str, Any]) -> tuple[bool, str | None]:
    source = forecast.get("ensemble_source")
    if source == "statistical-mock":
        return True, ("Rainfall forcing was unavailable, so this forecast used the "
                      "statistical demo ensemble — not real data.")
    if tag.get("simulated"):
        return True, ("Triggered by a simulated gauge anomaly. The rainfall forcing and "
                      "runoff routing behind the numbers are real.")
    return False, None


def build_forecast_event(
    forecasts: list[dict[str, Any]],
    tag: dict[str, Any] | None = None,
    assets: dict[str, Any] | None = None,
) -> EventSummary:
    """One event per forecast area; ``forecasts`` is its history, oldest first."""
    tag = tag or {}
    latest = forecasts[-1]
    bbox = _dump(latest["bbox"])
    p = float(latest.get("max_probability") or 0.0)
    stats = forecast_stats(latest)
    severity = severity_from_probability(p)
    demo, note = _forecast_is_demo(latest, tag)
    name = tag.get("area") or _pretty(str(latest.get("watershed_id", "")))
    rp = latest.get("max_return_period_years")

    confidence = Confidence(
        value=stats["agreement"],
        kind="ensemble_agreement" if stats["agreement"] is not None else "not_provided",
        explanation=(
            f"Share of the {stats['members']} ensemble members that agree on the "
            f"most common outcome ({stats['dominant_outcome']}). It measures model "
            "agreement, not verified accuracy."
            if stats["agreement"] is not None else "No ensemble agreement was reported."
        ),
    )
    headline = f"{p:.0%} of ensemble members exceed 0.5 m peak depth"
    if rp:
        headline += f"; about a {rp}-year event"

    return EventSummary(
        id=f"fc-{_slug(str(latest.get('watershed_id', name)))}",
        kind="forecast",
        title=f"Flood forecast — {name}",
        location_name=name,
        center=bbox_center(bbox),
        bbox=bbox,
        detected_at=_iso(forecasts[0].get("generated_at")),
        updated_at=_iso(latest.get("generated_at")),
        status="forecast",
        source=EventSource(provider="Prithvi Drishti forecast agent", kind="forecast_model"),
        data_status="demo" if demo else "live",
        data_status_note=note,
        severity=severity,
        confidence=confidence,
        affected_area_km2=Measure.unavailable(EXTENT_UNAVAILABLE, "km²"),
        population_exposed=Measure.unavailable(POPULATION_UNAVAILABLE, "people"),
        assets_exposed=_assets_measure(assets),
        headline=headline,
    )


def build_forecast_detail(
    forecasts: list[dict[str, Any]],
    tag: dict[str, Any] | None = None,
    assets: dict[str, Any] | None = None,
) -> EventDetail:
    tag = tag or {}
    latest = forecasts[-1]
    event = build_forecast_event(forecasts, tag, assets)
    stats = forecast_stats(latest)
    p = float(latest.get("max_probability") or 0.0)
    rp = latest.get("max_return_period_years")
    demo = event.data_status == "demo"

    hazard_details: list[dict[str, Any]] = []
    if stats["depth_p50"] is not None:
        hazard_details.append({"label": "Peak depth (median)", "value": stats["depth_p50"], "unit": "m"})
    if rp:
        hazard_details.append({"label": "Return period", "value": rp, "unit": "years"})
    bench = latest.get("benchmark_peak_discharge_m3s")
    if bench is not None:
        hazard_details.append({"label": "GloFAS benchmark peak", "value": round(bench), "unit": "m³/s"})

    hazard = RiskComponent(
        name="hazard", status="available", score=p, label=event.severity.upper(),
        basis=f"{p:.0%} of {stats['members']} ensemble members exceed 0.5 m peak depth.",
        details=hazard_details,
    )

    if assets and assets.get("status") == "available":
        exposure = RiskComponent(
            name="exposure", status="partial", label="PARTIAL",
            basis=(f"{_at_least(assets)}{assets['total']} critical facilities lie inside the forecast area "
                   "(OpenStreetMap). They are inside the analysed area, not inside a "
                   "mapped flood extent. Population is unavailable, so no exposure "
                   "score is computed."),
            details=[{"label": k.replace("_", " ").capitalize(), "value": v, "unit": ""}
                     for k, v in sorted(assets["counts"].items(), key=lambda kv: -kv[1])],
        )
    else:
        exposure = RiskComponent(
            name="exposure", status="unavailable" if assets else "not_assessed",
            label="UNAVAILABLE" if assets else "NOT ASSESSED",
            basis=((assets or {}).get("reason")
                   or "Facilities not queried yet. " + POPULATION_UNAVAILABLE),
        )
    vulnerability = RiskComponent(
        name="vulnerability", status="unavailable", label="UNAVAILABLE",
        basis=VULNERABILITY_UNAVAILABLE,
    )

    explanation = (
        f"Rated {event.severity.upper()} on hazard alone: {hazard.basis} "
        "Exposure and vulnerability could not be scored, so this is not a full "
        "risk assessment."
    )
    risk = RiskAssessment(
        level=event.severity, complete=False, basis="hazard only",
        explanation=explanation, components=[hazard, exposure, vulnerability],
    )

    uncertainty: list[dict[str, Any]] = []
    if stats["depth_p5"] is not None:
        uncertainty.append({
            "label": "Peak depth", "unit": "m", "value": stats["depth_p50"],
            "low": stats["depth_p5"], "high": stats["depth_p95"],
            "explanation": "5th–95th percentile across ensemble members.",
        })
    if stats["earliest_peak"] and stats["latest_peak"]:
        uncertainty.append({
            "label": "Peak timing", "unit": "time", "value": stats["peak_time"],
            "low": stats["earliest_peak"], "high": stats["latest_peak"],
            "explanation": "5th–95th percentile of member peak times.",
        })
    if event.confidence.value is not None:
        uncertainty.append({
            "label": "Ensemble agreement", "unit": "fraction",
            "value": event.confidence.value, "low": None, "high": None,
            "explanation": event.confidence.explanation,
        })

    issued = event.updated_at
    evidence = [
        EvidenceItem(
            role="Trigger", kind="trigger", timestamp=event.detected_at,
            source=("Simulated gauge anomaly" if tag.get("simulated")
                    else "Analysis request" if tag.get("origin") == "analysis"
                    else "Sentinel agent anomaly"),
            detail=("Injected through the demo endpoint — not an observation."
                    if tag.get("simulated") else "Started this forecast."),
            data_status="demo" if tag.get("simulated") else "live",
        ),
        EvidenceItem(
            role="Rainfall forcing", kind="dataset", timestamp=issued,
            source=("Statistical demo ensemble" if latest.get("ensemble_source") == "statistical-mock"
                    else "Open-Meteo forecast precipitation"),
            detail="Daily precipitation for the area, perturbed ±20% per ensemble member.",
            url="https://open-meteo.com/",
            data_status="demo" if latest.get("ensemble_source") == "statistical-mock" else "live",
        ),
        EvidenceItem(
            role="Runoff model", kind="model", timestamp=issued,
            source="Prithvi Drishti linear-reservoir routing", version="hydrology/runoff v4 + calibration v5",
            detail=(f"{stats['members']} members routed through a delayed linear reservoir; "
                    "magnitude scaled against the GloFAS record where at least 10 paired years exist."),
        ),
    ]
    thresholds = latest.get("benchmark_discharge_thresholds_m3s")
    if thresholds:
        pairs = ", ".join(f"{k}-yr {round(float(v))} m³/s" for k, v in sorted(
            thresholds.items(), key=lambda kv: int(kv[0])))
        evidence.append(EvidenceItem(
            role="Flood-frequency thresholds", kind="dataset", timestamp=issued,
            source="GloFAS discharge reanalysis (via Open-Meteo)",
            detail=f"Weibull fit on annual maxima since 1984: {pairs}.",
            url="https://open-meteo.com/en/docs/flood-api",
        ))
    if assets and assets.get("status") == "available":
        evidence.append(EvidenceItem(
            role="Infrastructure", kind="dataset", timestamp=assets.get("fetched_at"),
            source="OpenStreetMap (Overpass API)",
            detail=f"{assets['total']} critical facilities in the analysed area"
                   + (" (result truncated)." if assets.get("truncated") else "."),
            url="https://www.openstreetmap.org/copyright",
        ))

    not_available = [
        {"item": "Satellite observation", "reason": EXTENT_UNAVAILABLE},
        {"item": "Population exposure", "reason": POPULATION_UNAVAILABLE},
        {"item": "Vulnerability", "reason": VULNERABILITY_UNAVAILABLE},
    ]

    what = (
        f"The forecast model routed rainfall for {event.location_name} through "
        f"{stats['members']} ensemble members. {event.headline}."
    )
    if stats["depth_p5"] is not None:
        what += (f" Peak depth is estimated at {stats['depth_p50']:.2f} m "
                 f"(range {stats['depth_p5']:.2f}–{stats['depth_p95']:.2f} m).")
    what += " This is a forecast, not an observed flood."
    if demo and event.data_status_note:
        what += " " + event.data_status_note

    if assets and assets.get("status") == "available":
        why = (f"{_at_least(assets).capitalize()}{assets['total']} critical facilities (hospitals, schools, emergency "
               "services) are mapped inside the forecast area. Which of them would "
               "actually flood is unknown without an observed or modelled extent.")
    else:
        why = ("Impact cannot be stated yet: critical facilities have not been "
               "queried and no population dataset is integrated.")

    history = [{
        "at": _iso(f.get("generated_at")),
        "max_probability": f.get("max_probability"),
        "max_return_period_years": f.get("max_return_period_years"),
    } for f in forecasts]

    statements = [
        {"tag": "INFERRED", "text": what},
        {"tag": "INFERRED", "text": explanation},
        {"tag": "UNCERTAIN", "text": "No flood has been observed for this forecast, and exposure and "
                                     "vulnerability could not be scored."},
        {"tag": "RECOMMENDED", "text": "Run a satellite flood or surface-water analysis for this area "
                                       "to check the forecast against an observation."},
    ]
    return EventDetail(
        event=event, what_happened=what, why_it_matters=why, risk=risk,
        uncertainty=uncertainty, evidence=evidence, not_available=not_available,
        history=history, statements=statements,
    )


# ── GDACS events ─────────────────────────────────────────────────────


def gdacs_event_id(raw: dict[str, Any]) -> str:
    return f"gdacs-{raw.get('event_id')}-{raw.get('episode_id') or 0}"


def build_gdacs_event(raw: dict[str, Any], assets: dict[str, Any] | None = None) -> EventSummary:
    level = str(raw.get("alert_level") or "green").lower()
    centroid = raw.get("centroid") or {}
    country = raw.get("country") or "Unknown location"
    current = bool(raw.get("is_current"))
    return EventSummary(
        id=gdacs_event_id(raw),
        kind="reported",
        title=raw.get("name") or f"Flood in {country}",
        location_name=country,
        center={"lat": float(centroid.get("lat", 0.0)), "lng": float(centroid.get("lng", 0.0))},
        bbox=None,
        detected_at=str(raw.get("from_date") or ""),
        updated_at=str(raw.get("date_modified") or raw.get("to_date") or raw.get("from_date") or ""),
        ended_at=None if current else (raw.get("to_date") or None),
        status="active" if current else "past",
        source=EventSource(provider="GDACS", kind="external_feed", url=raw.get("report_url")),
        data_status="live",
        severity=GDACS_SEVERITY.get(level, "low"),
        confidence=Confidence(
            kind="not_provided",
            explanation="GDACS publishes an alert level, not a confidence value."),
        affected_area_km2=Measure.unavailable(
            "GDACS reports a location and alert level, not a measured flood extent.", "km²"),
        population_exposed=Measure.unavailable(POPULATION_UNAVAILABLE, "people"),
        assets_exposed=_assets_measure(assets),
        headline=f"GDACS {level.capitalize()} alert" + (", ongoing" if current else ", ended"),
    )


def build_gdacs_detail(raw: dict[str, Any], assets: dict[str, Any] | None = None) -> EventDetail:
    event = build_gdacs_event(raw, assets)
    level = str(raw.get("alert_level") or "green").capitalize()
    score = raw.get("alert_score")
    hazard = RiskComponent(
        name="hazard", status="available",
        score=min(1.0, float(score) / 3.0) if score is not None else None,
        label=event.severity.upper(),
        basis=f"GDACS alert level {level}"
              + (f" (alert score {score} of 3)." if score is not None else "."),
    )
    exposure = RiskComponent(
        name="exposure",
        status="partial" if assets and assets.get("status") == "available" else "not_assessed",
        label="PARTIAL" if assets and assets.get("status") == "available" else "NOT ASSESSED",
        basis=(f"{assets['total']} critical facilities within about 25 km of the reported "
               "location (OpenStreetMap). Population is unavailable."
               if assets and assets.get("status") == "available"
               else "Facilities not queried yet. " + POPULATION_UNAVAILABLE),
        details=([{"label": k.replace("_", " ").capitalize(), "value": v, "unit": ""}
                  for k, v in sorted(assets["counts"].items(), key=lambda kv: -kv[1])]
                 if assets and assets.get("status") == "available" else []),
    )
    vulnerability = RiskComponent(name="vulnerability", status="unavailable",
                                  label="UNAVAILABLE", basis=VULNERABILITY_UNAVAILABLE)
    risk = RiskAssessment(
        level=event.severity, complete=False, basis="external alert level only",
        explanation=(f"Rated {event.severity.upper()} because GDACS issued a {level} alert. "
                     "Prithvi Drishti has not independently assessed this event."),
        components=[hazard, exposure, vulnerability],
    )
    evidence = [EvidenceItem(
        role="Event report", kind="external_report", source="GDACS (EC JRC / UN OCHA)",
        timestamp=event.updated_at,
        detail=(f"Alert level {level}. Upstream source: {raw.get('upstream_source') or 'not stated'}."
                + (f" GLIDE {raw['glide']}." if raw.get("glide") else "")),
        url=raw.get("report_url"),
    )]
    if assets and assets.get("status") == "available":
        evidence.append(EvidenceItem(
            role="Infrastructure", kind="dataset", timestamp=assets.get("fetched_at"),
            source="OpenStreetMap (Overpass API)",
            detail=f"{assets['total']} critical facilities near the reported location.",
            url="https://www.openstreetmap.org/copyright",
        ))
    period = f"from {event.detected_at[:10]}" + (
        f" to {event.ended_at[:10]}" if event.ended_at else ", ongoing")
    return EventDetail(
        event=event,
        what_happened=(f"GDACS reported a flood in {event.location_name} {period}, "
                       f"with a {level} alert level. Prithvi Drishti relays this report; it has "
                       "not detected or measured the flood itself."),
        why_it_matters=("GDACS alert levels reflect expected humanitarian impact. "
                        "See the GDACS report for affected-population estimates."),
        risk=risk, uncertainty=[], evidence=evidence,
        not_available=[
            {"item": "Flood extent", "reason": "GDACS provides a location, not a measured extent."},
            {"item": "Population exposure", "reason": POPULATION_UNAVAILABLE},
            {"item": "Vulnerability", "reason": VULNERABILITY_UNAVAILABLE},
        ],
        history=[],
    )


# ── collection helpers ───────────────────────────────────────────────


def group_forecasts(forecasts: list[Any]) -> dict[str, list[dict[str, Any]]]:
    """Group raw forecasts by area (watershed id), each oldest → newest."""
    groups: dict[str, list[dict[str, Any]]] = {}
    for f in forecasts:
        d = _dump(f)
        groups.setdefault(str(d.get("watershed_id", "")), []).append(d)
    for items in groups.values():
        items.sort(key=lambda d: _iso(d.get("generated_at")))
    return groups


def sort_events(events: list[EventSummary]) -> list[EventSummary]:
    """Forecast/active first, then most severe, then most recent."""
    rank = {"forecast": 0, "active": 0, "past": 1}
    ordered = sorted(events, key=lambda e: e.updated_at, reverse=True)
    ordered.sort(key=lambda e: SEVERITY_ORDER[e.severity], reverse=True)
    ordered.sort(key=lambda e: rank[e.status])
    return ordered


def _count_by_type(events: list[EventSummary]) -> dict[str, int]:
    out: dict[str, int] = {}
    for e in events:
        out[e.type] = out.get(e.type, 0) + 1
    return out


def _largest(events: list[EventSummary], pick: Any, empty_reason: str, unit: str) -> dict[str, Any]:
    """The largest single measured value among ``events``, labelled with its event."""
    if not events:
        return Measure.not_assessed(empty_reason, unit).model_dump()
    top = max(events, key=lambda e: pick(e).value or 0)
    measure = pick(top).model_copy(update={"source": f"Largest single event: {top.title}"})
    return measure.model_dump()


def summarize(events: list[EventSummary]) -> dict[str, Any]:
    """Dashboard KPIs — counts only; sums of unavailable measures stay unavailable."""
    current = [e for e in events if e.status != "past"]
    by_severity = {s: 0 for s in SEVERITY_ORDER}
    for e in current:
        by_severity[e.severity] += 1
    assets = [e.assets_exposed.value for e in current
              if e.assets_exposed.status == "available" and e.assets_exposed.value is not None]
    measured = [e for e in current if e.kind == "detected"]
    return {
        "active_events": len(current),
        "high_risk_events": by_severity["high"] + by_severity["critical"],
        "by_severity": by_severity,
        "past_events": len(events) - len(current),
        "live_events": sum(1 for e in events if e.data_status == "live"),
        "demo_events": sum(1 for e in events if e.data_status == "demo"),
        "by_type": _count_by_type(current),
        # Not summed across events: analyses can overlap and measure different
        # things. The KPIs show the single largest measured value and name it.
        "population_exposed": _largest(
            [e for e in measured if e.population_exposed.status == "available"],
            lambda e: e.population_exposed,
            "No current satellite detection with population exposure. Run a flood or "
            "surface-water analysis.", "people"),
        "affected_area_km2": _largest(
            [e for e in measured if e.type in ("flood", "water_change")
             and e.affected_area_km2.status == "available"],
            lambda e: e.affected_area_km2,
            "No current satellite flood or water detection. Run an analysis to measure an extent.",
            "km²"),
        "detections": len(measured),
        "critical_assets": (
            Measure(status="available", value=float(sum(assets)), unit="facilities",
                    source="OpenStreetMap (Overpass)").model_dump()
            if assets else
            Measure.not_assessed("Open an event to query its facilities.", "facilities").model_dump()
        ),
    }
