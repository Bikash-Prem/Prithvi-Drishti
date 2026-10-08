"""
System overview — one cheap, read-only summary of the running platform.

Feeds the landing page's live status strip. Unlike ``/health`` this makes NO
network calls (connector reachability is not probed), so it is safe to poll.
Degrades honestly: before the lifespan has run it returns empty collections
and ``ready: false`` — never a 500 and never invented numbers.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter

from prithvidrishti.models.enums import FloodPhase

router = APIRouter()


def _state() -> dict[str, Any]:
    from prithvidrishti.api.app import _app_state

    return _app_state


def _first_doc_line(obj: Any) -> str:
    doc = (type(obj).__doc__ or "").strip()
    return doc.splitlines()[0].strip() if doc else ""


@router.get("/system/overview")
async def system_overview() -> dict[str, Any]:
    """Agents, topology, phase, LLM mode and event counters in one payload."""
    app_state = _state()
    agents = app_state.get("agents", [])
    bus = app_state.get("event_bus")
    llm = app_state.get("llm_client")
    connectors = app_state.get("connectors", {})
    flood_state = app_state.get("flood_state") or {}

    subscriptions = bus.get_subscriptions() if bus is not None else {}
    metrics = bus.get_metrics() if bus is not None else {}

    phases = [p.value for p in FloodPhase]
    current_phase = str(flood_state.get("current_phase", FloodPhase.MONITORING))

    return {
        "ready": bool(agents),
        "generated_at": datetime.utcnow().isoformat(),
        "phase": {
            "current": current_phase,
            "index": phases.index(current_phase) if current_phase in phases else 0,
            "all": phases,
        },
        "agents": [
            {
                "agent_id": a.agent_id,
                "name": type(a).__name__,
                "role": _first_doc_line(a),
                "trigger_types": sorted(t.value for t in a.trigger_types),
                "consumes": subscriptions.get(a.agent_id, []),
            }
            for a in agents
        ],
        "llm": {
            "available": bool(llm and llm.available()),
            "fleet": ([getattr(p, "name", "?") for p in llm.provider_pool()]
                      if llm and hasattr(llm, "provider_pool") else []),
        },
        "connectors": {
            name: {"is_mock": bool(getattr(conn, "is_mock", True))}
            for name, conn in connectors.items()
        },
        "events": {
            "total_emits": metrics.get("total_emits", 0),
            "handler_errors": metrics.get("handler_errors", 0),
            "by_channel": metrics.get("emit_counts", {}),
        },
        "counts": {
            "active_alerts": len(flood_state.get("active_alerts", [])),
            "flood_forecasts": len(flood_state.get("flood_forecasts", [])),
            "compound_threats": len(flood_state.get("compound_threats", [])),
            "alert_dispatches": len(flood_state.get("alert_dispatches", [])),
        },
    }
