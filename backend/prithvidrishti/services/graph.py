"""
Knowledge graph of a satellite detection.

Ported from the OrbitGuard backend prototype. The graph says how a detection
relates to its place, its risk, the datasets behind it and the context around
it, using a small fixed vocabulary:

    Incident -LOCATED_AT-> Location
    Incident -HAS_RISK-> Risk
    Incident -HAS_EVIDENCE_SOURCE-> EvidenceSource      every dataset that was read
    Incident -SUPPORTED_BY-> EvidenceSource             independent data that agrees
    Incident -POSSIBLY_ASSOCIATED_WITH-> EvidenceSource fire detections (never a cause)
    Incident -HAS_SPATIAL_CONTEXT-> SpatialContext      facilities / people in the extent
    Incident -NEAR_OR_WITHIN-> ProtectedAreaContext     mapped protected areas

``build_graph`` derives it from the stored record, so it is always available.
Neo4j is an optional mirror (``NEO4J_ENABLED=true``): it holds relationships,
never geometry, and a failure to reach it never fails an analysis.
"""

from __future__ import annotations

import logging
import os
from typing import Any

logger = logging.getLogger("prithvidrishti.services.graph")

NODE_LABELS = ("Incident", "Location", "Risk", "EvidenceSource", "SpatialContext",
               "ProtectedAreaContext")
RELATIONSHIPS = ("LOCATED_AT", "HAS_RISK", "HAS_EVIDENCE_SOURCE", "SUPPORTED_BY",
                 "POSSIBLY_ASSOCIATED_WITH", "HAS_SPATIAL_CONTEXT", "NEAR_OR_WITHIN")


def build_graph(record: dict[str, Any]) -> dict[str, Any]:
    """Nodes and relationships of one detection record (pure)."""
    rid = record["id"]
    bbox = record["bbox"]
    lat = round((bbox["south"] + bbox["north"]) / 2, 5)
    lng = round((bbox["west"] + bbox["east"]) / 2, 5)
    nodes: dict[str, dict[str, Any]] = {}
    edges: list[dict[str, str]] = []

    def node(key: str, label: str, **props: Any) -> str:
        nodes.setdefault(key, {"id": key, "label": label, "properties": props})
        return key

    def edge(kind: str, target: str) -> None:
        edges.append({"from": rid, "type": kind, "to": target})

    node(rid, "Incident", event_type=record["event_type"], name=record["name"],
         area_km2=record["area_km2"], detected=record["detected"],
         confidence_class=record["confidence"])
    edge("LOCATED_AT", node(f"loc:{lat}:{lng}", "Location", latitude=lat, longitude=lng,
                            name=record["name"]))
    risk = record.get("risk")
    if risk:
        edge("HAS_RISK", node(f"risk:{rid}", "Risk", level=risk["level"],
                              complete=risk["complete"], kind="hazard-exposure matrix"))

    def source(name: str) -> str:
        return node(f"src:{name}", "EvidenceSource", name=name)

    edge("HAS_EVIDENCE_SOURCE", source(record["sensor"]))
    for provider in (record.get("population") or {}).get("providers", []):
        edge("HAS_EVIDENCE_SOURCE", source(provider["name"]))

    forest = record.get("forest")
    if forest:
        tree = forest["tree_cover"]["source"]
        hansen, fires = forest["hansen"], forest["firms"]
        edge("HAS_EVIDENCE_SOURCE", source(tree))
        if record["detected"]:
            edge("SUPPORTED_BY", source(tree))
        if hansen["status"] not in ("unavailable", "not_covered"):
            edge("HAS_EVIDENCE_SOURCE", source(hansen["source"]))
        if hansen["status"] == "supporting":
            edge("SUPPORTED_BY", source(hansen["source"]))
        if fires["status"] in ("detected", "not_detected"):
            edge("HAS_EVIDENCE_SOURCE", source(fires["source"]))
        if fires["status"] == "detected":
            edge("POSSIBLY_ASSOCIATED_WITH", source(fires["source"]))
        protected = forest.get("protected_areas") or {}
        for area in protected.get("overlapping", []):
            edge("NEAR_OR_WITHIN", node(f"protected:{area['osm_id']}", "ProtectedAreaContext",
                                        name=area["name"], relation="overlaps the detection"))

    assets = record.get("assets_in_extent") or {}
    if assets.get("status") == "available":
        edge("HAS_EVIDENCE_SOURCE", source("OpenStreetMap"))
        for kind, count in sorted(assets.get("counts", {}).items()):
            edge("HAS_SPATIAL_CONTEXT", node(f"ctx:{rid}:{kind}", "SpatialContext",
                                             type=kind, count=count))
    population = record.get("population")
    if population and record["detected"]:
        edge("HAS_SPATIAL_CONTEXT", node(f"ctx:{rid}:population", "SpatialContext",
                                         type="population", count=population["value"]))

    return {"incident_id": rid, "nodes": list(nodes.values()), "relationships": edges}


def describe(graph: dict[str, Any]) -> list[dict[str, str]]:
    """Relationships as readable rows for the dashboard."""
    names = {}
    for n in graph["nodes"]:
        p = n["properties"]
        if n["label"] == "SpatialContext":
            names[n["id"]] = f"{p['count']:,} {str(p['type']).replace('_', ' ')}"
        elif n["label"] == "Risk":
            names[n["id"]] = f"{p['level']} risk" + ("" if p["complete"] else " (incomplete)")
        elif n["label"] == "Location":
            names[n["id"]] = f"{p['name']} ({p['latitude']}, {p['longitude']})"
        else:
            names[n["id"]] = str(p.get("name", n["id"]))
    return [{"type": e["type"], "target": names.get(e["to"], e["to"])}
            for e in graph["relationships"]]


# ── optional Neo4j mirror ────────────────────────────────────────────


def neo4j_enabled() -> bool:
    return os.getenv("NEO4J_ENABLED", "").strip().lower() in ("1", "true", "yes")


class Neo4jGraphStore:
    """Writes a detection's graph to Neo4j. Labels and types come from fixed lists."""

    def __init__(self, uri: str, username: str, password: str, database: str = "neo4j",
                 driver: Any | None = None) -> None:
        if driver is None:
            try:
                from neo4j import GraphDatabase
            except ImportError as exc:
                raise RuntimeError("Install the 'neo4j' package to enable the graph store "
                                   "(pip install -r requirements-data.txt).") from exc
            driver = GraphDatabase.driver(uri, auth=(username, password))
        self._driver = driver
        self._database = database

    @classmethod
    def from_env(cls) -> Neo4jGraphStore:
        password = os.getenv("NEO4J_PASSWORD", "")
        if not password:
            raise RuntimeError("NEO4J_PASSWORD is required when NEO4J_ENABLED=true.")
        return cls(os.getenv("NEO4J_URI", "bolt://127.0.0.1:7687"),
                   os.getenv("NEO4J_USERNAME", "neo4j"), password,
                   os.getenv("NEO4J_DATABASE", "neo4j"))

    def close(self) -> None:
        self._driver.close()

    def upsert(self, graph: dict[str, Any]) -> None:
        labels = {n["id"]: n["label"] for n in graph["nodes"]}
        with self._driver.session(database=self._database) as session:
            for n in graph["nodes"]:
                if n["label"] not in NODE_LABELS:
                    continue
                session.run(f"MERGE (n:{n['label']} {{key: $key}}) SET n += $props",
                            key=n["id"], props=n["properties"]).consume()
            for e in graph["relationships"]:
                if e["type"] not in RELATIONSHIPS or labels.get(e["to"]) not in NODE_LABELS:
                    continue
                session.run(
                    f"MATCH (i:Incident {{key: $src}}), (t:{labels[e['to']]} {{key: $dst}}) "
                    f"MERGE (i)-[:{e['type']}]->(t)", src=e["from"], dst=e["to"]).consume()


_store: Neo4jGraphStore | None = None
_store_error: str | None = None


def mirror(record: dict[str, Any]) -> str:
    """Write the record's graph to Neo4j when enabled. Returns the outcome, never raises."""
    global _store, _store_error
    if not neo4j_enabled():
        return "disabled"
    try:
        if _store is None:
            _store = Neo4jGraphStore.from_env()
        _store.upsert(build_graph(record))
        _store_error = None
        return "stored"
    except Exception as exc:
        _store_error = type(exc).__name__
        logger.warning("Neo4j graph mirror failed (%s)", _store_error)
        return "failed"


def store_status() -> dict[str, Any]:
    return {"neo4j": "enabled" if neo4j_enabled() else "disabled", "last_error": _store_error}
