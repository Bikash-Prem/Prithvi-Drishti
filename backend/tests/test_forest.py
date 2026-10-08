"""ForestGuard: forest-context detection, Hansen / FIRMS evidence, hotspots and
the place-name entry point. No network: rasters are synthetic and HTTP is faked.
"""

from __future__ import annotations

from datetime import date

import httpx
import numpy as np
import pytest
from fastapi import HTTPException

from prithvidrishti.api import routes_events
from prithvidrishti.eo import forest, pipeline
from prithvidrishti.eo.detectors import REGISTRY
from prithvidrishti.services import detection_events as det_ev
from prithvidrishti.services.analysis import AnalysisManager, steps_for
from tests.test_eo import BBOX, RES, SHAPE, _record, _veg_inputs

# ── detector ─────────────────────────────────────────────────────────


def _cleared_inputs():
    inputs = _veg_inputs()
    inputs["red_after"][50:80, 40:100] = 0.22         # 30×60 px cleared, NDVI 0.8 → ~0.2
    inputs["nir_after"][50:80, 40:100] = 0.33
    trees = np.zeros(SHAPE, bool)
    trees[:, 70:] = True                              # only the right half is forest
    inputs["tree_cover"] = trees
    return inputs


def test_forest_detector_counts_only_loss_on_tree_cover():
    det = REGISTRY["s2-forest-loss"].detect(_cleared_inputs(), RES)
    assert det.model.id == "s2-forest-loss"
    assert det.mask[65, 85] and not det.mask[65, 50]              # forest side only
    assert det.secondary["other_vegetation_loss"][65, 50]         # the rest is kept, separately
    assert not (det.mask & det.secondary["other_vegetation_loss"]).any()
    assert 700 <= det.area_px <= 900                              # 30×30 px truth on trees
    assert det.metrics["all_vegetation_loss_px"] > det.area_px
    assert det.metrics["tree_cover_fraction"] == pytest.approx(0.65, abs=0.01)
    assert det.area_low_px <= det.area_px <= det.area_high_px


def test_forest_detector_finds_nothing_where_there_are_no_trees():
    inputs = _cleared_inputs()
    inputs["tree_cover"] = np.zeros(SHAPE, bool)
    det = REGISTRY["s2-forest-loss"].detect(inputs, RES)
    assert det.area_px == 0 and det.confidence == "not_detected"
    assert det.secondary["other_vegetation_loss"].sum() > 1500    # still reported, not as forest
    assert any("tree cover" in flag for flag in det.quality_flags)


def test_forest_analysis_is_registered_with_honest_wording():
    spec = pipeline.ANALYSES["forest_loss"]
    assert spec["detector"] == "s2-forest-loss" and spec["noun"] == "potential forest loss"
    meta = REGISTRY["s2-forest-loss"].metadata.as_dict()
    assert meta["evaluation"]["status"] == "not_evaluated"
    assert "not confirmed deforestation" in meta["limitations"][0]
    assert [k for k, _ in steps_for("forest_loss")].index("context") == 5
    assert "context" not in [k for k, _ in steps_for("water_change")]


# ── Hansen ───────────────────────────────────────────────────────────


def test_hansen_tiles_are_named_by_their_top_left_corner():
    india = forest.hansen_tile_urls("lossyear", {"south": 15.1, "north": 15.4, "west": 74.5, "east": 74.8})
    assert len(india) == 1 and india[0].endswith("_lossyear_20N_070E.tif")
    amazon = forest.hansen_tile_urls("treecover2000", {"south": -3.4, "north": -3.1, "west": -60.4, "east": -60.1})
    assert amazon[0].endswith("_treecover2000_00N_070W.tif")
    south = forest.hansen_tile_urls("lossyear", {"south": -15.4, "north": -15.1, "west": 28.1, "east": 28.4})
    assert south[0].endswith("_lossyear_10S_020E.tif")
    edge = forest.hansen_tile_urls("lossyear", {"south": 19.9, "north": 20.1, "west": 79.9, "east": 80.1})
    assert len(edge) == 4                                         # an area on a tile corner needs all four


def test_hansen_years_stop_where_the_dataset_stops():
    assert forest.loss_years(date(2024, 2, 1), date(2025, 2, 1)) == ([2024, 2025], None)
    years, note = forest.loss_years(date(2025, 10, 1), date(2026, 10, 1))
    assert years == [2025] and "2026 is not covered" in note
    years, note = forest.loss_years(date(2026, 3, 1), date(2026, 9, 1))
    assert years == [] and note


def test_hansen_summary_separates_overlap_from_loss_elsewhere():
    lossyear = np.zeros((10, 10), "float32")
    canopy = np.full((10, 10), 80.0, "float32")
    lossyear[0:2, 0:5] = 25                 # 10 px lost in 2025
    lossyear[5, 5] = 12                     # an older loss: must not count
    canopy[0, 0] = 10                       # below the 30% forest baseline: must not count
    detected = np.zeros((10, 10), bool)
    detected[1, 0:3] = True
    out = forest.summarize_hansen(lossyear, canopy, detected, [2025], pixel_km2=0.01)
    assert out["status"] == "supporting"
    assert out["matching_annual_loss_km2"] == pytest.approx(0.09) and out["overlap_km2"] == pytest.approx(0.03)
    nearby = forest.summarize_hansen(lossyear, canopy, np.zeros((10, 10), bool), [2025], 0.01)
    assert nearby["status"] == "nearby_only" and nearby["overlap_km2"] == 0
    none = forest.summarize_hansen(lossyear, canopy, detected, [2020], 0.01)
    assert none["status"] == "no_matching_annual_loss"


def test_hansen_gaps_are_reported_not_filled(monkeypatch):
    grid = type("G", (), {"pixel_area_km2": 0.01})()
    out = forest.hansen_evidence(BBOX, grid, np.zeros((4, 4), bool), date(2026, 3, 1), date(2026, 9, 1))
    assert out["status"] == "not_covered" and out["matching_annual_loss_km2"] is None

    def fail(*args, **kwargs):
        raise pipeline.EOUnavailable("Satellite raster could not be read (RasterioIOError).")

    monkeypatch.setattr(forest, "read_mosaic", fail)
    out = forest.hansen_evidence(BBOX, grid, np.zeros((4, 4), bool), date(2024, 3, 1), date(2025, 3, 1))
    assert out["status"] == "unavailable" and "could not be read" in out["reason"]


# ── hotspots ─────────────────────────────────────────────────────────


def test_hotspots_are_the_largest_patches_with_centroids():
    def patch(i, area, x):
        return {"type": "Feature", "id": i, "properties": {"area_km2": area},
                "geometry": {"type": "Polygon", "coordinates": [[
                    [x, 15.0], [x + 0.02, 15.0], [x + 0.02, 15.02], [x, 15.02], [x, 15.0]]]}}

    spots = forest.hotspots({"features": [patch(0, 0.4, 74.0), patch(1, 2.5, 74.5), patch(2, 0.03, 75.0)]})
    assert [s["area_km2"] for s in spots] == [2.5, 0.4]            # sorted, 0.03 km² dropped
    assert spots[0]["longitude"] == pytest.approx(74.51) and spots[0]["latitude"] == pytest.approx(15.01)
    assert spots[0]["event_type"] == "potential_forest_loss"
    assert forest.hotspots({"features": []}) == []


# ── FIRMS ────────────────────────────────────────────────────────────

FIRMS_CSV = ("latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,"
             "version,bright_ti5,frp,daynight\n"
             "15.25,74.61,330.1,0.4,0.4,2025-03-02,0812,N20,VIIRS,n,2.0NRT,290.1,4.2,D\n"
             "bad,row\n")


def test_firms_without_a_key_says_not_configured(monkeypatch):
    monkeypatch.delenv("FIRMS_MAP_KEY", raising=False)
    out = forest.firms_evidence(BBOX, date(2025, 3, 20))
    assert out["status"] == "not_configured" and out["fire_detections"] is None
    assert "FIRMS_MAP_KEY" in out["reason"] and "do not prove" in out["note"]


def test_firms_queries_in_five_day_chunks_and_parses_rows():
    calls = []

    class Resp:
        text = FIRMS_CSV

        def raise_for_status(self):
            return None

    def fake_get(url, timeout):
        calls.append(url)
        return Resp()

    out = forest.firms_evidence(BBOX, date(2025, 3, 20), map_key="KEY", get=fake_get)
    assert len(calls) == 6 and all("/5/" in u for u in calls)      # 30 days, 5 per request
    assert calls[0].endswith("/2025-02-19") and "VIIRS_NOAA20_SP" in calls[0]   # old date → archive
    assert out["status"] == "detected" and out["fire_detections"] == 6
    assert out["detections"][0] == {"latitude": 15.25, "longitude": 74.61, "date": "2025-03-02",
                                    "confidence": "n", "frp_mw": 4.2}
    assert forest.parse_firms_csv("Invalid MAP_KEY.") == []


def test_firms_errors_never_leak_the_key():
    def boom(url, timeout):
        raise httpx.ConnectError(f"failed: {url}")

    out = forest.firms_evidence(BBOX, date(2025, 3, 20), map_key="SECRETKEY", get=boom)
    assert out["status"] == "error" and out["fire_detections"] is None
    assert "SECRETKEY" not in str(out) and "ConnectError" in out["reason"]


def test_recent_dates_use_the_near_real_time_feed():
    start, end, sensor = forest.firms_window(date(2026, 10, 3), today=date(2026, 10, 8))
    assert (end - start).days == 29 and sensor == "VIIRS_NOAA20_NRT"
    assert forest.firms_window(date(2026, 12, 1), today=date(2026, 10, 8))[1] == date(2026, 10, 8)


# ── detection → event ────────────────────────────────────────────────


def _forest_record(hansen_status="supporting", firms_status="not_configured"):
    record = _record(kind="forest_loss")
    record["metrics"] = {"ndvi_before_mean": 0.81, "ndvi_after_mean": 0.74, "tree_cover_fraction": 0.62,
                         "all_vegetation_loss_km2": 7.9, "tree_cover_km2": 348.0, "gain_area_km2": 0.3,
                         "scene_median_shift": -0.01}
    record["forest"] = {
        "hansen": {"source": "Hansen/UMD Global Forest Change", "dataset": forest.HANSEN_VERSION,
                   "years": [2025], "status": hansen_status,
                   "matching_annual_loss_km2": 3.4, "overlap_km2": 1.2 if hansen_status == "supporting" else 0.0,
                   "note": "Annual forest-loss evidence; not treated as an exact event date."},
        "firms": {"source": "NASA FIRMS", "sensor": "VIIRS_NOAA20_NRT", "status": firms_status,
                  "window": {"start": "2026-09-04", "end": "2026-10-03"},
                  "fire_detections": 14 if firms_status == "detected" else None,
                  "reason": "Set FIRMS_MAP_KEY (free from NASA FIRMS) to add fire evidence.",
                  "note": "Fire detections are supporting evidence only; they do not prove that "
                          "fire caused the vegetation change."},
        "hotspots": forest.hotspots(record["geometry"]),
        "tree_cover": {"source": "ESA WorldCover 10 m", "reference_year": 2021},
    }
    return record


def test_forest_event_states_what_the_independent_data_shows():
    detail = det_ev.build_detection_detail(_forest_record())
    assert detail.event.type == "forest_loss" and "potential forest loss" in detail.event.headline
    assert detail.event.population_exposed.status == "not_assessed"
    text = " ".join(s["text"] for s in detail.statements)
    assert "Hansen/UMD forest-change record independently marks 1.20 km² of the detected" in text
    assert "deforestation" in next(s["text"] for s in detail.statements if s["tag"] == "RECOMMENDED")
    assert [h["area_km2"] for h in detail.hotspots] == [6.2]
    sources = {row["source"].split(" (")[0]: row["status"] for row in detail.supporting_evidence}
    assert sources["Hansen/UMD Global Forest Change"] == "supporting" and sources["NASA FIRMS"] == "not_configured"
    assert any(n["item"].startswith("Fire evidence") and "FIRMS_MAP_KEY" in n["reason"]
               for n in detail.not_available)
    assert {m["label"] for m in detail.metrics} >= {"Potential forest loss", "Hansen forest loss, same years"}


def test_unsupported_detection_and_fires_are_worded_as_such():
    detail = det_ev.build_detection_detail(_forest_record("no_matching_annual_loss", "detected"))
    by_tag = {(s["tag"], s["text"][:40]) for s in detail.statements}
    assert ("UNCERTAIN", "Hansen/UMD records no forest loss here i") in by_tag
    fire = next(s["text"] for s in detail.statements if "FIRMS recorded 14" in s["text"])
    assert "does not prove that fire caused" in fire
    assert not any(n["item"].startswith("Fire evidence") for n in detail.not_available)
    assert det_ev.build_detection_detail(_record()).supporting_evidence == []     # other analyses: untouched


# ── job + place-name entry point ─────────────────────────────────────


@pytest.mark.asyncio
async def test_forest_job_reports_the_context_step(tmp_path):
    def fake_runner(kind, bbox, name, before, after, out_root, progress):
        assert kind == "forest_loss"
        for key in ("discovery", "preprocess", "detection", "vectorize"):
            progress(key, "ok", "done")
        progress("context", "partial", "Hansen: supporting; FIRMS: not configured.")
        progress("population", "skipped", "Not applicable to this analysis.")
        return _forest_record()

    async def fake_assets(key, bbox, client=None):
        return {"status": "unavailable", "reason": "OSM down"}

    manager = AnalysisManager(None, fetch_assets=fake_assets, eo_runner=fake_runner, eo_dir=tmp_path)
    job = manager.create(BBOX, "Dandeli", "forest_loss", date(2025, 2, 1), date(2026, 2, 1))
    await manager.wait(job["job_id"])
    steps = {s["key"]: s["status"] for s in job["steps"]}
    assert job["state"] == "completed" and job["type_label"] == "Forest loss (ForestGuard)"
    assert steps["context"] == "partial" and steps["population"] == "skipped"


def test_radius_becomes_a_square_area_in_degrees():
    box = routes_events.radius_bbox(15.2475, 74.6186, 10_000)
    assert box["north"] - box["south"] == pytest.approx(0.1797, abs=0.001)
    assert box["east"] - box["west"] == pytest.approx(0.1862, abs=0.001)      # wider in degrees off the equator
    assert pipeline.validate_request("forest_loss", box, date(2025, 2, 1), date(2026, 2, 1)) is None
    polar = routes_events.radius_bbox(78.0, 15.0, 30_000)
    assert "limited to 0.6°" in pipeline.validate_request("forest_loss", polar, date(2025, 2, 1), date(2026, 2, 1))


@pytest.mark.asyncio
async def test_place_resolution_accepts_coordinates_without_a_network_call():
    place = await routes_events._resolve_place("15.2475, 74.6186")
    assert place["latitude"] == 15.2475 and place["source"] == "coordinates"
    with pytest.raises(HTTPException) as err:
        await routes_events._resolve_place("95.0, 74.0")
    assert err.value.status_code == 422


# ── Sentinel-2 offset flag ───────────────────────────────────────────


def test_a_wrong_offset_flag_is_overruled_by_the_pixel_values():
    from prithvidrishti.eo import indices as ix

    rng = np.random.default_rng(3)
    without = rng.uniform(150, 2500, (60, 60)).astype("float32")      # offset already removed
    assert ix.s2_offset_present(without, False) == (True, True)       # flag says "still there": wrong
    assert ix.s2_offset_present(without + 1000, False) == (False, False)
    assert ix.s2_offset_present(without, True) == (True, False)
    assert ix.s2_offset_present(without, None) == (None, False)
    red = ix.s2_reflectance(without, ix.s2_offset_present(without, False)[0])
    assert red.min() > 0.01                                           # not clipped to zero → NDVI stays sane
    assert ix.s2_offset_present(np.full((3, 3), np.nan, "float32"), False) == (False, False)
