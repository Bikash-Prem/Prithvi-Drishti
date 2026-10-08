"""Pieces merged from the OrbitGuard backend prototype: evidence fusion, protected
areas, the knowledge graph and the optional PostGIS / Neo4j mirrors.
No network and no database: HTTP, the Neo4j driver and psycopg are faked.
"""

from __future__ import annotations

import pytest
from shapely.geometry import box

from prithvidrishti.eo import forest, postgis_store
from prithvidrishti.services import detection_events as det_ev
from prithvidrishti.services import graph
from tests.test_eo import BBOX, _record
from tests.test_forest import _forest_record

# ── evidence fusion ──────────────────────────────────────────────────


def test_fusion_counts_agreeing_datasets_and_never_claims_a_probability():
    stronger = forest.fuse(True, {"status": "supporting"}, {"status": "detected"})
    assert stronger["corroboration"] == "stronger" and stronger["independent_forest_evidence_sources"] == 2
    assert stronger["assessment"] == "potential_forest_loss_with_independent_support"
    assert stronger["not_a_calibrated_probability"] and stronger["fire_is_supporting_only"]
    assert stronger["indicators"]["firms_fire_detected"]            # recorded, but not counted as support
    one = forest.fuse(True, {"status": "nearby_only"}, {"status": "not_configured"})
    assert one["corroboration"] == "supporting"
    assert one["assessment"] == "potential_forest_loss_without_independent_loss_record"
    none = forest.fuse(False, {"status": "supporting"}, {"status": "detected"})
    assert none["assessment"] == "no_detected_forest_loss" and none["corroboration"] == "supporting"


def test_fusion_reaches_the_event_as_an_inferred_statement():
    detail = det_ev.build_detection_detail(_forest_record())
    assert detail.fusion["corroboration"] == "stronger"
    inferred = [s["text"] for s in detail.statements if s["tag"] == "INFERRED"]
    assert any("corroboration is stronger" in t and "not a probability" in t for t in inferred)
    assert det_ev.build_detection_detail(_record()).fusion is None


# ── protected areas ──────────────────────────────────────────────────

SQUARE = [{"lat": 27.65, "lon": 85.25}, {"lat": 27.65, "lon": 85.35}, {"lat": 27.75, "lon": 85.35},
          {"lat": 27.75, "lon": 85.25}, {"lat": 27.65, "lon": 85.25}]
ELEMENTS = [
    {"type": "way", "id": 1, "tags": {"name": "Shivapuri Reserve", "leisure": "nature_reserve"},
     "geometry": SQUARE},
    {"type": "relation", "id": 2, "tags": {"name": "Far Park", "boundary": "national_park"},
     "members": [{"role": "outer", "geometry": [{"lat": p["lat"], "lon": p["lon"] + 0.11} for p in SQUARE[:3]]},
                 {"role": "outer", "geometry": [{"lat": p["lat"], "lon": p["lon"] + 0.11} for p in SQUARE[2:]]}]},
    {"type": "way", "id": 3, "tags": {"name": "Open line"}, "geometry": SQUARE[:3]},      # not a polygon
]


class _Resp:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


def test_protected_areas_are_matched_against_the_detected_extent():
    areas = forest.parse_protected(ELEMENTS)
    assert [a["name"] for a in areas] == ["Shivapuri Reserve", "Far Park"]        # the open line is skipped
    assert areas[1]["geometry"].area == pytest.approx(0.01, rel=0.01)             # relation ring assembled

    out = forest.protected_areas(BBOX, box(85.30, 27.68, 85.34, 27.71),
                                 post=lambda *a, **k: _Resp({"elements": ELEMENTS}))
    assert out["status"] == "available" and out["in_area"] == 2
    assert [a["name"] for a in out["overlapping"]] == ["Shivapuri Reserve"]
    assert "geometry" not in out["overlapping"][0] and "not a complete" in out["note"]
    nothing = forest.protected_areas(BBOX, None, post=lambda *a, **k: _Resp({"elements": ELEMENTS}))
    assert nothing["overlapping"] == [] and nothing["in_area"] == 2
    query = forest.protected_query(BBOX)
    assert "is_in(" in query and "national_park" in query and "nature_reserve" in query


def test_protected_area_lookup_failure_is_reported_not_guessed():
    def boom(*args, **kwargs):
        raise TimeoutError("overpass slow")

    out = forest.protected_areas(BBOX, box(85.30, 27.68, 85.34, 27.71), post=boom)
    assert out["status"] == "unavailable" and out["in_area"] is None and "TimeoutError" in out["reason"]
    # Overpass reports a timed-out query as HTTP 200 + an empty result + a remark.
    remark = forest.protected_areas(BBOX, None, post=lambda *a, **k: _Resp(
        {"elements": [], "remark": "runtime error: Query timed out in \"query\" at line 1"}))
    assert remark["status"] == "unavailable"
    record = _forest_record()
    record["forest"]["protected_areas"] = out
    rows = {r["source"].split(" — ")[0]: r for r in det_ev.build_detection_detail(record).supporting_evidence}
    assert rows["Protected areas"]["status"] == "unavailable"


# ── knowledge graph ──────────────────────────────────────────────────


def _edges(g, kind):
    names = {n["id"]: n["properties"].get("name") or n["properties"].get("type") for n in g["nodes"]}
    return sorted(str(names[e["to"]]) for e in g["relationships"] if e["type"] == kind)


def test_graph_links_a_forest_detection_to_its_evidence_without_claiming_cause():
    record = _forest_record()
    record["forest"]["protected_areas"] = {"status": "available", "overlapping": [
        {"osm_id": "way/1", "name": "Shivapuri Reserve"}], "overlapping_total": 1}
    g = graph.build_graph(record)
    assert _edges(g, "SUPPORTED_BY") == ["ESA WorldCover 10 m", "Hansen/UMD Global Forest Change"]
    assert _edges(g, "NEAR_OR_WITHIN") == ["Shivapuri Reserve"]
    assert _edges(g, "POSSIBLY_ASSOCIATED_WITH") == []                # FIRMS not configured: no fire edge
    assert "NASA FIRMS" not in _edges(g, "HAS_EVIDENCE_SOURCE")
    assert len(_edges(g, "LOCATED_AT")) == 1 and len(_edges(g, "HAS_RISK")) == 1
    assert {e["type"] for e in g["relationships"]} <= set(graph.RELATIONSHIPS)

    fire = _forest_record("no_matching_annual_loss", "detected")
    g = graph.build_graph(fire)
    assert _edges(g, "POSSIBLY_ASSOCIATED_WITH") == ["NASA FIRMS"]
    assert _edges(g, "SUPPORTED_BY") == ["ESA WorldCover 10 m"]


def test_graph_of_a_flood_detection_carries_people_and_facilities():
    g = graph.build_graph(_record())
    assert _edges(g, "HAS_SPATIAL_CONTEXT") == ["hospital", "population"]
    rows = graph.describe(g)
    assert {"type": "HAS_SPATIAL_CONTEXT", "target": "4,200 population"} in rows
    assert any(r["type"] == "HAS_RISK" and "(incomplete)" in r["target"] for r in rows)
    assert det_ev.build_detection_detail(_record()).relationships == rows


class _FakeSession:
    def __init__(self, log):
        self.log = log

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def run(self, query, **params):
        self.log.append((query, params))
        return type("R", (), {"consume": lambda self: None})()


class _FakeDriver:
    def __init__(self):
        self.log = []

    def session(self, database):
        return _FakeSession(self.log)

    def close(self):
        return None


def test_neo4j_mirror_writes_only_whitelisted_labels_and_is_off_by_default(monkeypatch):
    driver = _FakeDriver()
    store = graph.Neo4jGraphStore("bolt://x", "neo4j", "pw", driver=driver)
    g = graph.build_graph(_forest_record())
    g["nodes"].append({"id": "x", "label": "Evil) DETACH DELETE (n", "properties": {}})
    g["relationships"].append({"from": g["incident_id"], "type": "DROP", "to": "x"})
    store.upsert(g)
    text = " ".join(q for q, _ in driver.log)
    assert "DETACH" not in text and "DROP" not in text
    assert "MERGE (n:Incident {key: $key})" in text and "MERGE (i)-[:SUPPORTED_BY]->(t)" in text

    monkeypatch.delenv("NEO4J_ENABLED", raising=False)
    assert graph.mirror(_record()) == "disabled"
    monkeypatch.setenv("NEO4J_ENABLED", "true")
    monkeypatch.delenv("NEO4J_PASSWORD", raising=False)
    monkeypatch.setattr(graph, "_store", None)
    assert graph.mirror(_record()) == "failed"                      # misconfigured: reported, not raised
    assert graph.store_status() == {"neo4j": "enabled", "last_error": "RuntimeError"}


# ── PostGIS mirror ───────────────────────────────────────────────────


class _FakeCursor:
    def __init__(self, log):
        self.log = log

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.log.append((sql, params))

    def fetchall(self):
        return [("det-1",), ("det-2",)]


class _FakeConn:
    def __init__(self, log):
        self.log = log

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def cursor(self):
        return _FakeCursor(self.log)

    def commit(self):
        self.log.append(("COMMIT", None))


def test_postgis_store_saves_the_extent_as_geography_and_queries_spatially():
    log = []
    store = postgis_store.PostgisDetectionStore("postgresql://u:p@h/db", connect=lambda dsn: _FakeConn(log))
    store.init()
    assert any("CREATE EXTENSION IF NOT EXISTS postgis" in sql for sql, _ in log)
    assert any("USING GIST (extent)" in sql for sql, _ in log)
    log.clear()
    store.save(_record())
    sql, params = log[0]
    assert "ST_GeomFromText(%s), 4326)::geography" in sql and "ON CONFLICT (id) DO UPDATE" in sql
    assert params[0] == "det-0123456789" and params[6].startswith("MULTIPOLYGON")
    assert store.intersecting(BBOX) == ["det-1", "det-2"]
    assert "ST_Intersects" in log[-1][0] and log[-1][1][:4] == (85.2, 27.6, 85.45, 27.8)


def test_postgis_extent_falls_back_to_the_analysed_rectangle_and_errors_hide_the_dsn(monkeypatch):
    assert postgis_store.extent_wkt(_record(detected=False)).startswith("MULTIPOLYGON (((85.2 27.6")
    monkeypatch.delenv("POSTGIS_ENABLED", raising=False)
    assert postgis_store.mirror(_record()) == "disabled"
    monkeypatch.setenv("POSTGIS_ENABLED", "true")
    monkeypatch.setenv("POSTGIS_DSN", "")
    monkeypatch.setattr(postgis_store, "_store", None)
    assert postgis_store.mirror(_record()) == "failed"
    assert postgis_store.status() == {"postgis": "enabled", "last_error": "ValueError"}
    with pytest.raises(ValueError):
        postgis_store.PostgisDetectionStore("  ")
