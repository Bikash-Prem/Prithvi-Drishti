"""Earth-observation pipeline: detectors on synthetic scenes with known truth,
geometry/area maths, population intersection, the risk framework, storage and
the detection → event mapping. No network: every raster here is synthetic.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

import numpy as np
import pytest
from affine import Affine
from shapely.geometry import box

from prithvidrishti.eo import indices as ix
from prithvidrishti.eo import pipeline, population, risk, vector
from prithvidrishti.eo.detectors import REGISTRY, list_models, min_patch_pixels
from prithvidrishti.eo.grid import display_grid, make_grid, slope_degrees, utm_epsg
from prithvidrishti.eo.repository import DetectionRepository
from prithvidrishti.services import detection_events as det_ev
from prithvidrishti.services.analysis import AnalysisManager
from prithvidrishti.services.report import build_report

BBOX = {"south": 27.6, "north": 27.8, "west": 85.2, "east": 85.45}
RES = 10.0
SHAPE = (200, 200)


# ── indices ──────────────────────────────────────────────────────────


def test_indices_and_reflectance():
    red, nir = np.array([[0.05, 0.2, 0.0]]), np.array([[0.45, 0.2, 0.0]])
    out = ix.ndvi(red, nir)
    assert out[0, 0] == pytest.approx(0.8) and out[0, 1] == pytest.approx(0.0)
    assert np.isnan(out[0, 2])                       # 0/0 is unknown, not 0
    dn = np.array([[1000.0, 3000.0]])
    assert ix.s2_reflectance(dn, False)[0].tolist() == pytest.approx([0.0, 0.2])   # offset removed
    assert ix.s2_reflectance(dn, True)[0].tolist() == pytest.approx([0.1, 0.3])    # already removed
    assert ix.scl_clear(np.array([[4, 5, 6, 7, 3, 8, 9, 10, 0, np.nan]])).tolist() == [
        [True, True, True, True, False, False, False, False, False, False]]


def test_otsu_separates_two_modes_and_flags_one_mode():
    rng = np.random.default_rng(0)
    bimodal = np.concatenate([rng.normal(-20, 1, 4000), rng.normal(-8, 1.5, 16000)])
    t, sep = ix.otsu_threshold(bimodal, -30, 0)
    assert -17 < t < -11 and sep > 0.8
    _, sep_uni = ix.otsu_threshold(rng.normal(-8, 1.5, 20000), -30, 0)
    assert sep_uni < 0.7 and sep_uni < sep
    assert np.isnan(ix.otsu_threshold(np.array([1.0]), -30, 0)[0])


def test_clean_mask_drops_specks_and_boxcar_ignores_nan():
    mask = np.zeros((40, 40), bool)
    mask[5:20, 5:20] = True
    mask[30, 30] = True
    out = ix.clean_mask(mask, min_pixels=20)
    assert out[10, 10] and not out[30, 30]
    img = np.full((9, 9), 2.0)
    img[4, 4] = np.nan
    smooth = ix.boxcar(img, 3)
    assert np.isnan(smooth[4, 4]) and smooth[3, 3] == pytest.approx(2.0)


# ── detectors on scenes with known truth ─────────────────────────────


def _s2_scene(ndvi_value=0.8):
    nir = np.full(SHAPE, 0.45, "float32")
    red = (nir * (1 - ndvi_value) / (1 + ndvi_value)).astype("float32")
    return red, nir


def _veg_inputs(shift=0.0):
    rng = np.random.default_rng(1)
    red_b, nir_b = _s2_scene()
    red_a, nir_a = _s2_scene()
    red_a = red_a + rng.normal(0, 0.004, SHAPE).astype("float32") + shift
    clear = np.ones(SHAPE, bool)
    return {"red_before": red_b, "nir_before": nir_b, "clear_before": clear,
            "red_after": red_a, "nir_after": nir_a, "clear_after": clear.copy()}


def test_ndvi_detector_finds_a_cleared_patch_and_reports_a_range():
    inputs = _veg_inputs()
    inputs["red_after"][50:80, 60:90] = 0.22          # 30×30 px cleared: NDVI 0.8 → ~0.2
    inputs["nir_after"][50:80, 60:90] = 0.33
    det = REGISTRY["s2-ndvi-change"].detect(inputs, RES)
    assert 780 <= det.area_px <= 900                  # 900 px truth, opening trims the rim
    assert det.mask[65, 75] and not det.mask[150, 150]
    assert det.area_low_px <= det.area_px <= det.area_high_px
    assert det.confidence == "high" and det.quality_flags == []
    assert det.metrics["ndvi_before_mean"] == pytest.approx(0.8, abs=0.01)


def test_scene_wide_shift_is_not_reported_as_change():
    # Every pixel a little less green (season / atmosphere): no local event.
    det = REGISTRY["s2-ndvi-change"].detect(_veg_inputs(shift=0.03), RES)
    assert det.area_px == 0 and det.confidence == "not_detected"
    assert det.metrics["scene_median_shift"] < -0.05


def test_cloud_on_either_date_is_unknown_not_change():
    inputs = _veg_inputs()
    inputs["red_after"][50:80, 60:90] = 0.22
    inputs["nir_after"][50:80, 60:90] = 0.33
    inputs["clear_after"][:, :100] = False            # half the scene clouded, incl. the patch
    det = REGISTRY["s2-ndvi-change"].detect(inputs, RES)
    assert det.area_px == 0 and det.valid_fraction == pytest.approx(0.5)


def test_low_valid_fraction_downgrades_confidence_to_uncertain():
    inputs = _veg_inputs()
    inputs["red_after"][150:180, 150:180] = 0.22
    inputs["nir_after"][150:180, 150:180] = 0.33
    inputs["clear_before"][:90, :] = False            # 55% usable
    det = REGISTRY["s2-ndvi-change"].detect(inputs, RES)
    assert det.area_px > 0 and det.confidence == "uncertain"
    assert any("cloud-free" in f for f in det.quality_flags)


def _water_inputs():
    land = {"green": 0.08, "nir": 0.30, "swir": 0.20}
    out = {}
    for tag in ("before", "after"):
        for band, v in land.items():
            out[f"{band}_{tag}"] = np.full(SHAPE, v, "float32")
        out[f"clear_{tag}"] = np.ones(SHAPE, bool)
    for tag in ("before", "after"):                    # a river present on both dates
        out[f"green_{tag}"][:, 20:26], out[f"nir_{tag}"][:, 20:26], out[f"swir_{tag}"][:, 20:26] = 0.07, 0.03, 0.01
    out["green_after"][100:140, 100:150], out["nir_after"][100:140, 100:150] = 0.07, 0.03
    out["swir_after"][100:140, 100:150] = 0.01         # 40×50 px newly flooded
    return out


def test_water_detector_reports_new_water_not_the_existing_river():
    inputs = _water_inputs()
    inputs["slope"] = np.zeros(SHAPE, "float32")
    det = REGISTRY["s2-water-change"].detect(inputs, RES)
    assert 1800 <= det.area_px <= 2000 and det.mask[120, 125]
    assert not det.mask[50, 22]                        # river: water before and after
    assert det.metrics["water_before_px"] == 200 * 6
    assert det.confidence == "high"

    steep = _water_inputs()
    steep["slope"] = np.full(SHAPE, 30.0, "float32")   # "water" on a mountainside = shadow
    assert REGISTRY["s2-water-change"].detect(steep, RES).area_px == 0

    no_dem = REGISTRY["s2-water-change"].detect(_water_inputs(), RES)
    assert no_dem.confidence == "uncertain" and any("elevation" in f for f in no_dem.quality_flags)


def _sar_inputs():
    rng = np.random.default_rng(2)
    speckle = lambda: rng.gamma(4.0, 0.25, SHAPE).astype("float32")   # noqa: E731  4-look speckle
    land_vv, land_vh, water_vv, water_vh = 0.16, 0.035, 0.008, 0.002  # −8 / −14.5 / −21 / −27 dB
    out = {}
    for tag in ("before", "after"):
        out[f"vv_{tag}"] = land_vv * speckle()
        out[f"vh_{tag}"] = land_vh * speckle()
        out[f"vv_{tag}"][:, 10:30] = water_vv * speckle()[:, 10:30]     # permanent lake, both dates
        out[f"vh_{tag}"][:, 10:30] = water_vh * speckle()[:, 10:30]
    for rows, cols in (((60, 110), (80, 150)), ((150, 190), (150, 190))):  # two flooded fields
        out["vv_after"][rows[0]:rows[1], cols[0]:cols[1]] = (water_vv * speckle())[rows[0]:rows[1], cols[0]:cols[1]]
        out["vh_after"][rows[0]:rows[1], cols[0]:cols[1]] = (water_vh * speckle())[rows[0]:rows[1], cols[0]:cols[1]]
    occurrence = np.zeros(SHAPE, "float32")
    occurrence[:, 10:30] = 95.0
    return out, occurrence


def test_sar_detector_separates_flood_from_permanent_water_urban_and_slopes():
    inputs, occurrence = _sar_inputs()
    builtup = np.zeros(SHAPE, bool)
    builtup[150:190, 150:190] = True                   # second flooded field is "urban"
    slope = np.zeros(SHAPE, "float32")
    det = REGISTRY["s1-flood-change"].detect(
        {**inputs, "permanent_water": occurrence, "slope": slope, "builtup": builtup}, RES)
    truth = 50 * 70
    assert 0.85 * truth <= det.area_px <= 1.05 * truth
    assert det.mask[85, 115]                           # flooded field
    assert not det.mask[100, 20]                       # permanent lake
    assert not det.mask[170, 170]                      # built-up: excluded, and said so
    assert any("built-up" in f for f in det.quality_flags)
    assert det.metrics["threshold_source"] == "otsu" and -22 <= det.metrics["vv_threshold_db"] <= -13
    assert det.confidence == "high" and det.metrics["vh_agreement"] > 0.7
    assert det.area_low_px <= det.area_px <= det.area_high_px

    steep = np.full(SHAPE, 20.0, "float32")
    masked = REGISTRY["s1-flood-change"].detect(
        {**inputs, "permanent_water": occurrence, "slope": steep, "builtup": builtup}, RES)
    assert masked.area_px == 0


def test_sar_detector_without_ancillary_data_says_what_it_could_not_control():
    inputs, _ = _sar_inputs()
    det = REGISTRY["s1-flood-change"].detect(inputs, RES)
    assert det.area_px > 0 and det.confidence == "uncertain"
    flags = " ".join(det.quality_flags)
    assert "permanent-water" in flags and "elevation" in flags and "land-cover" in flags
    assert not det.mask[100, 20]                       # lake still excluded via the reference image


def test_sar_detector_finds_nothing_when_nothing_changed():
    inputs, occurrence = _sar_inputs()
    inputs["vv_after"], inputs["vh_after"] = inputs["vv_before"].copy(), inputs["vh_before"].copy()
    det = REGISTRY["s1-flood-change"].detect({**inputs, "permanent_water": occurrence}, RES)
    assert det.area_px == 0 and det.confidence == "not_detected"


def test_model_registry_is_explicit_about_evaluation():
    models = list_models()
    assert {m["id"] for m in models} == {"s2-ndvi-change", "s2-forest-loss", "s2-water-change",
                                         "s1-flood-change"}
    for m in models:
        assert m["version"] and m["limitations"] and m["parameters"]
        assert m["kind"] == "baseline" and m["evaluation"]["status"] == "not_evaluated"
    assert min_patch_pixels(10) == 50 and min_patch_pixels(30) == 6 and min_patch_pixels(100) == 4


# ── grid / vectors / areas ───────────────────────────────────────────


def test_grid_is_metric_utm_and_respects_the_pixel_budget():
    assert utm_epsg(27.7, 85.3) == "EPSG:32645" and utm_epsg(-33.9, 151.2) == "EPSG:32756"
    grid = make_grid(BBOX)
    assert grid.crs == "EPSG:32645" and grid.res_m % 10 == 0
    assert grid.width * grid.height <= 1_400_000 * 1.05
    km2 = grid.width * grid.height * grid.pixel_area_km2
    assert 520 < km2 < 600                              # 0.25° × 0.2° at 27.7°N ≈ 546 km²
    small = make_grid({"south": 27.70, "north": 27.72, "west": 85.30, "east": 85.32})
    assert small.res_m == 10.0
    disp = display_grid(BBOX, 900)
    assert disp.crs == "EPSG:3857" and max(disp.width, disp.height) == 900


def test_polygon_area_matches_pixel_area_and_points_are_tested_spatially():
    grid = make_grid(BBOX)
    mask = np.zeros(grid.shape, bool)
    mask[100:140, 200:260] = True
    fc = vector.mask_to_polygons(mask, grid.transform, grid.crs, grid.res_m)
    expected = 40 * 60 * grid.pixel_area_km2
    assert fc["patch_count"] == 1 and fc["features"][0]["properties"]["area_km2"] == pytest.approx(expected, rel=1e-3)
    extent = vector.union_geometry(fc)
    w, s, e, n = extent.bounds
    assert BBOX["west"] < w < e < BBOX["east"] and BBOX["south"] < s < n < BBOX["north"]
    points = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"asset_type": "hospital"},
         "geometry": {"type": "Point", "coordinates": [(w + e) / 2, (s + n) / 2]}},
        {"type": "Feature", "properties": {"asset_type": "school"},
         "geometry": {"type": "Point", "coordinates": [BBOX["west"] + 0.001, BBOX["south"] + 0.001]}},
    ]}
    inside = vector.points_inside(points, extent)
    assert [f["properties"]["asset_type"] for f in inside["features"]] == ["hospital"]
    assert vector.points_inside(points, None)["features"] == []
    empty = vector.mask_to_polygons(np.zeros((5, 5), bool), grid.transform, grid.crs, grid.res_m)
    assert empty["features"] == [] and vector.union_geometry(empty) is None


def test_slope_from_a_tilted_plane():
    dem = np.tile(np.arange(50, dtype="float32") * 10.0, (50, 1))   # rises 10 m per 10 m cell
    assert slope_degrees(dem, 10.0)[25, 25] == pytest.approx(45.0, abs=0.1)
    assert slope_degrees(np.zeros((10, 10), "float32"), 30.0).max() == 0.0


# ── population ───────────────────────────────────────────────────────


def test_population_is_summed_inside_the_geometry_only():
    # 10×10 cells of 0.01°, 5 people each (500 total); hazard covers the left 4 columns.
    values = np.full((10, 10), 5.0)
    values[0, 0] = np.nan                                # no-data cell is skipped, not counted
    transform = Affine(0.01, 0, 85.0, 0, -0.01, 28.0)
    hazard = box(85.0, 27.9, 85.04, 28.0)
    assert population.zonal_sum(values, transform, hazard) == pytest.approx(4 * 10 * 5 - 5)
    assert population.zonal_sum(values, transform, None) == 0.0
    # NOT area × mean density: an uneven raster gives a different answer.
    uneven = np.zeros((10, 10))
    uneven[:, 9] = 50.0                                  # everyone lives in the far column
    assert population.zonal_sum(uneven, transform, hazard) == 0.0


def test_exposure_range_comes_from_dataset_disagreement():
    est = population.exposure_estimate(1000.0, area_hrsl=50_000.0, area_worldpop=65_000.0)
    assert (est["value"], est["low"], est["high"]) == (1000, 1000, 1300)
    assert est["dataset_ratio_worldpop_over_hrsl"] == 1.3
    single = population.exposure_estimate(1000.0, 50_000.0, None)
    assert single["low"] == single["high"] == 1000 and "Only one" in " ".join(single["notes"])


# ── risk ─────────────────────────────────────────────────────────────


def test_risk_bands_matrix_and_unknown_vulnerability():
    assert [risk.hazard_level(a) for a in (0.1, 0.5, 5, 25)] == [0, 1, 2, 3]
    assert risk.exposure_level(50, None) == (0, False)
    assert risk.exposure_level(50, {"hospital": 1}) == (1, True)
    assert risk.exposure_level(20_000, {"hospital": 2}) == (3, True)
    assert risk.combine(3, 3) == 3 and risk.combine(2, 3) == 3 and risk.combine(0, 3) == 2

    a = risk.assess(detected=True, area_km2=6.0, area_low=0.3, area_high=9.0, confidence="probable",
                    population={"value": 4200, "low": 4200, "high": 5600},
                    assets={"status": "available", "counts": {"school": 3}})
    by = {c["name"]: c for c in a["components"]}
    assert a["level"] == "high" and a["complete"] is False
    assert by["hazard"]["label"] == "HIGH" and by["exposure"]["label"] == "HIGH"
    assert by["vulnerability"]["label"] == "UNKNOWN" and by["vulnerability"]["score"] is None
    assert a["range"] == {"low": "medium", "high": "high"}        # the low end of the extent is two bands down
    assert "Vulnerability is unknown" in a["explanation"]


def test_risk_without_population_or_detection_is_stated_not_scored():
    no_pop = risk.assess(detected=True, area_km2=6.0, area_low=5.5, area_high=7.0, confidence="high",
                         population=None, assets=None)
    assert no_pop["basis"] == "hazard only"
    assert next(c for c in no_pop["components"] if c["name"] == "exposure")["score"] is None
    none = risk.assess(detected=False, area_km2=0, area_low=0, area_high=0, confidence="not_detected",
                       population=None, assets=None)
    assert none["level"] == "low" and none["complete"] is True and none["basis"] == "nothing detected"
    veg = risk.assess(detected=True, area_km2=1.2, area_low=0.4, area_high=2.0, confidence="high",
                      population=None, assets=None, exposure_applicable=False)
    assert next(c for c in veg["components"] if c["name"] == "exposure")["label"] == "NOT APPLICABLE"


# ── requests, storage, events, jobs, report ──────────────────────────


def test_request_validation_and_default_dates():
    today = datetime.now(UTC).date()
    ok_before, ok_after = today - timedelta(days=60), today - timedelta(days=10)
    assert pipeline.validate_request("sar_flood", BBOX, ok_before, ok_after) is None
    big = {"south": 27, "north": 28, "west": 85, "east": 85.5}
    assert "limited to" in pipeline.validate_request("sar_flood", big, ok_before, ok_after)
    assert "future" in pipeline.validate_request("sar_flood", BBOX, ok_before, today + timedelta(days=2))
    assert "earlier" in pipeline.validate_request("sar_flood", BBOX, ok_after, ok_before)
    assert pipeline.validate_request("nope", BBOX, ok_before, ok_after) == "Unknown analysis type."
    before, after = pipeline.default_dates("vegetation_change", date(2026, 10, 8))
    assert (after - before).days == 365 and after == date(2026, 10, 3)   # same season, a year apart


def _record(detected=True, kind="sar_flood"):
    spec = pipeline.ANALYSES[kind]
    geometry = {"type": "FeatureCollection", "truncated": False, "patch_count": 1 if detected else 0,
                "features": [{"type": "Feature", "id": 0, "properties": {"area_km2": 6.2},
                              "geometry": {"type": "Polygon", "coordinates": [[
                                  [85.30, 27.68], [85.34, 27.68], [85.34, 27.71], [85.30, 27.71], [85.30, 27.68]]]}}]
                if detected else []}
    now = datetime.now(UTC)
    scene = lambda days: {"scene_id": f"S1_{days}", "collection": "sentinel-1-rtc",          # noqa: E731
                          "provider": "Microsoft Planetary Computer", "platform": "sentinel-1d",
                          "acquired": (now - timedelta(days=days)).isoformat(), "cloud_cover_pct": None,
                          "orbit_state": "ascending", "relative_orbit": 85, "coverage": 1.0, "slices": 1}
    record = {
        "id": "det-0123456789", "kind": kind, "event_type": spec["event_type"], "name": "Test <b>area</b>",
        "label": spec["label"], "noun": spec["noun"], "bbox": BBOX, "created_at": now.isoformat(),
        "before": scene(30), "after": scene(3), "sensor": spec["sensor"],
        "model": REGISTRY[spec["detector"]].metadata.as_dict(),
        "grid": {"crs": "EPSG:32645", "res_m": 30.0, "width": 832, "height": 750},
        "detected": detected, "confidence": "probable" if detected else "not_detected",
        "confidence_reasons": ["Mean VV drop 6.1 dB."], "quality_flags": ["7% built-up excluded."],
        "valid_fraction": 0.97, "area_km2": 6.2 if detected else 0.0,
        "area_low_km2": 4.1 if detected else 0.0, "area_high_km2": 8.4 if detected else 0.0,
        "aoi_km2": 561.6, "metrics": {"vv_threshold_db": -16.4, "threshold_source": "otsu",
                                      "permanent_water_km2": 2.1, "builtup_fraction": 0.07},
        "geometry": geometry, "secondary": {},
        "overlays": [{"id": "before", "label": "b", "date": None, "file": "before.png"}],
        "population": ({"value": 4200, "low": 4200, "high": 5600, "notes": ["n1"],
                        "dataset_ratio_worldpop_over_hrsl": 1.33,
                        "area_population": {"hrsl": 5_000_000, "worldpop": 6_650_000},
                        "providers": [population.HRSL_META, population.WORLDPOP_META]} if spec["exposure"] else None),
        "population_error": None, "exposure_applicable": bool(spec["exposure"]),
        "processing": {"pipeline": pipeline.PIPELINE_VERSION, "seconds": 80.0},
    }
    assets = {"status": "available", "total": 2, "fetched_at": now.isoformat(), "source": "OSM",
              "geojson": {"type": "FeatureCollection", "features": [
                  {"type": "Feature", "properties": {"asset_type": "hospital"},
                   "geometry": {"type": "Point", "coordinates": [85.32, 27.70]}},
                  {"type": "Feature", "properties": {"asset_type": "school"},
                   "geometry": {"type": "Point", "coordinates": [85.40, 27.75]}}]}}
    return pipeline.finalize(record, assets if detected else None)


def test_finalize_counts_only_facilities_inside_the_extent():
    r = _record()
    assert r["assets_in_extent"]["total"] == 1 and r["assets_in_extent"]["counts"] == {"hospital": 1}
    assert r["assets_in_extent"]["area_total"] == 2
    # 6.2 km² → hazard HIGH; 4,200 people → exposure HIGH, raised to CRITICAL by the hospital.
    assert r["risk"]["level"] == "critical"


def test_detection_event_carries_measured_values_with_ranges():
    detail = det_ev.build_detection_detail(_record())
    e = detail.event
    assert e.kind == "detected" and e.type == "flood" and e.data_status == "live" and e.status == "active"
    assert (e.affected_area_km2.value, e.affected_area_km2.low, e.affected_area_km2.high) == (6.2, 4.1, 8.4)
    assert (e.population_exposed.value, e.population_exposed.high) == (4200, 5600)
    assert e.assets_exposed.value == 1 and e.confidence.label == "Probable" and e.confidence.value is None
    tags = [s["tag"] for s in detail.statements]
    assert tags[0] == "OBSERVED" and {"OBSERVED", "INFERRED", "UNCERTAIN", "RECOMMENDED"} <= set(tags)
    assert any(x.role == "Detection model" and "s1-flood-change 1.0.0" in x.version for x in detail.evidence)
    assert {x.role for x in detail.evidence} >= {"Reference image", "Event image", "Population", "Infrastructure", "Risk method"}
    assert any(n["item"] == "Vulnerability" for n in detail.not_available)
    assert detail.risk_method["id"] == "risk-matrix" and detail.has_geometry


def test_nothing_detected_and_vegetation_events_are_worded_honestly():
    none = det_ev.build_detection_detail(_record(detected=False))
    assert none.event.headline == "No probable inundation detected" and none.event.severity == "low"
    assert none.event.affected_area_km2.value == 0.0
    assert "shows no probable inundation" in none.statements[0]["text"]
    veg = det_ev.build_detection_detail(_record(kind="vegetation_change"))
    assert veg.event.type == "vegetation_change" and veg.event.population_exposed.status == "not_assessed"
    text = " ".join(s["text"] for s in veg.statements) + veg.event.headline
    assert "potential vegetation loss" in text and "deforestation" not in text.lower()


def test_dashboard_kpis_name_the_largest_event_instead_of_summing():
    from prithvidrishti.services import events as ev

    flood = det_ev.build_detection_event(_record())
    other = _record()
    other.update(id="det-aaaaaaaaaa", name="Second area")
    other["population"] = {**other["population"], "value": 900, "low": 900, "high": 1200}
    second = det_ev.build_detection_event(other)
    veg = det_ev.build_detection_event({**_record(kind="vegetation_change"), "id": "det-bbbbbbbbbb"})
    summary = ev.summarize([flood, second, veg])
    assert summary["detections"] == 3 and summary["by_type"] == {"flood": 2, "vegetation_change": 1}
    pop = summary["population_exposed"]
    assert pop["value"] == 4200 and pop["high"] == 5600          # the larger event, not 4200 + 900
    assert "Test <b>area</b>" in pop["source"] and "Largest single event" in pop["source"]
    assert summary["affected_area_km2"]["value"] == 6.2            # vegetation extent is not mixed in


def test_repository_roundtrip_and_path_safety(tmp_path):
    repo = DetectionRepository(tmp_path)
    repo.init()
    record = _record()
    repo.save(record)
    assert [r["id"] for r in DetectionRepository(tmp_path).load_all()] == [record["id"]]
    (tmp_path / record["id"]).mkdir()
    (tmp_path / record["id"] / "before.png").write_bytes(b"\x89PNG")
    assert repo.image_path(record["id"], "before.png").name == "before.png"
    assert repo.image_path(record["id"], "missing.png") is None
    assert repo.image_path("../secrets", "before.png") is None
    assert repo.image_path(record["id"], "../detections.sqlite3") is None
    assert repo.image_path(record["id"], "a.txt") is None


@pytest.mark.asyncio
async def test_satellite_job_reports_steps_and_stores_the_detection(tmp_path):
    stored = []

    def fake_runner(kind, bbox, name, before, after, out_root, progress):
        for key in ("discovery", "preprocess", "detection", "vectorize", "population"):
            progress(key, "ok", f"{key} done")
        return _record()

    async def fake_assets(key, bbox, client=None):
        return {"status": "available", "total": 1, "fetched_at": "t", "source": "OSM",
                "geojson": {"type": "FeatureCollection", "features": [
                    {"type": "Feature", "properties": {"asset_type": "hospital"},
                     "geometry": {"type": "Point", "coordinates": [85.32, 27.70]}}]}}

    async def on_detection(record):
        stored.append(record["id"])

    manager = AnalysisManager(None, on_detection=on_detection, fetch_assets=fake_assets,
                              eo_runner=fake_runner, eo_dir=tmp_path)
    job = manager.create(BBOX, "Test", "sar_flood", date(2026, 8, 1), date(2026, 8, 29))
    await manager.wait(job["job_id"])
    assert job["state"] == "completed" and job["event_id"] == "det-0123456789" and stored == ["det-0123456789"]
    steps = {s["key"]: s["status"] for s in job["steps"]}
    assert steps == {"aoi": "ok", "discovery": "ok", "preprocess": "ok", "detection": "ok", "vectorize": "ok",
                     "population": "ok", "infrastructure": "ok", "risk": "partial"}


@pytest.mark.asyncio
async def test_satellite_job_fails_with_the_providers_reason(tmp_path):
    from prithvidrishti.eo import EOUnavailable

    def cloudy(kind, bbox, name, before, after, out_root, progress):
        progress("discovery", "running", "Searching…")
        raise EOUnavailable("No sufficiently cloud-free Sentinel-2 image within 25 days of 28 Sep 2026.")

    manager = AnalysisManager(None, eo_runner=cloudy, eo_dir=tmp_path)
    job = manager.create(BBOX, "Cloudy", "water_change", date(2026, 6, 5), date(2026, 9, 28))
    await manager.wait(job["job_id"])
    assert job["state"] == "failed" and "cloud-free" in job["error"] and job["event_id"] is None
    steps = {s["key"]: s["status"] for s in job["steps"]}
    assert steps["discovery"] == "failed" and steps["detection"] == "skipped"


def test_report_is_built_from_the_record_and_escapes_it():
    html = build_report(det_ev.build_detection_detail(_record()))
    assert "Test &lt;b&gt;area&lt;/b&gt;" in html and "<b>area</b>" not in html
    for needle in ("OBSERVED", "RECOMMENDED", "6.20 km²", "range 4.10–8.40", "4,200", "UNKNOWN",
                   "s1-flood-change 1.0.0", "Hazard bands", "Not available / limitations"):
        assert needle in html, needle
