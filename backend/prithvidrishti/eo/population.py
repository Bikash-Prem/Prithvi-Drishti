"""
Population exposure.

Exposure is a spatial intersection: the population raster is summed over the
pixels that fall inside the hazard geometry — never area × average density.

Providers:
  * ``hrsl``     — Meta High Resolution Settlement Layer, ~30 m, read as
                   windowed cloud-optimised GeoTIFF; we do the zonal sum.
  * ``worldpop`` — WorldPop 2020 100 m via WorldPop's own statistics service.
                   Used over the analysis rectangle only, as an independent
                   second opinion on how many people live in the area.

The two datasets are built differently and can disagree substantially. That
disagreement is reported as dataset uncertainty; neither is validated against
a census here.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import numpy as np
import rasterio
from rasterio.features import geometry_mask
from rasterio.windows import Window, from_bounds
from rasterio.windows import transform as window_transform
from shapely.geometry import mapping

from prithvidrishti.eo import EOUnavailable
from prithvidrishti.eo.grid import GDAL_ENV
from prithvidrishti.eo.vector import bbox_polygon

HRSL_VRT = "https://dataforgood-fb-data.s3.amazonaws.com/hrsl-cogs/hrsl_general/hrsl_general-latest.vrt"
WORLDPOP_STATS = "https://api.worldpop.org/v1/services/stats"

HRSL_META = {
    "id": "hrsl", "name": "Meta High Resolution Settlement Layer (general population)",
    "provider": "Meta Data for Good / CIESIN, via AWS Open Data",
    "resolution": "1 arc-second (~30 m)", "reference_period": "latest release (2018–2020 inputs)",
    "license": "CC BY 4.0", "method": "Zonal sum of raster cells whose centre lies inside the geometry",
    "url": "https://dataforgood.facebook.com/dfg/docs/high-resolution-population-density-maps-demographic-estimates-documentation",
}
WORLDPOP_META = {
    "id": "worldpop", "name": "WorldPop global population (wpgppop)",
    "provider": "WorldPop, University of Southampton (statistics API)",
    "resolution": "3 arc-seconds (~100 m)", "reference_period": "2020",
    "license": "CC BY 4.0", "method": "Zonal sum computed by WorldPop's service over the analysis rectangle",
    "url": "https://www.worldpop.org/",
}


def zonal_sum(values: np.ndarray, transform, geometry) -> float:
    """Sum of ``values`` over cells whose centre is inside ``geometry`` (pure)."""
    if geometry is None or geometry.is_empty:
        return 0.0
    inside = geometry_mask([mapping(geometry)], out_shape=values.shape, transform=transform,
                           invert=True, all_touched=False)
    v = np.where(np.isfinite(values) & (values > 0), values, 0.0)
    return float(v[inside].sum())


def hrsl_population(geometry) -> float:
    """People inside ``geometry`` (shapely, WGS84) according to HRSL."""
    if geometry is None or geometry.is_empty:
        return 0.0
    west, south, east, north = geometry.bounds
    try:
        with rasterio.Env(**GDAL_ENV), rasterio.open(HRSL_VRT) as ds:
            win = from_bounds(west, south, east, north, transform=ds.transform)
            win = Window(int(np.floor(win.col_off)), int(np.floor(win.row_off)),
                         int(np.ceil(win.width)) + 1, int(np.ceil(win.height)) + 1)
            if win.width * win.height > 40_000_000:
                raise EOUnavailable("Area is too large for a population lookup.")
            data = ds.read(1, window=win, boundless=True, fill_value=np.nan).astype("float64")
            return zonal_sum(data, window_transform(win, ds.transform), geometry)
    except EOUnavailable:
        raise
    except Exception as exc:
        raise EOUnavailable(
            f"The HRSL population raster could not be read ({type(exc).__name__}).") from exc


def worldpop_population_bbox(bbox: dict[str, float]) -> float:
    """People inside the rectangle according to WorldPop 2020 (their service computes it)."""
    geojson = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {}, "geometry": bbox_polygon(bbox)}]}
    try:
        resp = httpx.get(WORLDPOP_STATS, timeout=60.0, params={
            "dataset": "wpgppop", "year": 2020, "geojson": json.dumps(geojson), "runasync": "false"})
        resp.raise_for_status()
        body = resp.json()
        total = (body.get("data") or {}).get("total_population")
        if body.get("error") or total is None:
            raise ValueError(body.get("error_message") or "no result")
        return float(total)
    except Exception as exc:
        raise EOUnavailable(f"WorldPop statistics service unavailable ({type(exc).__name__}).") from exc


def exposure_estimate(in_extent_hrsl: float, area_hrsl: float | None,
                      area_worldpop: float | None) -> dict[str, Any]:
    """Combine provider results into one estimate with an honest range (pure).

    The central value is HRSL inside the hazard extent (exact geometry). If
    WorldPop is available for the surrounding analysis area, the ratio of the
    two datasets there is applied to give the other end of the range — an
    inference about dataset disagreement, labelled as such.
    """
    low = high = in_extent_hrsl
    ratio = None
    notes = ["Central value: HRSL cells inside the detected extent."]
    if area_hrsl and area_worldpop and area_hrsl > 0:
        ratio = area_worldpop / area_hrsl
        scaled = in_extent_hrsl * ratio
        low, high = min(in_extent_hrsl, scaled), max(in_extent_hrsl, scaled)
        notes.append(
            f"Over the whole analysis area WorldPop counts {ratio:.2f}× the HRSL population; "
            "that ratio sets the other end of the range.")
    else:
        notes.append("Only one population dataset was available — no dataset range.")
    notes.append("Neither dataset is validated against a census here; treat as an estimate.")
    return {
        "value": round(in_extent_hrsl), "low": round(low), "high": round(high),
        "dataset_ratio_worldpop_over_hrsl": None if ratio is None else round(ratio, 3),
        "notes": notes,
    }
