"""
Critical-infrastructure assets from OpenStreetMap (Overpass API, keyless).

One bounded query per area, cached in memory for a day (OSM facilities change
slowly). The result is either real OSM data or an explicit ``unavailable``
record with the reason — never a placeholder count.
"""

from __future__ import annotations

import time
from datetime import UTC, datetime
from typing import Any

import httpx

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
USER_AGENT = "PrithviDrishti/0.6 (environmental monitoring; contact: repo owner)"
MAX_SPAN_DEG = 0.6          # widest box we send to Overpass (~65 km)
MAX_ELEMENTS = 1500
CACHE_TTL_S = 86400
TIMEOUT_S = 40.0

# OSM tag → unified asset type. Order matters only for readability.
ASSET_TYPES: dict[str, tuple[str, str]] = {
    "hospital": ("amenity", "hospital"),
    "clinic": ("amenity", "clinic"),
    "school": ("amenity", "school"),
    "fire_station": ("amenity", "fire_station"),
    "police": ("amenity", "police"),
    "shelter": ("amenity", "shelter"),
    "assembly_point": ("emergency", "assembly_point"),
    "power_substation": ("power", "substation"),
    "airport": ("aeroway", "aerodrome"),
}
# Relative importance for sorting/markers; a documented convention, not a score.
CRITICALITY: dict[str, int] = {
    "hospital": 3, "fire_station": 3, "power_substation": 3, "airport": 3,
    "clinic": 2, "police": 2, "shelter": 2, "assembly_point": 2, "school": 1,
}

_cache: dict[str, tuple[float, dict[str, Any]]] = {}


def clamp_bbox(bbox: dict[str, float], max_span: float = MAX_SPAN_DEG) -> tuple[dict[str, float], bool]:
    """Shrink a bbox around its centre to at most ``max_span`` degrees a side."""
    lat = (bbox["south"] + bbox["north"]) / 2
    lng = (bbox["west"] + bbox["east"]) / 2
    half_lat = min(max_span, bbox["north"] - bbox["south"]) / 2
    half_lng = min(max_span, bbox["east"] - bbox["west"]) / 2
    clamped = {
        "south": round(max(-90.0, lat - half_lat), 5), "north": round(min(90.0, lat + half_lat), 5),
        "west": round(max(-180.0, lng - half_lng), 5), "east": round(min(180.0, lng + half_lng), 5),
    }
    changed = (bbox["north"] - bbox["south"] > max_span + 1e-9
               or bbox["east"] - bbox["west"] > max_span + 1e-9)
    return clamped, changed


def bbox_around(lat: float, lng: float, half_deg: float = 0.25) -> dict[str, float]:
    return {"south": max(-90.0, lat - half_deg), "north": min(90.0, lat + half_deg),
            "west": max(-180.0, lng - half_deg), "east": min(180.0, lng + half_deg)}


def build_query(bbox: dict[str, float]) -> str:
    box = f"({bbox['south']},{bbox['west']},{bbox['north']},{bbox['east']})"
    by_key: dict[str, list[str]] = {}
    for key, value in ASSET_TYPES.values():
        by_key.setdefault(key, []).append(value)
    clauses = "".join(
        f'nwr["{key}"~"^({"|".join(values)})$"]{box};' for key, values in by_key.items())
    return f"[out:json][timeout:30];({clauses});out center tags {MAX_ELEMENTS};"


def classify(tags: dict[str, str]) -> str | None:
    for asset_type, (key, value) in ASSET_TYPES.items():
        if tags.get(key) == value:
            return asset_type
    return None


def parse_elements(elements: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Overpass elements → GeoJSON point features in the unified asset model."""
    features: list[dict[str, Any]] = []
    for el in elements:
        tags = el.get("tags") or {}
        asset_type = classify(tags)
        lat = el.get("lat", (el.get("center") or {}).get("lat"))
        lng = el.get("lon", (el.get("center") or {}).get("lon"))
        if asset_type is None or lat is None or lng is None:
            continue
        features.append({
            "type": "Feature",
            "id": f"osm-{el.get('type', 'n')}-{el.get('id')}",
            "geometry": {"type": "Point", "coordinates": [float(lng), float(lat)]},
            "properties": {
                "asset_type": asset_type,
                "name": tags.get("name") or tags.get("name:en") or "",
                "criticality": CRITICALITY.get(asset_type, 1),
                "source": "OpenStreetMap",
                "osm_type": el.get("type"),
                "osm_id": el.get("id"),
            },
        })
    return features


def summarize(features: list[dict[str, Any]], bbox: dict[str, float], clamped: bool,
              fetched_at: str) -> dict[str, Any]:
    counts: dict[str, int] = {}
    for f in features:
        t = f["properties"]["asset_type"]
        counts[t] = counts.get(t, 0) + 1
    return {
        "status": "available",
        "total": len(features),
        "counts": counts,
        "truncated": len(features) >= MAX_ELEMENTS,
        "bbox": bbox,
        "bbox_clamped": clamped,
        "fetched_at": fetched_at,
        "source": "OpenStreetMap (Overpass API)",
        "license": "ODbL — © OpenStreetMap contributors",
        "geojson": {"type": "FeatureCollection", "features": features},
    }


def _unavailable(reason: str, bbox: dict[str, float]) -> dict[str, Any]:
    return {"status": "unavailable", "reason": reason, "bbox": bbox,
            "total": 0, "counts": {}, "geojson": {"type": "FeatureCollection", "features": []}}


def cached(key: str) -> dict[str, Any] | None:
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < CACHE_TTL_S:
        return hit[1]
    return None


async def fetch_assets(key: str, bbox: dict[str, float],
                       client: httpx.AsyncClient | None = None) -> dict[str, Any]:
    """Critical facilities inside ``bbox`` (clamped). Failures are not cached."""
    hit = cached(key)
    if hit is not None:
        return hit
    box, clamped = clamp_bbox(bbox)
    owns = client is None
    client = client or httpx.AsyncClient(timeout=TIMEOUT_S)
    try:
        resp = await client.post(OVERPASS_URL, data={"data": build_query(box)},
                                 headers={"User-Agent": USER_AGENT})
        resp.raise_for_status()
        elements = resp.json().get("elements", [])
    except httpx.TimeoutException:
        return _unavailable("OpenStreetMap (Overpass) timed out. Try again shortly.", box)
    except httpx.HTTPStatusError as exc:
        code = exc.response.status_code
        why = "is rate-limiting requests" if code == 429 else f"returned HTTP {code}"
        return _unavailable(f"OpenStreetMap (Overpass) {why}. Try again shortly.", box)
    except Exception as exc:  # network / malformed JSON
        return _unavailable(f"OpenStreetMap (Overpass) could not be reached ({type(exc).__name__}).", box)
    finally:
        if owns:
            await client.aclose()

    result = summarize(parse_elements(elements), box, clamped, datetime.now(UTC).isoformat())
    _cache[key] = (time.time(), result)
    return result


def without_geometry(assets: dict[str, Any] | None) -> dict[str, Any] | None:
    """Counts/provenance only — for embedding in event payloads."""
    if assets is None:
        return None
    return {k: v for k, v in assets.items() if k != "geojson"}
