"""
Detection persistence.

Detections (the JSON record with geometry) are stored in SQLite so they
survive a restart; overlay PNGs live beside it on disk. Single-node storage:
the table is deliberately plain (id, type, time, bbox columns, JSON payload)
so it maps directly onto a PostGIS table with a geometry column later.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
from pathlib import Path
from typing import Any

_SCHEMA = """
CREATE TABLE IF NOT EXISTS detections (
    id          TEXT PRIMARY KEY,
    event_type  TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    south REAL NOT NULL, west REAL NOT NULL, north REAL NOT NULL, east REAL NOT NULL,
    payload     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_detections_created ON detections (created_at);
"""
_ID = re.compile(r"^det-[0-9a-f]{6,32}$")
_FILE = re.compile(r"^[a-z_]{1,24}\.png$")


def default_data_dir() -> Path:
    return Path(os.getenv("PRITHVIDRISHTI_EO_DIR", "eo_data")).resolve()


class DetectionRepository:
    def __init__(self, data_dir: Path | None = None):
        self.data_dir = data_dir or default_data_dir()
        self.db_path = self.data_dir / "detections.sqlite3"

    def init(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        with self._connect() as db:
            db.executescript(_SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self.db_path, timeout=10)

    def save(self, record: dict[str, Any]) -> None:
        b = record["bbox"]
        with self._connect() as db:
            db.execute(
                "INSERT OR REPLACE INTO detections VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (record["id"], record["event_type"], record["created_at"],
                 b["south"], b["west"], b["north"], b["east"], json.dumps(record)))

    def load_all(self, limit: int = 200) -> list[dict[str, Any]]:
        with self._connect() as db:
            rows = db.execute(
                "SELECT payload FROM detections ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
        return [json.loads(r[0]) for r in rows]

    def image_path(self, record_id: str, filename: str) -> Path | None:
        """Path of an overlay PNG, or None if the names are not ones we generate."""
        if not _ID.match(record_id) or not _FILE.match(filename):
            return None
        path = (self.data_dir / record_id / filename).resolve()
        if self.data_dir not in path.parents or not path.is_file():
            return None
        return path
