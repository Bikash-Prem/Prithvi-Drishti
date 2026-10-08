-- Optional PostGIS mirror of satellite detections (POSTGIS_ENABLED=true).
-- The backend applies the same statements on first use.

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS detections (
    id          TEXT PRIMARY KEY,
    event_type  TEXT NOT NULL,
    name        TEXT NOT NULL,
    detected    BOOLEAN NOT NULL,
    area_km2    DOUBLE PRECISION NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL,
    extent      GEOGRAPHY(GEOMETRY, 4326) NOT NULL,
    payload     JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS detections_extent_gix ON detections USING GIST (extent);

CREATE INDEX IF NOT EXISTS detections_event_type_idx ON detections (event_type);
