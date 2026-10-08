# Prithvi Drishti — Engineering Guide (CLAUDE.md)

Production-grade multi-agent flood monitoring, prediction, and disaster-response
platform. Event-driven agents over a 7-phase LangGraph orchestrator, surfaced on
a landing page (GSAP + Three.js) and a MapLibre operations dashboard.

**Stack:** Python 3.12 · FastAPI · LangGraph · Pydantic v2 · provider-agnostic LLM
(Anthropic `claude-opus-4-8` or Gemini) · Vite + MapLibre GL + GSAP + Three.js (frontend).

---

## Run it

The system boots and demos **with no API key** (deterministic mock fallbacks).

```bash
# Backend
cd backend
pip install -r requirements.txt          # fastapi, langgraph, pydantic, uvicorn, anthropic/google-genai (optional)
uvicorn prithvidrishti.api.app:create_app --factory --reload --port 8000

# Frontend
cd frontend
npm install && npm run dev               # http://localhost:5173 (landing) · /dashboard.html (ops deck)

# Tests (fully offline)
cd backend && python -m pytest tests -q
```

Add an LLM later by setting `ANTHROPIC_API_KEY` (or `GOOGLE_GENAI_API_KEY`) and
`PRITHVIDRISHTI_LLM_PROVIDER=anthropic|gemini|auto` in `.env` (see `.env.example`).
With no key, `FloodLLMClient.available()` is `False` and all reasoning helpers
return their deterministic mock values.

Trigger the full pipeline for a demo: `POST /api/v1/flood/simulate`.

**One-command run (Docker):** `docker compose up` (or `make up`) starts backend
:8000 + frontend :5173. The lean image runs with no keys; build the semantic-memory
variant with `docker compose build --build-arg INCLUDE_ML=true backend`.

---

## v12 — Landsat 8 model, Inter font, six-scene landing

- Landing satellite is NASA's public **Landsat 8** model (`public/models/landsat8.glb`,
  Draco) — an Earth-imaging satellite — replacing Sentinel-6. Type is **Inter**
  (landing + dashboard). The dashboard-screenshot frame was removed; the showcase is
  the Koshi Barrage (Nepal) result and is labelled as such. Landing has six scenes.
  Karnataka is only partly integrated (basin topologies in `config.py`; no Karnataka
  detection is shown on the landing page).

## v11 — OrbitGuard backend merged, light dashboard, real satellite model, dead code removed

**Older sections below describe the history; where they mention things this
section says were removed, this section wins.**

- **Merged from the `orbitguard` backend prototype** (the second zip,
  `ORBITGUARD-2`, held only an installed virtualenv — nothing to merge):
  - *Evidence fusion* (`eo/forest.fuse`): corroboration `stronger | supporting |
    limited` = how many independent forest datasets (tree-cover map, Hansen)
    agree. A count, never a probability; fire is never counted as support.
  - *Protected areas* (`eo/forest.protected_areas`): OSM `protected_area` /
    `national_park` / `nature_reserve` polygons that the detected patches
    overlap (Overpass `out geom`, plus `is_in` for areas enclosing the whole
    AOI; a 200 with a `remark` error counts as unavailable). Not an
    authoritative inventory, and says so.
  - *Knowledge graph* (`services/graph.py`, `GET /events/{id}/graph`): fixed
    vocabulary `LOCATED_AT, HAS_RISK, HAS_EVIDENCE_SOURCE, SUPPORTED_BY,
    POSSIBLY_ASSOCIATED_WITH, HAS_SPATIAL_CONTEXT, NEAR_OR_WITHIN`, derived
    from the stored record so it always works; shown as "Relationships" in
    the detail panel.
  - *Optional stores, both off by default and unit-tested against fakes only
    (no database was available to run them against):* `NEO4J_ENABLED` mirrors
    the graph (labels/types whitelisted, relationships only);
    `POSTGIS_ENABLED` + `POSTGIS_DSN` mirrors every detection with its extent
    as `geography` (`eo/postgis_store.py`, `backend/migrations/001_postgis.sql`).
    Drivers in `requirements-data.txt`; `docker compose --profile data up`
    starts both (passwords must be set in `.env`). A mirror failure is logged
    by exception type only and never fails an analysis. SQLite stays the store
    of record.
  - *Deliberately not merged:* the 0–100 weighted "MVP risk score" and its
    demo population/infrastructure fallbacks (they produce numbers this
    platform refuses to invent), the OpenAI analyst, the mock incidents, the
    static frontend and its stock images (unknown licence).
- **Dashboard theme:** same light palette and font as the landing page
  (variables at the top of `app.css`); primary buttons are ink, accent is mint.
- **Landing:** the satellite is NASA's public Sentinel-6 3D model
  (`public/models/satellite.glb`, Draco decoder in `public/draco/`, lit by a
  `RoomEnvironment` map); the procedural satellite is only the load-failure
  fallback. No link on the page leaves the site (footer Data/API columns and
  outbound source links removed).
- **Removed as unused:** the pre-v7 dashboard (`src/main.js`, `state.js`,
  `style.css`, `mockData.js`, `auth.js`, `toast.js`, `panels/`, `map/`,
  `ensemble/`, `timeline/`, `scenarios/` and their tests) with the deck.gl and
  Google Maps packages; the seeded demo routes `/map/*`, `/ensemble/*`,
  `/timeline/*`, `/scenario/*` (now 404); connector stubs nothing imported
  (`dartmouth, ecmwf, glims, hydrosheds, noaa, sentinel_hub, soil_moisture,
  usgs, worldpop`), `main.py`, `auth/workspace.py`, `models/scenario.py`,
  `requirements-geo.txt`; three early prototype files at the repo root.
  Still present and still seeded: the urban and disease agents.
- Tests: `backend/tests/test_graph_stores.py`.

## v10 — ForestGuard merged in (forest loss with independent evidence)

Ported from the `orbitguardAi` prototype (Google Earth Engine) onto the keyless
EO pipeline; its scientific rules are kept (an NDVI drop is *potential* forest
loss, Hansen's year is annual context, a fire is not proof of cause).

- **Analysis type `forest_loss`** ("Forest loss (ForestGuard)", event type
  `forest_loss`): detector **`s2-forest-loss`** = `s2-ndvi-change` restricted to
  mapped tree cover (ESA WorldCover classes 10 + 95, required input — the job
  fails if it cannot be read). Loss on other vegetation is kept as a secondary
  mask and metric, never counted as forest.
- **`eo/forest.py`**: Hansen/UMD Global Forest Change `GFC-2025-v1.13` read
  straight from the public GCS tiles (`lossyear`, `treecover2000` ≥ 30 %;
  statuses `supporting | nearby_only | no_matching_annual_loss | not_covered |
  unavailable`; the dataset ends in 2025 and says so); **NASA FIRMS** fire
  detections for the 30 days before the event image, only when
  `FIRMS_MAP_KEY` is set (else `not_configured`; the key is in the request
  path, so errors report the exception type only); hotspots = patches
  ≥ 0.05 km² with centroids. All optional evidence — gaps are recorded.
- **Differences from the prototype, by design:** WorldCover 2021 instead of
  Dynamic World (Earth Engine only); two single clear scenes instead of
  seasonal median composites; no Earth Engine dependency, project id or Drive
  export. The India-wide screening script was not ported (AOI limit 0.6°).
- **API:** `POST /api/v1/forest/analyze {location, radius_meters ≤ 30000,
  before?, after?}` geocodes the place (or `lat, lng`) and starts a
  `forest_loss` job; `POST /analysis` also accepts `type: forest_loss`. Event
  detail gained `supporting_evidence` and `hotspots`. Forest jobs have an extra
  `context` step.
- **Dashboard:** new analysis card, "Independent evidence" and "Largest
  patches" (click to zoom) in the detail panel, and a place-name + radius area
  picker in the Analyse panel that works for every analysis type.
- **Bug fixed on the way:** Earth Search marks some Sentinel-2 scenes
  `boa_offset_applied: false` although the +1000 offset is already removed;
  subtracting it again zeroed red and pushed NDVI to 1.0.
  `indices.s2_offset_present` checks the flag against the darkest pixels,
  lets the data win and adds a quality flag. Affects all Sentinel-2 analyses.
- Tests: `backend/tests/test_forest.py`; e2e section 8.

## v9 — Renamed to Prithvi Drishti, light landing page, gap-free daily imagery

- **Rename.** The project is **Prithvi Drishti**. The Python package is
  `prithvidrishti` (`backend/prithvidrishti/`, `uvicorn prithvidrishti.api.app:create_app`),
  every env var is `PRITHVIDRISHTI_*` (`_API_KEY`, `_LLM_PROVIDER`, `_DB_PATH`,
  `_EO_DIR`), the browser config global is `window.PRITHVIDRISHTI_CONFIG`, the
  demo-data header is `X-PrithviDrishti-Data-Status`, and the default SQLite
  file is `prithvidrishti.db` (the existing files were renamed, so stored
  forecasts carried over). **Old `FLOODOPS_*` variables are not read** — rename
  them in any `.env`. Unchanged on purpose: the checkout folder name and the
  upstream GitHub clone URL in the README.
- **Landing page** (`frontend/index.html`, `src/landing/`): light layout —
  white page, deep-teal type (Figtree), mint accent, floating segmented nav,
  dark inset hero card, word-by-word statement, bordered data-source strip,
  corner-bracketed section titles, pale two-panel science block, dark live
  card, forest footer. The launch intro, scroll-following satellite and agent
  ring are kept. `scene.js` now renders a **transparent canvas in two passes**:
  stars + Earth are scissored to the on-screen `[data-space]` card and the
  Earth is offset by that card's position (so it scrolls away with it); the
  satellite/beam/rocket are drawn unclipped over the light page. Layering is
  documented at the top of `landing.css` (`.space-card` below the canvas,
  `.space-ring` above it to round the corners). Nine `.scene` sections ↔ nine
  `SCENE_POSES` (asserted in `landing.test.js`).
- **Daily imagery** (`map/catalog.js`): VIIRS Suomi NPP true colour instead of
  MODIS Terra — MODIS's narrower swath left black wedges between orbits near
  the equator. The current UTC day is still being acquired (black/missing
  tiles), so `latestImageryDay()` caps every date picker and
  `setImageryDate` at yesterday.

## v8 — Earth-observation pipeline (real Sentinel-1/2 detection, population exposure, risk)

All keyless. `backend/prithvidrishti/eo/` (deps: `rasterio`, `scipy`, `pillow`):

- **Data access** (`access.py`): Sentinel-2 L2A COGs via Element84 Earth Search;
  Sentinel-1 **RTC** (terrain-corrected gamma0, VV+VH), JRC surface-water
  occurrence, Copernicus DEM 30 m and ESA WorldCover via Planetary Computer
  (anonymous `sas/v1/sign?href=` — the per-collection token endpoint 403s for
  DEM/JRC). `grid.py` warps every band onto one UTM grid (≤1.4 M px, 10–30 m)
  with windowed HTTP reads; only the AOI is transferred.
- **Detectors** (`detectors.py`, one `Detector` interface + `REGISTRY`, each with
  versioned `ModelMetadata`): `s2-ndvi-change`, `s2-water-change`,
  `s1-flood-change`. All are **transparent baselines, not evaluated against
  labelled data** (`evaluation.status = not_evaluated`). Shared rules: a
  detection needs an absolute change AND a robust z-score after removing the
  scene-median shift (so seasonal/atmospheric differences are not events);
  area always comes with a low–high range from stricter/looser thresholds;
  confidence is a class with reasons (`high/probable/detected/uncertain`),
  never an invented percentage; uncontrolled failure modes are `quality_flags`.
  SAR: boxcar speckle filter → Otsu (accepted only if separable and within
  [−22, −13] dB, else fixed −17 dB and flagged) → drop ≥3 dB vs a reference pass
  on the **same relative orbit** → minus JRC permanent water, slope >6°,
  WorldCover built-up (excluded and said so, not "cleared").
- **Exposure** (`population.py`): Meta HRSL 30 m summed over cells inside the
  detected polygons (never area × density). WorldPop 2020 (their stats API)
  over the analysis rectangle gives a dataset ratio → the population range.
  The two disagree a lot (1.3–1.4× seen) and neither is census-validated.
  WorldPop's own GeoTIFFs do not support range requests, so they are not read
  directly. Facilities: OSM points tested point-in-polygon against the extent.
- **Risk** (`risk.py`): documented bands → hazard × exposure matrix
  (`RISK_METHOD` is returned with every assessment). **Vulnerability is
  UNKNOWN** (no data source) and risk is always `complete: false`. A
  convention, not a calibrated model.
- **Pipeline / jobs:** `pipeline.run_detection` (sync, thread) + `finalize`;
  `services/analysis.py` runs four job types (`flood_forecast`, `sar_flood`,
  `water_change`, `vegetation_change`); EO AOIs ≤0.6° per side; a missing
  required input fails the job with the provider's reason (e.g. "best image
  9% clear"). Typical run 1–2 min.
- **Storage:** `eo/repository.py` — SQLite + overlay PNGs under
  `PRITHVIDRISHTI_EO_DIR` (default `./eo_data`, git-ignored); detections survive
  restarts. PostGIS and Neo4j are optional mirrors since v11.
- **Events/API:** `services/detection_events.py` maps a detection to the common
  event shape with statements tagged OBSERVED / INFERRED / UNCERTAIN /
  RECOMMENDED. New routes: `GET /events/{id}/geometry`, `/eo/{id}/{file}.png`,
  `/events/{id}/report` (printable HTML), `/models`, `/monitoring/summary`;
  `POST /analysis` takes `type`, `before`, `after`. Dashboard KPIs name the
  largest single event rather than summing overlapping analyses.
- **Dashboard:** brand "Prithvi Drishti"; Monitor panel; analysis type + date
  pickers; detected-extent layer; the detection's own before/after/change
  images draped on the map and in the swipe view with the extent outline.
- **Not built:** learned models (U-Net / foundation / VLM — the registry is the
  seam), LLM narrative in the assistant, vulnerability data, PostGIS/Neo4j,
  auth/roles, durable job queue. Urban/disease agents still emit seeded demo
  data (not shown in the dashboard).
- Tests: `backend/tests/test_eo.py` (detectors on synthetic scenes with known
  truth, area/geometry, zonal population, risk, storage, jobs, report).

## v7 — Event-centric operations dashboard (no fabricated values on screen)

- **Honesty contract.** Anything not measured is a `Measure` with status
  `unavailable` / `not_assessed` and a reason — never a number. Events carry
  `data_status: live | demo` (demo = simulated trigger or the statistical-mock
  ensemble; `FloodForecast.ensemble_source` records which). Tests assert this.
- **Backend services** (`prithvidrishti/services/`, routes in `api/routes_events.py`):
  `events.py` builds one event model from forecast-agent output and the GDACS
  feed (risk split into hazard / exposure / vulnerability — only hazard is
  scored today, so risk is always `complete: false`); `assets.py` queries real
  critical facilities from OSM Overpass (bounded bbox, 24 h cache, failures
  reported not cached); `analysis.py` runs area-analysis jobs off the request
  path with per-step status (**in-memory — lost on restart**); `assistant.py`
  is a deterministic, evidence-grounded responder that returns structured
  answers + a closed set of map actions and refuses "ignore the evidence"
  prompts (no LLM in this path yet).
  Routes: `GET /events`, `/events/{id}`, `/events/{id}/assets`, `/search`,
  `/system/status`, `POST|GET /analysis`, `POST /assistant`.
- **GDACS fix:** the connector called `…/geteventlist/MAP`, which now returns
  400; it uses `…/SEARCH?eventlist=FL` and exposes centroid/country/dates.
- **Legacy seeded routes** (`/map/*`, `/ensemble/*`, `/timeline/*`,
  `/scenario/*`) still return `random`-seeded demo values. They are marked
  `deprecated` in OpenAPI and send `X-PrithviDrishti-Data-Status: demo`; the dashboard
  no longer calls them. Urban/disease agents still generate random zone data —
  not surfaced in the new UI; replacing them is open work.
- **Dashboard** (`frontend/dashboard.html`, `frontend/src/app/`): MapLibre GL
  (keyless — the Google Maps dependency is gone for this page; `map/engine.js`
  wires MapLibre 6's ES-module worker through Vite). Separate stores
  (`state.js`: ui / map / data / filters / analysis / assistant), all mutations
  in `actions.js`, pure view logic in `model.js` + `format.js`. Panels: events
  (KPIs, 12-month chart, filters, feed), layers (grouped; unbuilt layers listed
  disabled with the reason), analyse (AOI draw/coords → job progress), assistant,
  system; plus event detail, timeline (real event spans + imagery date) and a
  before/after swipe of real daily MODIS imagery (NASA GIBS). Basemaps: OSM,
  EOX Sentinel-2 cloudless (CC BY-NC-SA — **non-commercial**), OpenTopoMap.
- **Old dashboard code** (`src/main.js`, `src/panels/`, `src/map/`,
  `src/ensemble/`, `src/timeline/`, `src/scenarios/`, `src/mockData.js`,
  `src/style.css`) is no longer referenced by any page; kept until there is a
  git baseline to delete it against.
- **Tests:** `backend/tests/test_events.py`, `frontend/src/__tests__/app.test.js`,
  and `npm run test:e2e` (`frontend/e2e/dashboard.e2e.cjs`, needs both servers
  and a Chromium-family browser; real network).
- **Dev note:** `uvicorn --reload` hangs on reload on Windows here (worker
  never exits); run without `--reload` and restart manually.

## v6 — Landing page (satellite launch intro + scroll journey), system overview

- **Two frontend pages.** `frontend/index.html` is now the **landing page**
  (`/`); the operations dashboard moved unchanged to `frontend/dashboard.html`
  (`/dashboard.html`, `src/main.js` + `src/style.css` as before). Vite builds
  both (`build.rollupOptions.input`). The dashboard has a `←` home link.
- **Landing (`frontend/src/landing/`, GSAP + Three.js):** one fixed WebGL
  canvas for the whole page. `scene.js` is fully procedural (shader Earth,
  rocket, satellite, sensing beam — no fetched textures/models) and holds no
  animation state: it draws two plain objects, `pose` and `launch`
  (`poses.js`). `landing.js` tweens them — a ~7s **launch timeline**
  (countdown → liftoff → stage separation → solar-array deploy → hero pose),
  then a **ScrollTrigger-scrubbed timeline** that carries the same satellite
  through one pose per `.scene` section to the end of the page
  (`journeySegments` sizes segments from real section offsets; rebuilt on
  resize). Skippable (button / Esc); `prefers-reduced-motion` and no-WebGL
  visitors get a static, fully readable page. `landing.css` is separate from
  `style.css` on purpose — the dashboard stylesheet locks body scroll.
- **Agent ring** (`landing/carousel.js`): the eight agent cards on a CSS-3D
  cylinder, one GSAP-tweened angle — auto-advance, drag/fling, arrows,
  click-to-front, plus a scroll-linked turn. Cards stay real DOM (status dots
  still update); with reduced motion the section stays the plain grid.
- **`GET /api/v1/system/overview`** (`api/routes_system.py`): agents (id,
  class, role, triggers, subscribed channels via the new
  `EventBus.get_subscriptions()`), phase, LLM fleet, connector mock/live mode,
  event counters. No network calls (unlike `/health`) so it is safe to poll;
  cold start returns `ready: false` + empty collections, never a 500. Feeds the
  landing page's live status strip (`landing/status.js`, which shows "Offline"
  rather than invented numbers when the backend is down).
  Tests: `backend/tests/test_system.py`, `frontend/src/__tests__/landing.test.js`.

## v5 — Google Flood Forecasting connector, runoff calibration, skill panel

- **Google Flood Forecasting API** (`connectors/googleflood.py`, 🔑 key-gated):
  the operational Nature-2024 LSTM model (floodforecasting.googleapis.com,
  free/CC BY 4.0, waitlist → `FLOODS_API_KEY`, the name Google's colab/docs use;
  legacy `GOOGLE_FLOOD_API_KEY` still honored and wins if both set). Sentinel
  polls flood status when keyed: every status → `external_hazards`;
  SEVERE/EXTREME in the basin bbox → anomaly boost (`ai_model_flood_forecast`,
  confidence 0.95 quality-verified / 0.75 otherwise, deduped per
  gauge+issued_time). The connector mirrors the **full colab surface**
  (`Google_Flood_Forecasting_API_Usage_Example.ipynb`), all paginated via
  `nextPageToken`: `get_gauges` / `get_flood_status` (the area search filters
  by `regionCode` — ISO-3166 `BASIN_REGION_CODE`, default `NP`; the live API
  rejects an `areaFilter` bbox with 400, so the basin bbox is applied
  client-side on gauge locations — status now also surfaces `inundation_map_set`
  + `notification_polygon_id`), `query_gauge_forecasts` (quantitative
  discharge/level forecasts w/ lead times — Hydrology Model API; `gaugeIds`
  must repeat per id, not nest a list), `get_gauge_models` (official
  warning/danger/extreme thresholds, batched 50), `get_significant_events`,
  `get_flash_floods`, `get_serialized_polygon` (KML geometry). Read-only routes
  (honest `available: false` until keyed): `/api/v1/hazards/googleflood`,
  `…/forecasts`, `…/significant-events`, `…/flash-floods`, and
  `/api/v1/basin/google-thresholds` (Google's official thresholds as an
  independent cross-check against our Weibull-fitted `/basin/thresholds`).
  **Verified live 2026-06-30** (Nepal pilot key, project allowlisted): 765
  national gauges → 178 in the Bagmati bbox, all endpoints 200. Only flood
  status is wired into the agent pipeline so far (significant-event fusion is a
  candidate for v6 — fusion schema not yet exercised).
- **Runoff calibration** (`hydrology/calibration.py`, keyless): pairs the
  Open-Meteo archive precipitation reanalysis
  (`OpenMeteoConnector.get_historical_precipitation`) with the GloFAS
  discharge record; routes each historical year through the SAME linear
  reservoir and fits `scale = median(observed/routed annual max)` (refused
  <10 paired years or outside [0.01, 100]). Predict memoizes it 24h and
  scales member peaks before depth conversion (Bagmati live fit: scale 0.575
  over 21 years). *Magnitude bias-correction only — joint k/coefficient
  estimation is v6.* Tests: `tests/test_v5.py`.
- **Forecast Skill & Benchmark panel** (`frontend/src/panels/skill-panel.js`):
  renders `/verification/skill` + `/basin/thresholds` with an honest
  MEASURED vs COLD-START PRIOR badge; sends `X-API-Key` when configured.

## v4 — Multi-model AI fleet, live hazard feeds, real ML, agency-ready ops

Reference standard: Nearing et al., *Global prediction of extreme floods in
ungauged watersheds*, Nature 627, 559–563 (2024), DOI 10.1038/s41586-024-07145-1
(local copy `global_flood_prediction_nature_2024.md`). All geo ops are WGS84.

- **Multi-model LLM fleet:** `github` provider (GitHub Models,
  `GITHUB_MODELS_TOKEN`, default `openai/gpt-4.1-mini`); module-level
  **429-cooldown guard** (`CooldownProvider`, `LLM_RATE_LIMIT_COOLDOWN_S`,
  event-loop-only state — single Uvicorn worker for the LLM fleet);
  **heterogeneous `_ensemble_vote`** round-robins N runs across
  `LLM_ENSEMBLE_PROVIDERS` with pinned aggregation (median floats, plurality
  Enum/Literal, free text whole from the median-confidence run, ties → lower
  pool index); `FloodLLMClient` chains primary → extras on cooldown (loud,
  never silent-Null); per-agent routing in the lifespan (Groq fast lane =
  sentinel, GitHub deep lane = compound/urban). **Tier honesty:** Groq/GitHub
  free tiers are demo/eval — agency deployment swaps paid endpoints by config.
  **NVIDIA NIM fallback** (`nvidia` = `z-ai/glm-5.1`, `nvidia-minimax` =
  `minimaxai/minimax-m2.7`, OpenAI-compatible `integrate.api.nvidia.com`,
  `NVIDIA_API_KEY` / optional `NVIDIA_MINIMAX_API_KEY`): both auto-join the
  fallthrough/ensemble chain in the lifespan whenever keyed — so a primary
  429/token-limit cools down and falls through to them — and sit last in the
  `auto` order (primary only if nothing else is keyed). No-op until keyed.
- **Live hazard connectors:** `connectors/gdacs.py` (keyless GeoJSON flood
  events, Green/Orange/Red severity map; research-use ToS — agencies need a
  data agreement). Sentinel polls it on CRON → `external_hazards` channel
  (fused by CompoundEventAgent as `regional_flood_alert`) + an anomaly boost
  when an Orange/Red event bbox intersects the basin bbox (rect approximation,
  `BASIN_BBOX_HALF_DEG`). `connectors/reliefweb.py` (v2 API, needs a free
  registered `RELIEFWEB_APPNAME`; payloads carry `report_lag_days` and are
  labelled retrospective-only) → DiseaseRiskAgent LLM context.
- **Real ML in agents:** `hydrology/climatology.py` — day-of-year discharge
  baselines (±15-day pooling over the multi-decade reanalysis, 24h memo);
  sentinel scores the live GloFAS forecast as **seasonal z-scores** (stub
  fallback kept). `hydrology/runoff.py` — member-seeded `Uniform(1±0.20)`
  precip perturbation routed through a delayed linear reservoir
  (`tp = 0.5·sqrt(area)`, `RUNOFF_RECESSION_K`); depth via the basin's fitted
  return-period scale; catchment area from `BASIN_EFFECTIVE_AREA_KM2` (≈585,
  upper Bagmati — NOT the bbox, which would overstate ~20×). *Physically
  motivated, uncalibrated — calibration is v5.* `obs/verification.py` — crash-
  proof asyncio loop (lifespan task, `VERIFICATION_JOB_INTERVAL_S`) scoring
  matured forecasts with the paper's **±2-day exceedance-hit rule**; serves
  measured P/R/F1 per return period, cold-start prior below
  `VERIFICATION_MIN_SAMPLES`.
- **Agency ops:** `obs/store.py` — WAL SQLite via `asyncio.to_thread`
  (forecasts/alerts/audit/verification_samples; **single-node/eval — production
  = PostgreSQL**, schema kept portable). `models/cap.py` — **CAP 1.2 XML**
  export (`GET /api/v1/alerts/{id}/cap.xml`), ElementTree-built (auto-escaped,
  external strings length-capped). Optional **API auth**: `PRITHVIDRISHTI_API_KEY` →
  `X-API-Key` on `/api/v1/*`, `?api_key=` on the WS upgrade (1008 on mismatch).
  Routes: `/api/v1/verification/skill` (cold-start contract: 200 + prior),
  `/api/v1/basin/thresholds`, `/api/v1/hazards/gdacs`. Rate limiting, full
  AuthN/Z, HA: documented out-of-scope. Tests: `tests/test_v4.py`.

## v3 — Real flood-frequency analysis + free-tier LLM providers

- **Per-basin return-period thresholds (paper-faithful, keyless):**
  `prithvidrishti/hydrology/return_periods.py` fits 1/2/5/10-yr discharge thresholds
  from the 1984→present GloFAS reanalysis (Weibull plotting positions on annual
  maxima, Bulletin 17B framing — the method Nearing et al., Nature 627, 2024
  derive per-gauge events with). `OpenMeteoConnector.get_historical_discharge()`
  serves the record keyless (24h cache); FloodPredictAgent fits + caches the
  thresholds per basin (24h) and attaches a deterministic **GloFAS benchmark
  reference** to every forecast (`benchmark_discharge_thresholds_m3s`,
  `benchmark_peak_discharge_m3s`, `benchmark_return_period_years`). Refused
  (None) below 10 years of record — never faked. Streamflow remains
  **reference-only, never a model input** (paper safety rule). The depth-based
  `RETURN_PERIOD_DEPTH_THRESHOLDS_M` constants still drive the mock-ensemble
  classification; the benchmark fields carry the real basin-specific science.
  Tests: `tests/test_hydrology.py`.
- **OpenAI-compatible LLM providers:** `OpenAICompatProvider` (`llm/providers.py`)
  speaks `/chat/completions` over httpx (no SDK) — covers **Groq**
  (`GROQ_API_KEY`, default `llama-3.3-70b-versatile`), **OpenRouter**
  (`OPENROUTER_API_KEY`) and any custom endpoint (`OPENAI_COMPAT_*`, e.g. local
  Ollama). `PRITHVIDRISHTI_LLM_PROVIDER` now accepts
  `anthropic|gemini|groq|openrouter|openai-compat|auto`; auto order is
  Anthropic → Gemini → Groq → OpenRouter → compat → Null.

## v2 — Live command deck, observability, real connectors, CI/CD

- **Live WebSocket command deck** (frontend): every agent channel is broadcast as a
  typed `{type, data, ts}` envelope and surfaced live — a **Compound Threat Radial**
  (signature canvas), an **Agent Activity Stream**, a **Sitrep ticker**, and a
  connection HUD with reconnect + full snapshot resync. Works keyless (the basemap
  needs a Google Maps key; the panels do not).
- **Observability:** `GET /health` (agents + per-connector live/mock + LLM status),
  `GET /metrics` (Prometheus via `prometheus_client`), structured JSON logging
  (`prithvidrishti/obs/`). **`# NOTE: dev-only` — `/metrics` counters and the agent-memory
  store are in-memory and reset on restart; durable persistence is out of scope for v2.**
- **Keyless real connectors:** `OpenMeteoConnector` (GloFAS discharge ensemble +
  rainfall, TTL 900s) feeds predict/sentinel; `OSMConnector` (Overpass, TTL 86400s)
  feeds urban. Both fall back to mock when unreachable. Heavy GDAL connectors live
  behind the same interface (`requirements-geo.txt`); a key activates them later.
- **Advanced agent techniques:** bounded FIFO **agent memory** (`MEMORY_MAX_EVENTS`,
  default 500) with cosine recall — embeddings via sentence-transformers when present,
  else recall is **disabled (never faked)**; a config-seeded **causal graph**
  (`WATERSHED_TOPOLOGY`, default **`bagmati`** — change `DEFAULT_WATERSHED_REGION` for
  another basin); multi-scale district rollup in urban.
- **CI/CD:** GitHub Actions (`ci.yml`: ruff + advisory mypy + pytest-cov, eslint +
  vitest + build, **blocking security gate** — bandit HIGH + `npm audit --omit=dev
  --audit-level=high`; `docker.yml`: matrix lean+ML backend + frontend). `make
  test lint security`, ruff/mypy/eslint/prettier/pre-commit configs, vitest panel tests.

**v2 scope notes / tradeoffs (for v3):**
- **Persistence is out of scope** — agent memory + metrics reset on restart.
- **Optional semantic memory:** install `sentence-transformers` (in `requirements-ml.txt`,
  or Docker `--build-arg INCLUDE_ML=true` which pre-downloads `all-MiniLM-L6-v2`) for
  keyless semantic recall; without it `recall_similar()` returns `[]`.
- **`LLM_ENSEMBLE_CONCURRENCY`** (default 1) caps concurrent LLM calls for tier-1 RPM
  safety; in no-key/dev mode raise it freely (NullProvider makes no network calls).
- **Memory uses FIFO eviction** — it can evict the exact high-value old analogue (e.g.
  a 2021 monsoon) first; v3 may move to LRU/relevance-scored.
- **Phase transitions (v3, FIXED):** `orchestrator/service.py` now advances phases via
  a deterministic **one-shot single-step** transition (`_step_graph` evaluates one
  routing decision per event using the graph's own routing/node functions) instead of
  re-invoking the LangGraph from its fixed `monitoring` entry point (which reset the
  phase and hit `GraphRecursionError`). It also subscribes to `anomaly_alerts` and
  `flood_receding` — without these the MONITORING→ELEVATED and ACTIVE→POST_FLOOD
  transitions could never fire. Covered by `tests/test_orchestrator.py`.

---

## The 8 Agents

All inherit `BaseAgent` (`backend/prithvidrishti/agents/base.py`), communicate via the
in-memory `EventBus` (`prithvidrishti/queue/event_bus.py`), and emit dict payloads
(`.model_dump()`). Event handlers take **`(self, channel, payload)`** — the bus
delivers `handler(channel, payload)`.

| Agent | File | Trigger | Consumes | Emits | Reasoning |
|---|---|---|---|---|---|
| **SentinelAgent** | `agents/sentinel.py` | CRON 15min | NOAA/USGS | `anomaly_alerts`, `flood_receding` | z-score anomaly detection (deterministic) |
| **GLOFAgent** | `agents/glof.py` | CRON 6d + HTTP_DIRECT | GLIMS/SAR | `glof_reports`, `glof_emergencies`, direct→alert | dam integrity (deterministic; <100ms bypass) |
| **FloodPredictAgent** | `agents/predict.py` | `anomaly_alerts` | ECMWF ensemble | `flood_forecasts` | **ensemble-vote** + **uncertainty bounds** |
| **UrbanRiskAgent** | `agents/urban.py` | `flood_forecasts` | OSM/WorldPop | `urban_risk` | **reflexion** per HIGH/CRITICAL zone |
| **AlertAgent** | `agents/alert.py` | `flood_forecasts` + HTTP_DIRECT | — | `alert_dispatches` | severity mapping (deterministic — safety) |
| **ResourceAgent** | `agents/resource.py` | `flood_forecasts`, `disease_risk` | — | `resource_orders` | **reflexion** pre-positioning justification |
| **DiseaseRiskAgent** | `agents/disease.py` | `flood_receding` | WHO/JMP | `disease_risk` | **ensemble-vote** outbreak risk |
| **CompoundEventAgent** | `agents/compound.py` | flood/disease/glof/anomaly | — | `compound_threats` | co-occurrence fusion + **ensemble-vote** |

**Safety rule:** the LLM *augments* reasoning (summaries, confidence, causal
attribution) but **never gates safety decisions** — alert severity, phase
thresholds (`config.py`), and the deterministic flood probability that drives
routing are computed without the LLM.

---

## Shared reasoning core

- **Provider abstraction** — `llm/providers.py`: `LLMProvider` protocol +
  `AnthropicProvider` (Claude, `messages.parse` structured output, adaptive
  thinking) + `GeminiProvider` + `NullProvider`. SDKs are lazy-imported;
  `make_provider()` reads config/env. `FloodLLMClient` (`llm/client.py`)
  delegates to the provider and adds `available()` / `analyze()` / `critique()`.
- **Core-3 helpers on `BaseAgent`** (inherited by every agent):
  - `_run_with_reflexion(system, data, context, schema, mock, ...)` — analyze →
    self-critique → retry on low confidence.
  - `_ensemble_vote(system, data, context, schema, mock, runs=3)` — N-run
    median consensus for high-stakes predictions.
  - `_quantify_uncertainty(samples, ensemble_spread=...)` — pure-Python
    epistemic + aleatoric bounds (`UncertaintyBounds`); works with no key.
  - All three return the caller's `mock` when no LLM is configured.
- **Models** — `models/reasoning.py` (`ReasonedAssessment`, `UncertaintyBounds`),
  `models/compound.py` (`CompoundThreat`). Prompts in `llm/prompts.py`.

---

## Orchestrator & API

- `orchestrator/service.py` subscribes (awaited) to agent channels, records into
  `FloodSystemState` (`models/state.py`), steps the LangGraph state machine, and
  broadcasts phase changes over WebSocket.
- `api/app.py` lifespan builds the bus, 8 agents (injected with the LLM client),
  the orchestrator, and bridges every `EventBus.emit` to all WS clients
  (`{type: channel, data: payload}`).
- Routes serve **live agent state when present, demo data on cold start**:
  - Live-wired: `/map/flood-zones` (merges live zone risk/reasoning),
    `/ensemble/members`, `/ensemble/disagreement`, `/flood/compound`.
  - Demo-only (future live wiring): `/ensemble/fan`, `/timeline/frames`,
    `/scenario/run` — these need percentile/perturbation fields the current
    models don't yet carry.

---

## Adding a new agent

Follow the `/project:add-agent` workflow: define output models in
`models/<agent>.py` (every numeric prediction needs `confidence` + uncertainty
bounds; geo via `models/geo.py`; `created_at` + `agent_id` on every model),
implement `agents/<agent>.py` (use the inherited core-3 helpers with a `mock`
fallback), add the system prompt to `llm/prompts.py`, register in
`orchestrator/service.py` + `api/app.py` lifespan + `models/state.py`, add tests
under `backend/tests/`, and update the table above.
