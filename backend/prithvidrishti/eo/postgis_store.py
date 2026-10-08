"""
Optional PostGIS mirror of satellite detections.

Ported from the OrbitGuard backend prototype. SQLite (``eo.repository``)
stays the default store so the platform runs with nothing installed; when
``POSTGIS_ENABLED=true`` every detection is also written here with its extent
as a real ``geography``, which makes spatial questions ("which detections
intersect this area?") a database query instead of a scan.

Schema: ``backend/migrations/001_postgis.sql`` (also applied by ``init``).
Needs ``psycopg`` (``requirements-data.txt``). A failure to reach the database
is logged and never fails an analysis.
"""

from __future__ import annotations

import json
import logging
import os
from collections.abc import Callable
from typing import Any

from shapely.geometry import MultiPolygon, Polygon, shape

from prithvidrishti.eo import vector

logger = logging.getLogger("prithvidrishti.eo.postgis")

SCHEMA = (
    "CREATE EXTENSION IF NOT EXISTS postgis",
    """CREATE TABLE IF NOT EXISTS detections (
        id          TEXT PRIMARY KEY,
        event_type  TEXT NOT NULL,
        name        TEXT NOT NULL,
        detected    BOOLEAN NOT NULL,
        area_km2    DOUBLE PRECISION NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL,
        extent      GEOGRAPHY(GEOMETRY, 4326) NOT NULL,
        payload     JSONB NOT NULL
    )""",
    "CREATE INDEX IF NOT EXISTS detections_extent_gix ON detections USING GIST (extent)",
    "CREATE INDEX IF NOT EXISTS detections_event_type_idx ON detections (event_type)",
)


def enabled() -> bool:
    return os.getenv("POSTGIS_ENABLED", "").strip().lower() in ("1", "true", "yes")


def extent_wkt(record: dict[str, Any]) -> str:
    """The detected extent as WKT; the analysed rectangle when nothing was detected."""
    geom = vector.union_geometry(record["geometry"])
    if geom is None or geom.is_empty:
        geom = shape(vector.bbox_polygon(record["bbox"]))
    if isinstance(geom, Polygon):
        geom = MultiPolygon([geom])
    return geom.wkt


class PostgisDetectionStore:
    def __init__(self, dsn: str, connect: Callable[[str], Any] | None = None) -> None:
        if not dsn.strip():
            raise ValueError("POSTGIS_DSN is required when POSTGIS_ENABLED=true.")
        if connect is None:
            try:
                import psycopg
            except ImportError as exc:
                raise RuntimeError("Install 'psycopg' to enable PostGIS "
                                   "(pip install -r requirements-data.txt).") from exc
            connect = psycopg.connect
        self._dsn = dsn
        self._connect = connect

    def init(self) -> None:
        with self._connect(self._dsn) as conn:
            with conn.cursor() as cur:
                for statement in SCHEMA:
                    cur.execute(statement)
            conn.commit()

    def save(self, record: dict[str, Any]) -> None:
        with self._connect(self._dsn) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """INSERT INTO detections
                           (id, event_type, name, detected, area_km2, created_at, extent, payload)
                       VALUES (%s, %s, %s, %s, %s, %s,
                               ST_SetSRID(ST_GeomFromText(%s), 4326)::geography, %s::jsonb)
                       ON CONFLICT (id) DO UPDATE SET
                           payload = EXCLUDED.payload, extent = EXCLUDED.extent,
                           area_km2 = EXCLUDED.area_km2, detected = EXCLUDED.detected""",
                    (record["id"], record["event_type"], record["name"], record["detected"],
                     record["area_km2"], record["created_at"], extent_wkt(record),
                     json.dumps(record)))
            conn.commit()

    def intersecting(self, bbox: dict[str, float], limit: int = 100) -> list[str]:
        """Ids of detections whose extent intersects ``bbox``, newest first."""
        with self._connect(self._dsn) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """SELECT id FROM detections
                       WHERE ST_Intersects(extent,
                             ST_MakeEnvelope(%s, %s, %s, %s, 4326)::geography)
                       ORDER BY created_at DESC LIMIT %s""",
                    (bbox["west"], bbox["south"], bbox["east"], bbox["north"], limit))
                return [row[0] for row in cur.fetchall()]


_store: PostgisDetectionStore | None = None
_last_error: str | None = None


def mirror(record: dict[str, Any]) -> str:
    """Write the record to PostGIS when enabled. Returns the outcome, never raises."""
    global _store, _last_error
    if not enabled():
        return "disabled"
    try:
        if _store is None:
            store = PostgisDetectionStore(os.getenv("POSTGIS_DSN", ""))
            store.init()
            _store = store
        _store.save(record)
        _last_error = None
        return "stored"
    except Exception as exc:
        _last_error = type(exc).__name__      # the DSN holds a password: never log the message
        logger.warning("PostGIS mirror failed (%s)", _last_error)
        return "failed"


def status() -> dict[str, Any]:
    return {"postgis": "enabled" if enabled() else "disabled", "last_error": _last_error}
