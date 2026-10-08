"""
Satellite detections → events.

Turns a stored EO detection record (``prithvidrishti.eo.pipeline``) into the same
event/detail shape as forecasts and external reports, so the dashboard and the
assistant treat all three uniformly. Statements are tagged OBSERVED /
INFERRED / UNCERTAIN / RECOMMENDED so a reader can tell measurement from
interpretation.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from prithvidrishti.eo import forest as forest_evidence
from prithvidrishti.services import graph as graph_service
from prithvidrishti.services.events import (
    VULNERABILITY_UNAVAILABLE,
    Confidence,
    EventDetail,
    EventSource,
    EventSummary,
    EvidenceItem,
    Measure,
    RiskAssessment,
    RiskComponent,
    bbox_center,
)

CONFIDENCE_LABEL = {
    "high": "High confidence", "probable": "Probable", "detected": "Detected",
    "uncertain": "Uncertain", "not_detected": "Nothing detected",
}
RECENT_DAYS = 45


def _d(iso: str) -> str:
    return datetime.fromisoformat(iso).strftime("%d %b %Y")


def _area_measure(r: dict[str, Any]) -> Measure:
    return Measure(status="available", value=r["area_km2"], low=r["area_low_km2"],
                   high=r["area_high_km2"], unit="km²",
                   source=f"{r['sensor']} · {r['model']['id']} {r['model']['version']}")


def _population_measure(r: dict[str, Any]) -> Measure:
    if not r["exposure_applicable"]:
        return Measure.not_assessed("Population exposure is not assessed for this event type.", "people")
    pop = r.get("population")
    if pop is None:
        return Measure.unavailable(r.get("population_error") or "Population data unavailable.", "people")
    return Measure(status="available", value=pop["value"], low=pop["low"], high=pop["high"],
                   unit="people", source="HRSL (Meta) inside the detected extent")


def _assets_measure(r: dict[str, Any]) -> Measure:
    a = r.get("assets_in_extent")
    if a is None:
        return Measure.not_assessed("Facilities were not checked.", "facilities")
    if a.get("status") != "available":
        return Measure.unavailable(a.get("reason") or "OpenStreetMap unavailable.", "facilities")
    return Measure(status="available", value=float(a["total"]), unit="facilities",
                   source="OpenStreetMap, inside the detected extent")


def build_detection_event(r: dict[str, Any]) -> EventSummary:
    acquired = r["after"]["acquired"]
    age_days = (datetime.now(UTC) - datetime.fromisoformat(acquired)).days
    risk = r.get("risk") or {"level": "low"}
    if r["detected"]:
        headline = (f"{r['area_km2']:.2f} km² of {r['noun']} "
                    f"(range {r['area_low_km2']:.2f}–{r['area_high_km2']:.2f})")
    else:
        headline = f"No {r['noun']} detected"
    return EventSummary(
        id=r["id"], type=r["event_type"], kind="detected",
        title=f"{r['label']} — {r['name']}",
        location_name=r["name"], center=bbox_center(r["bbox"]), bbox=r["bbox"],
        detected_at=acquired, updated_at=r["created_at"],
        ended_at=None, status="active" if age_days <= RECENT_DAYS else "past",
        source=EventSource(provider=f"{r['sensor']} analysis", kind="satellite_detection"),
        data_status="live", severity=risk["level"],
        confidence=Confidence(
            kind="detection_class", label=CONFIDENCE_LABEL.get(r["confidence"], r["confidence"]),
            explanation=" ".join(r["confidence_reasons"])
                        + " This is a qualitative class from a baseline method, not a calibrated probability."),
        affected_area_km2=_area_measure(r) if r["detected"] else Measure(
            status="available", value=0.0, low=0.0, high=r["area_high_km2"], unit="km²",
            source=f"{r['sensor']} · {r['model']['id']} {r['model']['version']}"),
        population_exposed=_population_measure(r),
        assets_exposed=_assets_measure(r),
        headline=headline,
    )


def _statements(r: dict[str, Any], event: EventSummary) -> list[dict[str, str]]:
    before, after = _d(r["before"]["acquired"]), _d(r["after"]["acquired"])
    out: list[dict[str, str]] = []
    if r["detected"]:
        out.append({"tag": "OBSERVED", "text":
                    f"{r['sensor']} imagery from {before} and {after} shows {r['area_km2']:.2f} km² of "
                    f"{r['noun']} in {r['geometry']['patch_count']} patch(es) "
                    f"({r['valid_fraction']:.0%} of the area was assessable on both dates)."})
    else:
        out.append({"tag": "OBSERVED", "text":
                    f"{r['sensor']} imagery from {before} and {after} shows no {r['noun']} above the "
                    f"detection thresholds across the {r['valid_fraction']:.0%} of the area that was assessable."})
    pop = r.get("population")
    if pop is not None and r["detected"]:
        out.append({"tag": "OBSERVED", "text":
                    f"About {pop['value']:,} people live inside the detected extent according to "
                    "Meta's HRSL population raster (spatial intersection)."})
    a = r.get("assets_in_extent")
    if a and a.get("status") == "available" and r["detected"]:
        out.append({"tag": "OBSERVED", "text":
                    f"{a['total']} mapped critical facilities lie inside the extent (OpenStreetMap)."})
    risk = r["risk"]
    out.append({"tag": "INFERRED", "text": risk["explanation"]})
    out.append({"tag": "UNCERTAIN", "text":
                f"Extent ranges from {r['area_low_km2']:.2f} to {r['area_high_km2']:.2f} km² depending on "
                f"the detection threshold. Detection confidence: {event.confidence.label.lower()}."
                + (f" Population ranges {pop['low']:,}–{pop['high']:,} across datasets."
                   if pop is not None and r["detected"] else "")})
    out.extend(_forest_statements(r))
    for flag in r["quality_flags"]:
        out.append({"tag": "UNCERTAIN", "text": flag})
    out.append({"tag": "RECOMMENDED", "text": _recommendation(r)})
    order = {"OBSERVED": 0, "INFERRED": 1, "UNCERTAIN": 2, "RECOMMENDED": 3}
    return sorted(out, key=lambda s: order[s["tag"]])       # stable: keeps order within a tag


def _forest_statements(r: dict[str, Any]) -> list[dict[str, str]]:
    """What the independent ForestGuard datasets add — or fail to add."""
    f = r.get("forest")
    if not f:
        return []
    out: list[dict[str, str]] = []
    h, fire = f["hansen"], f["firms"]
    years = _year_span(h.get("years") or [])
    if h["status"] == "supporting":
        out.append({"tag": "OBSERVED", "text":
                    f"The Hansen/UMD forest-change record independently marks {_km2(h['overlap_km2'])} "
                    f"of the detected patches as forest loss in {years} "
                    f"({_km2(h['matching_annual_loss_km2'])} across the whole area)."})
    elif h["status"] == "nearby_only":
        out.append({"tag": "UNCERTAIN", "text":
                    f"Hansen/UMD records {_km2(h['matching_annual_loss_km2'])} of forest loss in the area "
                    f"in {years}, but none of it overlaps the detected patches."})
    elif h["status"] == "no_matching_annual_loss":
        out.append({"tag": "UNCERTAIN", "text":
                    f"Hansen/UMD records no forest loss here in {years} — the detection is not "
                    "independently supported."})
    elif h["status"] == "not_covered":
        out.append({"tag": "UNCERTAIN", "text":
                    "The Hansen/UMD record does not cover the years compared, so it cannot confirm "
                    "or contradict this detection."})
    else:
        out.append({"tag": "UNCERTAIN", "text":
                    "The Hansen/UMD forest-change record could not be read; the detection has no "
                    "independent check."})
    if h["status"] in ("supporting", "nearby_only", "no_matching_annual_loss") and "not covered" in h["note"]:
        out.append({"tag": "UNCERTAIN", "text": h["note"].split("date. ", 1)[-1]})
    protected = f.get("protected_areas") or {}
    if protected.get("overlapping"):
        names = ", ".join(a["name"] for a in protected["overlapping"][:3])
        more = protected.get("overlapping_total", 0) - 3
        out.append({"tag": "OBSERVED", "text":
                    f"The detected patches overlap {protected['overlapping_total']} protected area(s) "
                    f"mapped in OpenStreetMap: {names}{f' and {more} more' if more > 0 else ''}."})
    fusion = _fusion(r)
    if fusion and r["detected"]:
        out.append({"tag": "INFERRED", "text":
                    f"Evidence corroboration is {fusion['corroboration']}: "
                    f"{forest_evidence.CORROBORATION_WORD[fusion['corroboration']]}. "
                    "This counts agreeing datasets; it is not a probability and says nothing about cause."})
    if fire["status"] == "detected":
        out.append({"tag": "OBSERVED", "text":
                    f"NASA FIRMS recorded {fire['fire_detections']} active-fire detection(s) in the area "
                    f"between {_d(fire['window']['start'])} and {_d(fire['window']['end'])}. "
                    "This does not prove that fire caused the change."})
    elif fire["status"] == "not_detected":
        out.append({"tag": "OBSERVED", "text":
                    f"NASA FIRMS recorded no active fires in the area between "
                    f"{_d(fire['window']['start'])} and {_d(fire['window']['end'])}."})
    return out


def _fusion(r: dict[str, Any]) -> dict[str, Any] | None:
    """Fusion summary; recomputed for records stored before it existed."""
    f = r.get("forest")
    if not f:
        return None
    return f.get("fusion") or forest_evidence.fuse(r["detected"], f["hansen"], f["firms"])


def _km2(value: float) -> str:
    return "under 0.01 km²" if 0 < value < 0.01 else f"{value:.2f} km²"


def _year_span(years: list[int]) -> str:
    if not years:
        return "the period"
    return str(years[0]) if len(years) == 1 else f"{years[0]}–{years[-1]}"


def _supporting_evidence(r: dict[str, Any]) -> list[dict[str, Any]]:
    """One row per independent dataset: what it is, its status, and the number behind it."""
    f = r.get("forest")
    if not f:
        return []
    h, fire = f["hansen"], f["firms"]
    rows = [
        {"source": "Sentinel-2 NDVI change", "status": "detected" if r["detected"] else "not_detected",
         "value": f"{r['area_km2']:.2f} km² on tree cover" if r["detected"] else None,
         "note": "Primary detector."},
        {"source": f"Tree cover — {f['tree_cover']['source']} ({f['tree_cover']['reference_year']})",
         "status": "context",
         "value": (f"{r['metrics']['tree_cover_fraction']:.0%} of the area is tree cover"
                   if r["metrics"].get("tree_cover_fraction") is not None else None),
         "note": "Used to separate forest from other vegetation. Stands in for Google Dynamic "
                 "World, which is only served through Earth Engine."},
        {"source": f"{h['source']} ({h['dataset']})", "status": h["status"],
         "value": (f"{_km2(h['overlap_km2'])} overlapping · {_km2(h['matching_annual_loss_km2'])} in area"
                   if h.get("matching_annual_loss_km2") is not None else None),
         "note": h.get("reason") or h["note"]},
        {"source": f"{fire['source']} ({fire['sensor']})", "status": fire["status"],
         "value": (f"{fire['fire_detections']} detection(s), "
                   f"{_d(fire['window']['start'])} – {_d(fire['window']['end'])}"
                   if fire.get("fire_detections") is not None else None),
         "note": fire.get("reason") or fire["note"]},
    ]
    protected = f.get("protected_areas")
    if protected:
        if protected["status"] != "available":
            status, value = "unavailable", None
        elif protected["overlapping"]:
            status = "overlapping"
            value = "; ".join(a["name"] for a in protected["overlapping"][:5])
        else:
            status = "none_overlapping"
            value = f"{protected['in_area']} mapped in the analysis area, none overlapping the detection"
        rows.append({"source": f"Protected areas — {protected['source']}", "status": status,
                     "value": value, "note": protected.get("reason") or protected["note"]})
    return rows


def _recommendation(r: dict[str, Any]) -> str:
    if not r["detected"]:
        if r["kind"] == "sar_flood":
            return ("No action indicated by this pass. Radar cannot see flooding in built-up areas "
                    "or under dense vegetation — check ground reports there.")
        return "No action indicated. Re-run with other dates if cloud limited the view."
    if r["kind"] == "forest_loss":
        return ("Inspect the largest hotspots in the before/after imagery, starting with those the "
                "Hansen record also marks, to tell clearing from fire, storm damage or seasonal "
                "leaf-off before calling it deforestation.")
    if r["kind"] == "vegetation_change":
        return ("Inspect the largest patches in the before/after imagery to tell clearing from "
                "harvest, fire or cloud artefacts before drawing conclusions.")
    a = r.get("assets_in_extent") or {}
    if a.get("total"):
        return (f"Verify the {a['total']} facilities inside the extent first, then confirm the "
                "extent against ground reports or a second satellite pass.")
    return "Confirm the extent against ground reports or a second satellite pass before acting."


def build_detection_detail(r: dict[str, Any]) -> EventDetail:
    event = build_detection_event(r)
    risk_raw = r["risk"]
    risk = RiskAssessment(
        level=risk_raw["level"], complete=risk_raw["complete"], basis=risk_raw["basis"],
        explanation=risk_raw["explanation"],
        components=[RiskComponent(**c) for c in risk_raw["components"]],
    )
    statements = _statements(r, event)
    m = r["metrics"]

    uncertainty: list[dict[str, Any]] = [{
        "label": "Detected extent", "unit": "km²", "value": r["area_km2"],
        "low": r["area_low_km2"], "high": r["area_high_km2"],
        "explanation": "Re-run with stricter and looser detection thresholds (threshold sensitivity).",
    }]
    pop = r.get("population")
    if pop is not None:
        uncertainty.append({
            "label": "Population in extent", "unit": "people", "value": pop["value"],
            "low": pop["low"], "high": pop["high"], "decimals": 0,
            "explanation": " ".join(pop["notes"]),
        })
    uncertainty.append({
        "label": "Area assessed", "unit": "fraction", "value": r["valid_fraction"],
        "low": None, "high": None,
        "explanation": "Share of the area with usable data on both dates; the rest is unknown.",
    })
    if risk_raw.get("range") and risk_raw["range"]["low"] != risk_raw["range"]["high"]:
        uncertainty.append({
            "label": "Risk level", "unit": "text",
            "value": f"{risk_raw['range']['low']} to {risk_raw['range']['high']}",
            "low": None, "high": None,
            "explanation": "Levels reachable when hazard and exposure take the ends of their ranges.",
        })

    evidence = [
        EvidenceItem(role="Reference image", kind="observation", source=f"{r['sensor']} ({r['before']['platform']})",
                     timestamp=r["before"]["acquired"], version=r["before"]["scene_id"],
                     detail=_scene_detail(r["before"]) + f" Via {r['before']['provider']}."),
        EvidenceItem(role="Event image", kind="observation", source=f"{r['sensor']} ({r['after']['platform']})",
                     timestamp=r["after"]["acquired"], version=r["after"]["scene_id"],
                     detail=_scene_detail(r["after"]) + f" Via {r['after']['provider']}."),
        EvidenceItem(role="Detection model", kind="model", source=r["model"]["name"],
                     timestamp=r["created_at"], version=f"{r['model']['id']} {r['model']['version']}",
                     detail=r["model"]["method"] + " Not evaluated against labelled data in this deployment."),
        EvidenceItem(role="Processing", kind="model", source="Prithvi Drishti EO pipeline",
                     timestamp=r["created_at"], version=r["processing"]["pipeline"],
                     detail=(f"Analysis grid {r['grid']['width']}×{r['grid']['height']} px at "
                             f"{r['grid']['res_m']:.0f} m in {r['grid']['crs']}; "
                             f"{r['processing']['seconds']:.0f} s.")),
    ]
    if pop is not None:
        for p in pop["providers"]:
            evidence.append(EvidenceItem(
                role="Population", kind="dataset", source=p["name"], timestamp=r["created_at"],
                version=p["reference_period"], url=p["url"],
                detail=f"{p['resolution']}. {p['method']}. {p['license']}."))
    a = r.get("assets_in_extent")
    if a and a.get("status") == "available":
        evidence.append(EvidenceItem(
            role="Infrastructure", kind="dataset", source="OpenStreetMap (Overpass API)",
            timestamp=a.get("fetched_at"), url="https://www.openstreetmap.org/copyright",
            detail=(f"{a['total']} of {a.get('area_total', '?')} facilities in the analysis area "
                    "fall inside the detected extent (point-in-polygon).")))
    evidence.append(EvidenceItem(
        role="Risk method", kind="model", source="Hazard × exposure matrix",
        timestamp=r["created_at"], version=f"{risk_raw['method']['id']} {risk_raw['method']['version']}",
        detail=risk_raw["method"]["summary"]))

    forest = r.get("forest")
    if forest and forest["hansen"]["status"] not in ("unavailable",):
        evidence.append(EvidenceItem(
            role="Forest-loss record", kind="dataset", source="Hansen/UMD Global Forest Change",
            timestamp=r["created_at"], version=forest["hansen"]["dataset"],
            url="https://glad.earthengine.app/view/global-forest-change",
            detail="30 m annual forest-loss year, read from the public tiles. " + forest["hansen"]["note"]))
    if forest and forest["firms"]["status"] in ("detected", "not_detected"):
        evidence.append(EvidenceItem(
            role="Fire detections", kind="dataset", source="NASA FIRMS",
            timestamp=r["created_at"], version=forest["firms"]["sensor"],
            url="https://firms.modaps.eosdis.nasa.gov/", detail=forest["firms"]["note"]))

    not_available = [{"item": "Vulnerability", "reason": VULNERABILITY_UNAVAILABLE}]
    if forest and forest["firms"]["status"] in ("not_configured", "error"):
        not_available.append({"item": "Fire evidence (NASA FIRMS)", "reason": forest["firms"]["reason"]})
    if forest and forest["hansen"]["status"] == "unavailable":
        not_available.append({"item": "Forest-loss record (Hansen/UMD)",
                              "reason": forest["hansen"].get("reason") or "Could not be read."})
    if r["exposure_applicable"] and pop is None:
        not_available.append({"item": "Population exposure",
                              "reason": r.get("population_error") or "Population data unavailable."})
    not_available.extend({"item": "Method limitation", "reason": text} for text in r["model"]["limitations"])

    metrics = _metric_rows(r, m)
    observed = " ".join(s["text"] for s in statements if s["tag"] == "OBSERVED")
    return EventDetail(
        event=event, what_happened=observed,
        why_it_matters=next(s["text"] for s in statements if s["tag"] == "INFERRED"),
        risk=risk, uncertainty=uncertainty, evidence=evidence, not_available=not_available,
        history=[], statements=statements, metrics=metrics, quality_flags=r["quality_flags"],
        risk_method=risk_raw["method"], has_geometry=True,
        supporting_evidence=_supporting_evidence(r),
        hotspots=forest_evidence.hotspots(r["geometry"]) if r.get("forest") else [],
        fusion=_fusion(r),
        relationships=graph_service.describe(graph_service.build_graph(r)),
    )


def _scene_detail(scene: dict[str, Any]) -> str:
    if scene.get("clear_fraction") is not None:
        return (f"{scene['clear_fraction']:.0%} of the area cloud-free "
                f"(scene cloud cover {scene.get('cloud_cover_pct') or 0:.0f}%).")
    return (f"Relative orbit {scene.get('relative_orbit')}, {scene.get('orbit_state')}; "
            f"covers {scene.get('coverage', 0):.0%} of the area.")


def _metric_rows(r: dict[str, Any], m: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []

    def add(label: str, value: Any, unit: str = "", note: str = "") -> None:
        if isinstance(value, float):
            value = round(value, 2)
        if value is not None:
            rows.append({"label": label, "value": value, "unit": unit, "note": note})

    if r["kind"] in ("vegetation_change", "forest_loss"):
        b, a = m.get("ndvi_before_mean"), m.get("ndvi_after_mean")
        forest = r["kind"] == "forest_loss"
        if b is not None and a is not None:
            add("Mean NDVI of tree cover" if forest else "Mean NDVI of vegetated land",
                f"{b:.2f} → {a:.2f}", "", f"{(a - b) / b:+.0%} between the two dates" if b else "")
        add("Potential forest loss" if forest else "Potential vegetation loss", r["area_km2"], "km²")
        if forest:
            add("Loss on all vegetation", m.get("all_vegetation_loss_km2"), "km²",
                "Including land not mapped as tree cover")
            add("Tree cover in the area", m.get("tree_cover_km2"), "km²", "ESA WorldCover, 2021")
            hansen = (r.get("forest") or {}).get("hansen") or {}
            add("Hansen forest loss, same years", hansen.get("matching_annual_loss_km2"), "km²",
                "Independent annual record")
            add(f"Patches of {forest_evidence.HOTSPOT_MIN_KM2:g} km² or more",
                len(forest_evidence.hotspots(r["geometry"], limit=10_000)))
        add("Vegetation gain", m.get("gain_area_km2"), "km²")
        add("Scene-wide NDVI shift removed", m.get("scene_median_shift"), "",
            "Median difference between the dates, treated as seasonal/atmospheric")
    elif r["kind"] == "water_change":
        wb, wa = m.get("water_before_km2"), m.get("water_after_km2")
        add("Surface water", f"{wb:.2f} → {wa:.2f}" if wb is not None and wa is not None else None, "km²",
            f"{(wa - wb) / wb:+.0%} between the two dates" if wb else "")
        add("New surface water", r["area_km2"], "km²")
        add("Water no longer present", m.get("water_lost_km2"), "km²")
    else:
        add("Probable inundation", r["area_km2"], "km²")
        add("Water threshold (VV)", m.get("vv_threshold_db"), "dB", f"Source: {m.get('threshold_source')}")
        add("Permanent water excluded", m.get("permanent_water_km2"), "km²")
        if m.get("builtup_fraction") is not None:
            add("Built-up area excluded", f"{m['builtup_fraction']:.0%}", "", "Urban flooding is not detectable")
    add("Analysis area", r["aoi_km2"], "km²")
    return rows
