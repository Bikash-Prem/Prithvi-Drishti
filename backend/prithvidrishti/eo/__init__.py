"""
Earth-observation processing: discovery → aligned rasters → detection →
vectors → exposure → risk.

Layout (each module is importable and testable on its own):

  access.py      STAC search + asset signing (network)
  grid.py        analysis grid and aligned, windowed raster reads (network)
  indices.py     spectral indices and masks (pure numpy)
  detectors.py   detector interface, registry and the three baselines (pure)
  vector.py      mask → polygons, areas, point-in-extent (pure)
  population.py  population providers (network) + zonal sums (pure)
  risk.py        hazard / exposure / vulnerability → risk (pure)
  render.py      PNG overlays for the map (pure)
  pipeline.py    orchestration for one analysis job
  repository.py  detection persistence (SQLite)

Raster IO is synchronous (GDAL); callers run it in a worker thread.
Nothing here fabricates a value: a step that cannot run raises
``EOUnavailable`` with a user-facing reason.
"""


class EOUnavailable(Exception):
    """A required input or provider could not be obtained. Message is user-facing."""
