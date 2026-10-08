"""
Area analysis jobs.

Five analyses share one job model (id, state, per-step status, result event):

  flood_forecast      rainfall-driven forecast (forecast agent) + facilities
  sar_flood           Sentinel-1 radar flood detection
  water_change        Sentinel-2 surface-water change
  vegetation_change   Sentinel-2 vegetation change
  forest_loss         ForestGuard: vegetation loss on tree cover + Hansen / FIRMS evidence

Jobs run off the request path; raster work runs in a worker thread and
reports progress back onto the event loop. A step whose input is missing is
reported ``unavailable`` with the reason; a job whose *required* input is
missing fails with that reason. Nothing is substituted.

Dev limitation: job records live in process memory (detections themselves are
persisted by ``eo.repository``).
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

from prithvidrishti.eo import EOUnavailable
from prithvidrishti.eo import pipeline as eo_pipeline
from prithvidrishti.services import assets as assets_service
from prithvidrishti.services import events as events_service

logger = logging.getLogger("prithvidrishti.services.analysis")

MAX_JOBS_KEPT = 50
MAX_RUNNING = 3
MAX_SPAN_DEG = 2.0

FORECAST_STEPS: tuple[tuple[str, str], ...] = (
    ("aoi", "Area selected"),
    ("forecast", "Rainfall forcing and flood forecast"),
    ("infrastructure", "Critical infrastructure in the area"),
    ("risk", "Risk assessment"),
)
EO_STEPS: tuple[tuple[str, str], ...] = (
    ("aoi", "Area selected"),
    ("discovery", "Satellite image discovery"),
    ("preprocess", "Read and align rasters"),
    ("detection", "Change detection"),
    ("vectorize", "Extent polygons"),
    ("population", "Population inside the extent"),
    ("infrastructure", "Critical facilities inside the extent"),
    ("risk", "Risk assessment"),
)
FOREST_STEPS: tuple[tuple[str, str], ...] = (
    *EO_STEPS[:5], ("context", "Independent forest evidence"), *EO_STEPS[5:])
ANALYSIS_TYPES = ("flood_forecast", *eo_pipeline.ANALYSES)


def steps_for(kind: str) -> tuple[tuple[str, str], ...]:
    if kind == "flood_forecast":
        return FORECAST_STEPS
    return FOREST_STEPS if kind == "forest_loss" else EO_STEPS

ProgressHook = Callable[[dict[str, Any]], Awaitable[None]]


def _now() -> str:
    return datetime.now(UTC).isoformat()


def validate_bbox(bbox: dict[str, float]) -> str | None:
    """Return a user-facing problem with the bbox, or None when it is usable."""
    try:
        s, n, w, e = (float(bbox[k]) for k in ("south", "north", "west", "east"))
    except (KeyError, TypeError, ValueError):
        return "The area must have south, north, west and east coordinates."
    if not (-90 <= s < n <= 90) or not (-180 <= w < e <= 180):
        return "The area's coordinates are out of range or inverted."
    if n - s > MAX_SPAN_DEG or e - w > MAX_SPAN_DEG:
        return f"The area is too large. Keep it under {MAX_SPAN_DEG:g}° on each side."
    return None


class AnalysisManager:
    """Owns job records and runs the analysis pipelines."""

    def __init__(self, predict_agent: Any, on_progress: ProgressHook | None = None,
                 on_forecast: Callable[[dict[str, Any], dict[str, Any]], None] | None = None,
                 on_detection: Callable[[dict[str, Any]], Awaitable[None]] | None = None,
                 fetch_assets: Callable[..., Awaitable[dict[str, Any]]] = assets_service.fetch_assets,
                 eo_runner: Callable[..., dict[str, Any]] = eo_pipeline.run_detection,
                 eo_dir: Path | None = None):
        self._predict = predict_agent
        self._on_progress = on_progress
        self._on_forecast = on_forecast
        self._on_detection = on_detection
        self._fetch_assets = fetch_assets
        self._eo_runner = eo_runner
        self._eo_dir = eo_dir or Path("eo_data")
        self._jobs: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self._tasks: dict[str, asyncio.Task[None]] = {}

    # ── public API ───────────────────────────────────────────────────

    def running_count(self) -> int:
        return sum(1 for j in self._jobs.values() if j["state"] in ("queued", "running"))

    def create(self, bbox: dict[str, float], name: str, kind: str = "flood_forecast",
               before: date | None = None, after: date | None = None) -> dict[str, Any]:
        job_id = uuid.uuid4().hex[:12]
        steps = steps_for(kind)
        job = {
            "job_id": job_id, "type": kind,
            "type_label": ("Flood forecast" if kind == "flood_forecast"
                           else eo_pipeline.ANALYSES[kind]["label"]),
            "state": "queued", "name": name, "bbox": bbox,
            "before": before.isoformat() if before else None,
            "after": after.isoformat() if after else None,
            "created_at": _now(), "updated_at": _now(), "finished_at": None,
            "event_id": None, "error": None,
            "steps": [{"key": k, "label": label, "status": "pending", "detail": ""}
                      for k, label in steps],
        }
        self._jobs[job_id] = job
        while len(self._jobs) > MAX_JOBS_KEPT:
            old_id, _ = self._jobs.popitem(last=False)
            self._tasks.pop(old_id, None)
        runner = self._run_forecast(job) if kind == "flood_forecast" else self._run_eo(job, before, after)
        self._tasks[job_id] = asyncio.create_task(self._guard(job, runner))
        return job

    def get(self, job_id: str) -> dict[str, Any] | None:
        return self._jobs.get(job_id)

    def list(self) -> list[dict[str, Any]]:
        return list(reversed(self._jobs.values()))

    async def wait(self, job_id: str) -> None:
        task = self._tasks.get(job_id)
        if task is not None:
            await task

    # ── plumbing ─────────────────────────────────────────────────────

    async def _notify(self, job: dict[str, Any]) -> None:
        if self._on_progress is None:
            return
        try:
            await self._on_progress(job)
        except Exception:  # a broken listener must not fail the job
            logger.exception("analysis progress hook failed")

    async def _step(self, job: dict[str, Any], key: str, status: str, detail: str = "") -> None:
        for step in job["steps"]:
            if step["key"] == key:
                step["status"] = status
                step["detail"] = detail
        job["updated_at"] = _now()
        await self._notify(job)

    async def _guard(self, job: dict[str, Any], runner: Awaitable[None]) -> None:
        job["state"] = "running"
        try:
            await runner
            job["state"] = "completed"
        except EOUnavailable as exc:
            job["state"], job["error"] = "failed", str(exc)
        except Exception:
            job["state"], job["error"] = "failed", "The analysis could not be completed."
            logger.exception("analysis job %s failed", job["job_id"])
        finally:
            if job["state"] == "failed":
                for step in job["steps"]:
                    if step["status"] == "running":
                        step["status"], step["detail"] = "failed", job["error"] or ""
                    elif step["status"] == "pending":
                        step["status"] = "skipped"
            job["finished_at"] = job["updated_at"] = _now()
            await self._notify(job)

    # ── flood forecast ───────────────────────────────────────────────

    async def _run_forecast(self, job: dict[str, Any]) -> None:
        bbox, name = job["bbox"], job["name"]
        watershed_id = f"aoi_{events_service._slug(name).replace('-', '_')}"
        await self._step(job, "aoi", "ok", name)

        await self._step(job, "forecast", "running")
        forecast = None
        if self._predict is not None:
            model = await self._predict.run_ensemble({
                "alert_id": f"analysis-{job['job_id']}", "watershed_id": watershed_id,
                "bbox": bbox, "location": events_service.bbox_center(bbox),
            })
            forecast = model.model_dump() if model is not None else None
        if forecast is None:
            raise EOUnavailable("The flood forecast could not be produced for this area.")
        tag = {"origin": "analysis", "area": name}
        if self._on_forecast is not None:
            self._on_forecast(forecast, tag)
        demo = forecast.get("ensemble_source") == "statistical-mock"
        await self._step(
            job, "forecast", "unavailable" if demo else "ok",
            ("Rainfall forcing was unavailable; only the demo ensemble could run." if demo else
             f"{forecast['max_probability']:.0%} of members exceed 0.5 m peak depth."))

        await self._step(job, "infrastructure", "running")
        event = events_service.build_forecast_event([forecast], tag)
        assets = await self._fetch_assets(event.id, bbox)
        if assets.get("status") == "available":
            await self._step(job, "infrastructure", "ok",
                             f"{assets['total']} critical facilities found.")
        else:
            await self._step(job, "infrastructure", "unavailable",
                             assets.get("reason", "OpenStreetMap unavailable."))

        detail = events_service.build_forecast_detail([forecast], tag, assets)
        await self._step(job, "risk", "partial", detail.risk.explanation)
        job["event_id"] = event.id

    # ── satellite analyses ───────────────────────────────────────────

    async def _run_eo(self, job: dict[str, Any], before: date | None, after: date | None) -> None:
        kind, bbox, name = job["type"], job["bbox"], job["name"]
        if before is None or after is None:
            before, after = eo_pipeline.default_dates(kind)
            job["before"], job["after"] = before.isoformat(), after.isoformat()
        await self._step(job, "aoi", "ok", f"{name} · {before:%d %b %Y} → {after:%d %b %Y}")

        loop = asyncio.get_running_loop()

        def progress(key: str, status: str, detail: str) -> None:
            # Called from the worker thread: hop back onto the event loop.
            asyncio.run_coroutine_threadsafe(self._step(job, key, status, detail), loop)

        record = await asyncio.to_thread(
            self._eo_runner, kind, bbox, name, before, after, self._eo_dir, progress)

        await self._step(job, "infrastructure", "running")
        assets: dict[str, Any] | None = None
        if record["detected"]:
            assets = await self._fetch_assets(f"area:{record['id']}", bbox)
        record = eo_pipeline.finalize(record, assets)
        inside = record.get("assets_in_extent")
        if not record["detected"]:
            await self._step(job, "infrastructure", "skipped", "Nothing detected — no extent to check.")
        elif inside and inside["status"] == "available":
            await self._step(job, "infrastructure", "ok",
                             f"{inside['total']} of {inside['area_total']} facilities in the area "
                             "are inside the extent.")
        else:
            await self._step(job, "infrastructure", "unavailable",
                             (inside or {}).get("reason") or "OpenStreetMap unavailable.")

        risk = record["risk"]
        await self._step(job, "risk", "ok" if risk["complete"] else "partial", risk["explanation"])
        if self._on_detection is not None:
            await self._on_detection(record)
        job["event_id"] = record["id"]
