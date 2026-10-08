"""
Event-centric API for the dashboard: events, evidence, assets, search,
analysis jobs, system status and the grounded assistant.

Routes stay thin — the logic lives in ``prithvidrishti.services``. Every payload
carries its own provenance (``data_status``, sources, timestamps) and reports
what is unavailable instead of filling gaps.
"""

from __future__ import annotations

import asyncio
import math
import re
import time
from datetime import UTC, date, datetime
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel, Field

from prithvidrishti.eo import pipeline as eo_pipeline
from prithvidrishti.eo import postgis_store
from prithvidrishti.eo.detectors import list_models
from prithvidrishti.eo.repository import DetectionRepository
from prithvidrishti.services import assets as assets_service
from prithvidrishti.services import assistant as assistant_service
from prithvidrishti.services import detection_events as det_ev
from prithvidrishti.services import events as ev
from prithvidrishti.services import graph as graph_service
from prithvidrishti.services.analysis import ANALYSIS_TYPES, MAX_RUNNING, AnalysisManager, validate_bbox
from prithvidrishti.services.report import build_report

router = APIRouter()

GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"
FEED_TIMEOUT_S = 10.0
FEED_NEGATIVE_TTL_S = 60.0
HEALTH_TTL_S = 60.0
_COORDS = re.compile(r"^\s*(-?\d{1,2}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)\s*$")

_feed_cache: dict[str, Any] = {"at": 0.0, "events": None, "error": None}
_health_cache: dict[str, Any] = {"at": 0.0, "groups": None}


def _state() -> dict[str, Any]:
    from prithvidrishti.api.app import _app_state

    return _app_state


def _now() -> str:
    return datetime.now(UTC).isoformat()


# ── data assembly ────────────────────────────────────────────────────


def _forecast_groups() -> dict[str, list[dict[str, Any]]]:
    app_state = _state()
    flood_state = app_state.get("flood_state") or {}
    forecasts = list(flood_state.get("flood_forecasts", [])) + list(
        app_state.get("analysis_forecasts", []))
    return ev.group_forecasts(forecasts)


def _repo() -> DetectionRepository:
    app_state = _state()
    repo = app_state.get("eo_repo")
    if repo is None:
        repo = DetectionRepository()
        repo.init()
        app_state["eo_repo"] = repo
    return repo


def _detections() -> dict[str, dict[str, Any]]:
    """Stored satellite detections by id (loaded from disk once per process)."""
    app_state = _state()
    store = app_state.get("detections")
    if store is None:
        store = {r["id"]: r for r in _repo().load_all()}
        app_state["detections"] = store
    return store


def _tag_for(forecasts: list[dict[str, Any]]) -> dict[str, Any]:
    tags = _state().get("event_tags", {})
    return tags.get(str(forecasts[-1].get("event_id", "")), {})


async def _gdacs_events() -> tuple[list[dict[str, Any]], str | None]:
    """Raw GDACS events + an error string when the feed is unavailable."""
    now = time.time()
    if _feed_cache["events"] is not None and now - _feed_cache["at"] < 900:
        return _feed_cache["events"], None
    if _feed_cache["error"] and now - _feed_cache["at"] < FEED_NEGATIVE_TTL_S:
        return [], _feed_cache["error"]
    gdacs = _state().get("connectors", {}).get("gdacs")
    if gdacs is None:
        return [], "GDACS connector is not running."
    try:
        events = await asyncio.wait_for(gdacs.get_flood_events(), timeout=FEED_TIMEOUT_S)
    except TimeoutError:
        events = None
    _feed_cache["at"] = now
    if events is None:
        _feed_cache["events"], _feed_cache["error"] = None, "GDACS did not respond."
        return [], _feed_cache["error"]
    _feed_cache["events"], _feed_cache["error"] = events, None
    return events, None


async def _all_events() -> tuple[list[ev.EventSummary], list[dict[str, Any]]]:
    events: list[ev.EventSummary] = []
    groups = _forecast_groups()
    for forecasts in groups.values():
        tag = _tag_for(forecasts)
        draft = ev.build_forecast_event(forecasts, tag)
        events.append(ev.build_forecast_event(forecasts, tag, assets_service.cached(draft.id)))
    detections = _detections()
    for record in detections.values():
        events.append(det_ev.build_detection_event(record))
    raw_gdacs, gdacs_error = await _gdacs_events()
    for raw in raw_gdacs:
        if not raw.get("centroid"):
            continue
        events.append(ev.build_gdacs_event(raw, assets_service.cached(ev.gdacs_event_id(raw))))
    sources = [
        {"name": "Satellite analyses", "status": "ok", "count": len(detections), "reason": None},
        {"name": "Prithvi Drishti forecast agent", "status": "ok", "count": len(groups), "reason": None},
        {"name": "GDACS global flood alerts",
         "status": "unavailable" if gdacs_error else "ok",
         "count": 0 if gdacs_error else len(raw_gdacs), "reason": gdacs_error},
    ]
    return ev.sort_events(events), sources


async def _detail(event_id: str, assets: dict[str, Any] | None = None) -> ev.EventDetail | None:
    record = _detections().get(event_id)
    if record is not None:
        return det_ev.build_detection_detail(record)
    assets = assets if assets is not None else assets_service.cached(event_id)
    for forecasts in _forecast_groups().values():
        tag = _tag_for(forecasts)
        if ev.build_forecast_event(forecasts, tag).id == event_id:
            return ev.build_forecast_detail(forecasts, tag, assets)
    raw_gdacs, _ = await _gdacs_events()
    for raw in raw_gdacs:
        if ev.gdacs_event_id(raw) == event_id and raw.get("centroid"):
            return ev.build_gdacs_detail(raw, assets)
    return None


def _event_bbox(event: ev.EventSummary) -> dict[str, float]:
    return event.bbox or assets_service.bbox_around(event.center["lat"], event.center["lng"])


# ── events ───────────────────────────────────────────────────────────


@router.get("/events")
async def list_events(
    type: str | None = Query(None, description="Event type, e.g. flood"),
    status: str | None = Query(None, pattern="^(forecast|active|past|current)$"),
    min_severity: str | None = Query(None, pattern="^(low|medium|high|critical)$"),
    since: str | None = Query(None, description="ISO date/time; events updated on or after"),
    until: str | None = Query(None, description="ISO date/time; events detected on or before"),
    limit: int = Query(100, ge=1, le=200),
    offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    events, sources = await _all_events()
    summary = ev.summarize(events)
    items = events
    if type:
        items = [e for e in items if e.type == type]
    if status == "current":
        items = [e for e in items if e.status != "past"]
    elif status:
        items = [e for e in items if e.status == status]
    if min_severity:
        floor = ev.SEVERITY_ORDER[min_severity]
        items = [e for e in items if ev.SEVERITY_ORDER[e.severity] >= floor]
    if since:
        items = [e for e in items if (e.ended_at or e.updated_at) >= since]
    if until:
        items = [e for e in items if e.detected_at <= until]
    return {
        "items": [e.model_dump() for e in items[offset:offset + limit]],
        "total": len(items),
        "limit": limit,
        "offset": offset,
        "summary": summary,
        "sources": sources,
        "generated_at": _now(),
    }


@router.get("/events/{event_id}")
async def get_event(event_id: str) -> dict[str, Any]:
    detail = await _detail(event_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="Event not found.")
    return detail.model_dump()


@router.get("/events/{event_id}/assets")
async def get_event_assets(event_id: str) -> dict[str, Any]:
    """Critical facilities for the event's area (OpenStreetMap, cached 24 h)."""
    record = _detections().get(event_id)
    if record is not None:
        inside = record.get("assets_in_extent")
        if inside is None:
            return {"status": "unavailable", "total": 0, "counts": {}, "scope": "extent",
                    "reason": "Nothing was detected, so there is no extent to check.",
                    "geojson": {"type": "FeatureCollection", "features": []}}
        return {**inside, "scope": "extent"}
    detail = await _detail(event_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="Event not found.")
    client = None
    osm = _state().get("connectors", {}).get("osm")
    if osm is not None:
        client = await osm._get_client()
    return await assets_service.fetch_assets(event_id, _event_bbox(detail.event), client=client)


@router.get("/events/{event_id}/geometry")
async def get_event_geometry(event_id: str) -> dict[str, Any]:
    """Detected extent polygons + image overlays for a satellite detection."""
    record = _detections().get(event_id)
    if record is None:
        if await _detail(event_id) is None:
            raise HTTPException(status_code=404, detail="Event not found.")
        return {"available": False, "reason": "This event has no detected extent.",
                "extent": None, "secondary": {}, "overlays": [], "overlay_coordinates": None}
    b = record["bbox"]
    return {
        "available": True,
        "extent": record["geometry"],
        "secondary": record["secondary"],
        "overlays": [{**o, "url": f"/api/v1/eo/{record['id']}/{o['file']}"} for o in record["overlays"]],
        # MapLibre image-source order: top-left, top-right, bottom-right, bottom-left.
        "overlay_coordinates": [[b["west"], b["north"]], [b["east"], b["north"]],
                                [b["east"], b["south"]], [b["west"], b["south"]]],
        "bbox": b,
    }


@router.get("/events/{event_id}/graph")
async def get_event_graph(event_id: str) -> dict[str, Any]:
    """Knowledge graph of a satellite detection: its place, risk, evidence and context."""
    record = _detections().get(event_id)
    if record is None:
        if await _detail(event_id) is None:
            raise HTTPException(status_code=404, detail="Event not found.")
        return {"available": False, "reason": "Only satellite detections have a knowledge graph.",
                "nodes": [], "relationships": []}
    return {"available": True, **graph_service.build_graph(record),
            "stores": {**graph_service.store_status(), **postgis_store.status()}}


@router.get("/eo/{record_id}/{filename}")
async def get_overlay_image(record_id: str, filename: str) -> FileResponse:
    path = _repo().image_path(record_id, filename)
    if path is None:
        raise HTTPException(status_code=404, detail="Image not found.")
    return FileResponse(path, media_type="image/png",
                        headers={"Cache-Control": "public, max-age=86400, immutable"})


@router.get("/events/{event_id}/report", response_class=HTMLResponse)
async def get_event_report(event_id: str) -> HTMLResponse:
    """Printable report built from the stored event record."""
    detail = await _detail(event_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="Event not found.")
    return HTMLResponse(build_report(detail))


@router.get("/models")
async def get_models() -> dict[str, Any]:
    """Registered detection models with versions, parameters and limitations."""
    return {"items": list_models(), "analyses": [
        {"type": "flood_forecast", "label": "Flood forecast", "sensor": None,
         "needs_dates": False, "max_span_deg": 2.0},
        *({"type": k, "label": v["label"], "sensor": v["sensor"], "needs_dates": True,
           "default_gap_days": v["default_gap_days"], "detector": v["detector"],
           "max_span_deg": eo_pipeline.MAX_AOI_SPAN_DEG} for k, v in eo_pipeline.ANALYSES.items()),
    ]}


@router.get("/monitoring/summary")
async def monitoring_summary() -> dict[str, Any]:
    """Satellite detections with their headline measurements, newest first."""
    items = []
    for record in sorted(_detections().values(), key=lambda r: r["created_at"], reverse=True):
        event = det_ev.build_detection_event(record)
        items.append({
            "event": event.model_dump(),
            "kind": record["kind"], "label": record["label"], "detected": record["detected"],
            "before": record["before"]["acquired"], "after": record["after"]["acquired"],
            "metrics": det_ev._metric_rows(record, record["metrics"]),
            "quality_flags": record["quality_flags"],
        })
    return {"items": items, "generated_at": _now()}



# ── search ───────────────────────────────────────────────────────────


@router.get("/search")
async def search(q: str = Query(..., min_length=2, max_length=120)) -> dict[str, Any]:
    """Places (Open-Meteo/GeoNames), coordinates, and events matching ``q``."""
    results: list[dict[str, Any]] = []
    m = _COORDS.match(q)
    if m:
        lat, lng = float(m.group(1)), float(m.group(2))
        if -90 <= lat <= 90 and -180 <= lng <= 180:
            results.append({"kind": "coordinates", "title": f"{lat:.4f}, {lng:.4f}",
                            "subtitle": "Coordinates", "lat": lat, "lng": lng})

    events, _ = await _all_events()
    needle = q.lower()
    for e in events:
        if needle in e.title.lower() or needle in e.location_name.lower():
            results.append({"kind": "event", "title": e.title, "subtitle": e.headline,
                            "lat": e.center["lat"], "lng": e.center["lng"],
                            "event_id": e.id, "severity": e.severity})

    place_error = None
    if not m:
        try:
            async with httpx.AsyncClient(timeout=6.0) as client:
                resp = await client.get(GEOCODE_URL, params={
                    "name": q, "count": 6, "language": "en", "format": "json"})
                resp.raise_for_status()
                hits = resp.json().get("results") or []
        except Exception:
            hits, place_error = [], "Place search is temporarily unavailable."
        for hit in hits:
            nearby = sum(1 for e in events
                         if abs(e.center["lat"] - hit["latitude"]) < 1.0
                         and abs(e.center["lng"] - hit["longitude"]) < 1.0
                         and e.status != "past")
            results.append({
                "kind": "place",
                "title": hit.get("name", ""),
                "subtitle": ", ".join(x for x in (hit.get("admin1"), hit.get("country")) if x),
                "lat": hit["latitude"], "lng": hit["longitude"],
                "population": hit.get("population"),
                "feature": hit.get("feature_code"),
                "active_events_nearby": nearby,
            })
    return {"query": q, "results": results[:12], "place_error": place_error}


# ── analysis jobs ────────────────────────────────────────────────────


class AnalysisRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    bbox: dict[str, float]
    type: str = Field("flood_forecast", description="flood_forecast | sar_flood | water_change | vegetation_change | forest_loss")
    before: date | None = Field(None, description="Reference date (satellite analyses)")
    after: date | None = Field(None, description="Event date (satellite analyses)")


def _record_analysis_forecast(forecast: dict[str, Any], tag: dict[str, Any]) -> None:
    app_state = _state()
    store = app_state.setdefault("analysis_forecasts", [])
    store.append(forecast)
    del store[:-40]
    app_state.setdefault("event_tags", {})[str(forecast.get("event_id"))] = tag


async def _record_detection(record: dict[str, Any]) -> None:
    _detections()[record["id"]] = record
    await asyncio.to_thread(_repo().save, record)
    # Optional mirrors (off unless configured); neither can fail the analysis.
    await asyncio.to_thread(postgis_store.mirror, record)
    await asyncio.to_thread(graph_service.mirror, record)


async def _broadcast_job(job: dict[str, Any]) -> None:
    from prithvidrishti.api.websocket import broadcast

    await broadcast({"type": "analysis_progress", "data": job})


def _manager() -> AnalysisManager:
    app_state = _state()
    manager = app_state.get("analysis_manager")
    if manager is None:
        predict = next((a for a in app_state.get("agents", [])
                        if getattr(a, "agent_id", "") == "flood_predict_agent"), None)
        manager = AnalysisManager(predict, on_progress=_broadcast_job,
                                  on_forecast=_record_analysis_forecast,
                                  on_detection=_record_detection, eo_dir=_repo().data_dir)
        app_state["analysis_manager"] = manager
    return manager


@router.post("/analysis", status_code=202)
async def start_analysis(req: AnalysisRequest) -> dict[str, Any]:
    problem = validate_bbox(req.bbox)
    if problem:
        raise HTTPException(status_code=422, detail=problem)
    if req.type not in ANALYSIS_TYPES:
        raise HTTPException(status_code=422, detail="Unknown analysis type.")
    before, after = req.before, req.after
    if req.type != "flood_forecast":
        if before is None or after is None:
            default_before, default_after = eo_pipeline.default_dates(req.type)
            before, after = before or default_before, after or default_after
        problem = eo_pipeline.validate_request(req.type, req.bbox, before, after)
        if problem:
            raise HTTPException(status_code=422, detail=problem)
    manager = _manager()
    if manager.running_count() >= MAX_RUNNING:
        raise HTTPException(status_code=429,
                            detail="Too many analyses are running. Wait for one to finish.")
    bbox = {k: round(float(req.bbox[k]), 5) for k in ("south", "north", "west", "east")}
    return manager.create(bbox, req.name.strip(), req.type, before, after)


# ── ForestGuard: analyse a named place ───────────────────────────────


class ForestAnalyzeRequest(BaseModel):
    location: str = Field(..., min_length=2, max_length=120,
                          description="Place name, or 'lat, lng'")
    radius_meters: int = Field(10_000, ge=1_000, le=30_000)
    before: date | None = Field(None, description="Reference date (default: one year before)")
    after: date | None = Field(None, description="Event date (default: latest imagery)")


def radius_bbox(lat: float, lng: float, radius_m: float) -> dict[str, float]:
    """Square of half-side ``radius_m`` around a point, in degrees."""
    dlat = radius_m / 111_320.0
    dlng = radius_m / (111_320.0 * max(0.05, math.cos(math.radians(lat))))
    return {"south": round(lat - dlat, 5), "north": round(lat + dlat, 5),
            "west": round(lng - dlng, 5), "east": round(lng + dlng, 5)}


async def _resolve_place(query: str) -> dict[str, Any]:
    m = _COORDS.match(query)
    if m:
        lat, lng = float(m.group(1)), float(m.group(2))
        if not (-90 <= lat <= 90 and -180 <= lng <= 180):
            raise HTTPException(status_code=422, detail="Those coordinates are out of range.")
        return {"name": f"{lat:.4f}, {lng:.4f}", "latitude": lat, "longitude": lng,
                "source": "coordinates"}
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            resp = await client.get(GEOCODE_URL, params={
                "name": query, "count": 1, "language": "en", "format": "json"})
            resp.raise_for_status()
            hits = resp.json().get("results") or []
    except Exception as exc:
        raise HTTPException(status_code=503,
                            detail="Place search is temporarily unavailable. "
                                   "Try coordinates instead (lat, lng).") from exc
    if not hits:
        raise HTTPException(status_code=404, detail=f"Location not found: {query}")
    hit = hits[0]
    name = ", ".join(x for x in (hit.get("name"), hit.get("admin1"), hit.get("country")) if x)
    return {"name": name, "latitude": hit["latitude"], "longitude": hit["longitude"],
            "source": "Open-Meteo geocoding (GeoNames)"}


@router.post("/forest/analyze", status_code=202)
async def forest_analyze(req: ForestAnalyzeRequest) -> dict[str, Any]:
    """ForestGuard: potential forest loss around a named place.

    Resolves the place, builds the area from the radius and starts a
    ``forest_loss`` analysis job — poll ``GET /analysis/{job_id}`` for progress.
    """
    place = await _resolve_place(req.location.strip())
    bbox = radius_bbox(place["latitude"], place["longitude"], req.radius_meters)
    default_before, default_after = eo_pipeline.default_dates("forest_loss")
    before, after = req.before or default_before, req.after or default_after
    problem = validate_bbox(bbox) or eo_pipeline.validate_request("forest_loss", bbox, before, after)
    if problem:
        raise HTTPException(status_code=422, detail=problem)
    manager = _manager()
    if manager.running_count() >= MAX_RUNNING:
        raise HTTPException(status_code=429,
                            detail="Too many analyses are running. Wait for one to finish.")
    job = manager.create(bbox, place["name"][:80], "forest_loss", before, after)
    job["resolved_location"] = {**place, "radius_km": req.radius_meters / 1000}
    return job


@router.get("/analysis")
async def list_analyses() -> dict[str, Any]:
    return {"items": _manager().list()}


@router.get("/analysis/{job_id}")
async def get_analysis(job_id: str) -> dict[str, Any]:
    job = _manager().get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Analysis job not found.")
    return job


# ── system status ────────────────────────────────────────────────────

_STATE_LABEL = {"operational": "Operational", "degraded": "Degraded",
                "unavailable": "Unavailable", "not_configured": "Not configured",
                "not_implemented": "Not built yet"}


def _group(name: str, state: str, detail: str) -> dict[str, Any]:
    return {"name": name, "state": state, "state_label": _STATE_LABEL[state], "detail": detail}


async def _status_groups() -> list[dict[str, Any]]:
    now = time.time()
    if _health_cache["groups"] is not None and now - _health_cache["at"] < HEALTH_TTL_S:
        return _health_cache["groups"]
    app_state = _state()
    connectors = app_state.get("connectors", {})

    async def check(name: str) -> bool | None:
        conn = connectors.get(name)
        if conn is None:
            return None
        try:
            return bool(await asyncio.wait_for(conn.health_check(), timeout=6.0))
        except Exception:
            return False

    names = ("openmeteo", "osm", "gdacs", "reliefweb", "googleflood")
    ok = dict(zip(names, await asyncio.gather(*(check(n) for n in names)), strict=True))

    def conn_group(label: str, key: str, what: str) -> dict[str, Any]:
        if ok[key] is None:
            return _group(label, "unavailable", "Backend is still starting.")
        return _group(label, "operational" if ok[key] else "unavailable",
                      what if ok[key] else f"{what} — not reachable right now.")

    llm = app_state.get("llm_client")
    llm_on = bool(llm and llm.available())
    store = app_state.get("store")
    google = connectors.get("googleflood")
    google_keyed = bool(getattr(google, "api_key", None) or getattr(google, "_api_key", None))

    groups = [
        conn_group("Weather and river discharge", "openmeteo", "Open-Meteo forecast and GloFAS record"),
        conn_group("Infrastructure data", "osm", "OpenStreetMap via Overpass"),
        conn_group("Global flood alerts", "gdacs", "GDACS event feed"),
        _group("Forecast agents",
               "operational" if len(app_state.get("agents", [])) == 8 else "degraded",
               f"{len(app_state.get('agents', []))} of 8 agents running"),
        _group("AI narrative", "operational" if llm_on else "not_configured",
               "Language model connected" if llm_on
               else "No language model key — explanations use deterministic rules"),
        _group("Google Flood Forecasting",
               ("operational" if ok["googleflood"] else "unavailable") if google_keyed
               else "not_configured",
               "Connected" if google_keyed and ok["googleflood"]
               else "API key not set" if not google_keyed else "Not reachable right now"),
        _group("Satellite analysis", "operational",
               "On demand: Sentinel-1 radar and Sentinel-2 optical (baseline detectors, not yet "
               "evaluated against labelled data)"),
        _group("Population data", "operational",
               "On demand: Meta HRSL 30 m, with WorldPop 2020 as a second estimate"),
        _group("Vulnerability data", "not_implemented",
               "No vulnerability dataset; risk combines hazard and exposure only"),
        _group("Spatial database / knowledge graph", "not_implemented",
               "PostGIS and Neo4j are not deployed; detections are stored in SQLite"),
        _group("Storage", "operational" if store is not None and getattr(store, "enabled", False)
               else "degraded",
               "SQLite (single node)" if store is not None and getattr(store, "enabled", False)
               else "Persistence disabled — state is lost on restart"),
    ]
    _health_cache["groups"], _health_cache["at"] = groups, now
    return groups


@router.get("/system/status")
async def system_status() -> dict[str, Any]:
    groups = await _status_groups()
    core = [g for g in groups if g["state"] in ("unavailable", "degraded")]
    overall = "operational" if not core else "degraded"
    return {"overall": overall, "overall_label": _STATE_LABEL[overall],
            "groups": groups, "checked_at": _now()}


# ── assistant ────────────────────────────────────────────────────────


class AssistantRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=assistant_service.MAX_MESSAGE_CHARS)
    selected_event_id: str | None = None


@router.post("/assistant")
async def assistant(req: AssistantRequest) -> dict[str, Any]:
    events, _ = await _all_events()
    selected = req.selected_event_id if any(
        e.id == req.selected_event_id for e in events) else None
    intent = assistant_service.classify(req.message, has_selection=selected is not None)

    if intent == "override_attempt":
        answer, actions = assistant_service.override_refusal()
    elif intent == "explain_event":
        target = selected or next((e.id for e in events if e.status != "past"), None)
        detail = await _detail(target) if target else None
        if detail is None:
            answer, actions = assistant_service.overview(events)
        else:
            answer, actions = assistant_service.explain_event(detail)
    elif intent == "rank_events":
        answer, actions = assistant_service.rank_events(events, req.message)
    elif intent == "system_status":
        answer, actions = assistant_service.system_status(await _status_groups())
    elif intent == "go_to_place":
        place = assistant_service.place_query(req.message) or ""
        found = await search(q=place) if len(place) >= 2 else {"results": []}
        hit = next((r for r in found["results"] if r["kind"] in ("place", "coordinates", "event")), None)
        if hit is None:
            answer = assistant_service._answer(
                "Place not found", f"I couldn't find “{place}”. Try a city or coordinates.")
            actions = []
        elif hit["kind"] == "event" and (detail := await _detail(hit["event_id"])) is not None:
            answer, actions = assistant_service.explain_event(detail)
        else:
            box = assets_service.bbox_around(hit["lat"], hit["lng"], 0.2)
            answer = assistant_service._answer(
                hit["title"], f"Showing {hit['title']}" + (f", {hit['subtitle']}" if hit.get("subtitle") else "")
                + f". {hit.get('active_events_nearby', 0)} current event(s) within about 100 km.")
            actions = [{"type": "fit_bounds", "bbox": box}]
    else:
        answer, actions = assistant_service.overview(events)

    return {"intent": intent, "answer": answer, "actions": actions,
            "grounding": "deterministic", "generated_at": _now()}
