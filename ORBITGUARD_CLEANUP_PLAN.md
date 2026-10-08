# ORBITGUARD_CLEANUP_PLAN.md

**Created:** 2026-10-08  
**Status:** Phase 1 — inspection complete, awaiting approval before any changes.

---

## A. Current Architecture

```
Browser ── HTTP ──► FastAPI (api/app.py lifespan)
  ▲                    │
  └── WS /ws/flood ◄──┤
                       ▼
              ┌── EventBus (in-memory asyncio pub/sub) ──┐
              │                                          │
   8 agents (sentinel, glof, predict,                OrchestratorService
    urban, alert, resource, disease, compound)     (passive subscriber,
              │                                    steps LangGraph phases)
              ▼
   Connectors: openmeteo, osm, gdacs,
               reliefweb, googleflood

   SEPARATE SYSTEM (no EventBus):
   POST /analysis → services/analysis.py → eo/pipeline.py
     → eo/access.py (Sentinel-1, Sentinel-2, DEM, WorldCover, JRC)
     → eo/detectors.py (s2-ndvi-change, s2-water-change, s1-flood-change, s2-forest-loss)
     → eo/population.py (Meta HRSL, WorldPop)
     → eo/forest.py (Hansen, FIRMS, protected areas)
     → eo/risk.py
     → eo/repository.py (SQLite + PNG overlays)
     → services/detection_events.py → dashboard
```

**Two parallel systems exist:**
1. **Agent pipeline** — 8 agents on the EventBus, triggered by `/simulate`. All sensor inputs are stubs/mocks. Produces random-seeded zone data. The LangGraph orchestrator is compiled but never invoked (single-step bypass used instead).
2. **EO pipeline** — real satellite data via `POST /analysis`. Sentinel-1/2 change detection, population exposure, risk. This is the working system.

The dashboard (`routes_events.py`) reads from the EO pipeline. The agent pipeline feeds the WebSocket but the dashboard does **not** read agent outputs for its main event list.

---

## B. Files to KEEP (the real EO pipeline + infrastructure)

These files contain the working satellite analysis system. **Do not break them.**

### EO core (the actual analysis engine)
| File | Role | Status |
|---|---|---|
| `eo/access.py` | Sentinel-1/2, DEM, WorldCover, JRC data access | **Real, keyless** |
| `eo/grid.py` | UTM warping, windowed reads | **Real** |
| `eo/indices.py` | NDVI, water index, BOA offset fix | **Real** |
| `eo/detectors.py` | 4 detectors: s2-ndvi-change, s2-water-change, s1-flood-change, s2-forest-loss | **Real** |
| `eo/pipeline.py` | Orchestrates detection runs, defines analysis types | **Real** |
| `eo/population.py` | Meta HRSL + WorldPop exposure | **Real** |
| `eo/forest.py` | Hansen forest change, FIRMS fire, evidence fusion, protected areas | **Real** |
| `eo/risk.py` | Hazard × exposure matrix | **Real** |
| `eo/render.py` | Before/after/change PNG overlays | **Real** |
| `eo/vector.py` | Raster→polygon vectorization | **Real** |
| `eo/repository.py` | SQLite + file storage for detections | **Real** |

### Services that support the EO pipeline
| File | Role | Status |
|---|---|---|
| `services/analysis.py` | Job manager: creates, runs, tracks analysis jobs | **Real** |
| `services/detection_events.py` | Maps detections → event model for the dashboard | **Real** |
| `services/events.py` | Builds event list (forecast + GDACS + detections) | **Real** |
| `services/assets.py` | OSM Overpass for facilities in the area | **Real** |
| `services/graph.py` | Knowledge graph from detection records | **Real** |
| `services/report.py` | Printable HTML report per event | **Real** |

### API routes the dashboard actually calls
| Route | File | Used by frontend |
|---|---|---|
| `GET /events` | `routes_events.py` | ✅ `api.events()` |
| `GET /events/{id}` | `routes_events.py` | ✅ `api.event()` |
| `GET /events/{id}/assets` | `routes_events.py` | ✅ `api.eventAssets()` |
| `GET /events/{id}/geometry` | `routes_events.py` | ✅ `api.eventGeometry()` |
| `GET /events/{id}/graph` | `routes_events.py` | ✅ detail panel |
| `GET /events/{id}/report` | `routes_events.py` | ✅ `api.reportUrl()` |
| `GET /eo/{record_id}/{file}.png` | `routes_events.py` | ✅ overlay images |
| `GET /models` | `routes_events.py` | ✅ `api.models()` |
| `GET /monitoring/summary` | `routes_events.py` | ✅ `api.monitoring()` |
| `GET /search` | `routes_events.py` | ✅ `api.search()` |
| `POST /analysis` | `routes_events.py` | ✅ `api.startAnalysis()` |
| `GET /analysis/{id}` | `routes_events.py` | ✅ `api.analysis()` |
| `POST /forest/analyze` | `routes_events.py` | ✅ analysis panel |
| `GET /system/status` | `routes_events.py` | ✅ `api.systemStatus()` |
| `POST /assistant` | `routes_events.py` | ✅ `api.assistant()` |
| `GET /system/overview` | `routes_system.py` | ✅ landing page |

### Infrastructure to keep
| File | Role |
|---|---|
| `queue/event_bus.py` | In-memory pub/sub (simplify, don't replace) |
| `api/app.py` | Lifespan + FastAPI setup (simplify heavily) |
| `api/websocket.py` | WS broadcast to browsers |
| `config.py` | Configuration |
| `obs/store.py` | SQLite persistence |
| `obs/logging.py` | Structured logging |
| `connectors/openmeteo.py` | GloFAS discharge + rainfall (real, keyless) |
| `connectors/osm.py` | OSM Overpass for facilities (real, keyless) |
| `connectors/gdacs.py` | GDACS flood events (real, keyless) |
| `connectors/base.py` | Connector base class |

### Models to keep
| File | Role |
|---|---|
| `models/enums.py` | Shared enums |
| `models/geo.py` | Coordinate, BBox |
| `models/predict.py` | FloodForecast model (used by events service) |
| `models/reasoning.py` | ReasonedAssessment, UncertaintyBounds |
| `models/sentinel.py` | AnomalyAlert, SensorReading (used by simulate route) |

### Frontend to keep
| File | Role |
|---|---|
| `frontend/dashboard.html` | Operations dashboard |
| `frontend/src/app/*` | Dashboard JS (actions, api, state, store, ui/, map/) |
| `frontend/src/websocket.js` | WS client |
| `frontend/index.html` | Landing page |
| `frontend/src/landing/*` | Landing page JS/CSS |

### Tests to keep
| File | Covers |
|---|---|
| `tests/test_eo.py` | Detectors, pipeline, population, risk, repository |
| `tests/test_forest.py` | ForestGuard, Hansen, FIRMS, evidence |
| `tests/test_events.py` | Event model, assets, analysis jobs, assistant |
| `tests/test_event_bus.py` | Handler signature contract |
| `tests/test_graph_stores.py` | Evidence fusion, knowledge graph, PostGIS/Neo4j mirrors |

---

## C. Files to SIMPLIFY

| File | What to simplify |
|---|---|
| `queue/event_bus.py` (498 lines) | Remove "Redis-compatible" docstring claim, `process_pending` dead path, `PendingEvent` dataclass. Keep emit/subscribe/unsubscribe/cron/direct_call/WS bridge/metrics. |
| `api/app.py` (336 lines) | Remove the 8-agent creation block, LLM fleet wiring, module-global `_app_state`. Keep EO pipeline setup, connectors needed by the EO pipeline (openmeteo, osm, gdacs), store, websocket bridge. |
| `api/routes_events.py` (643 lines) | Remove the forecast-agent event path (the EO pipeline events are the real system). Keep all dashboard-used routes. |
| `services/events.py` (653 lines) | Remove `build_forecast_event`/`build_forecast_detail` (agent pipeline path). Keep GDACS events and detection events. |
| `services/assistant.py` (160 lines) | Keep if it's deterministic and grounded. Remove if it depends on agent pipeline state. |
| `config.py` | Remove agent-specific config (GLOF intervals, urban zones, disease constants, LLM fleet routing). Keep EO config, basin config, connector config. |
| `models/state.py` (117 lines) | Simplify: remove the 8-agent channel lists from FloodSystemState. |
| `api/routes_system.py` | Keep but simplify: don't report agents that no longer exist. |

---

## D. Files to REMOVE

### Agents (all 8 current agents)
| File | Lines | Reason |
|---|---|---|
| `agents/sentinel.py` | 627 | STUB sensor readings, no real data. |
| `agents/glof.py` | 313 | STUB lake inventory, stub integrity. Out of scope. |
| `agents/predict.py` | 709 | Statistical mock ensemble, random.seed(42). The EO pipeline does real detection. |
| `agents/urban.py` | 257 | random.seed(123), fake zones/routes/populations. |
| `agents/alert.py` | 162 | Deterministic alert severity — **keep only if wired to real detections (decision below)**. |
| `agents/resource.py` | 141 | Rescue logistics. Out of scope. |
| `agents/disease.py` | 193 | random.seed(456), fake disease risk. Out of scope. |
| `agents/compound.py` | 295 | Multi-hazard fusion. Out of scope. |
| `agents/base.py` | 450 | BaseAgent + LLM helpers — **only needed if agents exist**. |

### Orchestrator (compiles LangGraph but never runs it)
| File | Lines | Reason |
|---|---|---|
| `orchestrator/service.py` | 219 | Passive subscriber that steps a graph never actually invoked. |
| `orchestrator/graph.py` | 144 | LangGraph compiled but unused. |
| `orchestrator/routing.py` | 157 | Phase routing functions — never exercised in production. |
| `orchestrator/nodes.py` | 232 | Phase nodes — only return audit entries, never call agents. |

### LLM (optional — keep only what the assistant uses)
| File | Lines | Decision |
|---|---|---|
| `llm/providers.py` | 642 | 7 LLM providers. Keep only if assistant or report gen needs one. |
| `llm/client.py` | 236 | FloodLLMClient. Same. |
| `llm/prompts.py` | 150 | Agent system prompts. Remove with agents. |
| `llm/memory.py` | 102 | Semantic recall. Remove. |
| `llm/reasoning.py` | — | Remove with agents. |

### Models only used by removed agents
| File | Lines | Reason |
|---|---|---|
| `models/alert.py` | — | Only used by AlertAgent. |
| `models/cap.py` | 108 | CAP XML for alert agent. |
| `models/causal.py` | — | Causal graph for agent memory. |
| `models/compound.py` | — | CompoundThreat model. |
| `models/disease.py` | — | Disease risk model. |
| `models/glof.py` | 110 | GLOF model. |
| `models/memory.py` | — | Agent memory model. |
| `models/orchestrator.py` | 135 | AuditEntry, StateTransitionEvent. |
| `models/resource.py` | — | Resource order model. |
| `models/urban.py` | 106 | Zone risk model. |

### Connectors not used by the EO pipeline
| File | Lines | Reason |
|---|---|---|
| `connectors/googleflood.py` | 350 | Key-gated, not used by EO pipeline. |
| `connectors/reliefweb.py` | 101 | Only fed DiseaseRiskAgent. |

### API routes not called by the frontend
| File/Route | Reason |
|---|---|
| `api/routes_flood.py` (all of it) | `/state`, `/phase`, `/audit`, `/agents`, `/simulate`, `/compound`, `/chat`, `/sitrep`, `/reasoning` — all serve agent pipeline state or hardcoded demo values. **No frontend call to any of these except `/simulate` on the landing page.** |
| `api/routes_v4.py` (most of it) | `/verification/skill`, `/basin/thresholds`, `/hazards/gdacs`, `/hazards/googleflood/*`, `/basin/google-thresholds`, `/alerts/{id}/cap.xml` — not called by the dashboard. The GDACS route may be useful; the rest are agent-pipeline features. |
| `api/routes_auth.py` | OAuth stubs (login/callback/status/logout). Not functional. |

### Other
| File | Reason |
|---|---|
| `eo/postgis_store.py` | Optional PostGIS mirror, never used with a real database. |
| `hydrology/calibration.py` | Runoff calibration for predict agent. |
| `hydrology/climatology.py` | Day-of-year baselines for sentinel agent. |
| `hydrology/return_periods.py` | Return-period fitting for predict agent. |
| `hydrology/runoff.py` | Linear reservoir routing for predict agent. |
| `obs/verification.py` | Forecast verification loop for predict agent. |
| `auth/oauth.py` | Unused OAuth. |

### Tests for removed components
| File | Reason |
|---|---|
| `tests/test_orchestrator.py` | Tests the removed orchestrator. |
| `tests/test_reasoning_core.py` | Tests BaseAgent LLM helpers. |
| `tests/test_memory_causal.py` | Tests agent memory + causal graph. |
| `tests/test_system.py` | Tests system overview (update, don't remove). |
| `tests/test_v4.py` | Tests LLM fleet, GDACS, runoff, verification, CAP. Mostly for removed components. |
| `tests/test_v5.py` | Tests Google Flood connector, calibration. For removed components. |
| `tests/test_hydrology.py` | Tests return periods, predict agent benchmark. For removed components. |
| `tests/agents/test_agents.py` | Tests agents. |

---

## E. Files to REPLACE (new typed event models)

Create new Pydantic models in `models/events.py`:

```
AnalysisRequest      — what the user asked for
ObservationResult    — what satellite data was found
HazardDetected       — what change was detected
EvidenceResult       — independent evidence (Hansen, FIRMS, protected areas)
ExposureResult       — population + infrastructure in the extent
RiskResult           — hazard × exposure assessment
```

These replace the untyped dict payloads on the EventBus. The EO pipeline already produces most of this data — it just needs to be wrapped in these models.

---

## F. Real vs Mock/Fake Functionality

### REAL (working, uses live external data)
| Component | Data source |
|---|---|
| `eo/access.py` | Earth Search (Sentinel-2), Planetary Computer (Sentinel-1, DEM, WorldCover, JRC) |
| `eo/detectors.py` | 4 change detectors on real rasters |
| `eo/population.py` | Meta HRSL 30m, WorldPop stats API |
| `eo/forest.py` | Hansen GCS tiles, FIRMS (key-gated), OSM protected areas |
| `connectors/openmeteo.py` | GloFAS discharge + rainfall |
| `connectors/osm.py` | OSM Overpass |
| `connectors/gdacs.py` | GDACS flood events |
| `services/analysis.py` | Job management |

### STUB/MOCK (fake data in the live path)
| Component | What's fake |
|---|---|
| `agents/sentinel.py` | `_generate_stub_readings()` — synthetic sensor data |
| `agents/glof.py` | `_get_stub_lake_inventory()` — hardcoded fake lakes |
| `agents/urban.py` | `_generate_mock_zones()` — `random.seed(123)`, fake populations/buildings/drainage |
| `agents/urban.py` | `_generate_mock_routes()` — fake evacuation routes |
| `agents/disease.py` | `random.seed(456)` — fake disease risk, fake populations |
| `agents/predict.py` | `_generate_mock_ensemble()` — `random.seed(42)`, statistical mock |
| `agents/predict.py` | Mock assessment fallback |
| `api/routes_flood.py` | `/agents` — hardcoded demo agent list |
| `api/routes_flood.py` | `/compound` — hardcoded empty threat |
| `api/routes_flood.py` | `/chat` — hardcoded chat response |
| `api/routes_flood.py` | `/sitrep` — hardcoded situation report |
| `api/routes_flood.py` | `/reasoning` — hardcoded reasoning demo |
| `api/routes_flood.py` | `/simulate` — synthetic AnomalyAlert (this is the trigger, not fake data per se) |

### CONDITIONAL (real when keyed, unavailable otherwise)
| Component | Condition |
|---|---|
| `connectors/googleflood.py` | `FLOODS_API_KEY` |
| `eo/forest.py` FIRMS | `FIRMS_MAP_KEY` |
| LLM helpers | Any LLM API key |

---

## G. Migration Sequence

### Phase 2: Remove unused agents and features
1. Remove `agents/glof.py`, `agents/disease.py`, `agents/resource.py`, `agents/compound.py`, `agents/urban.py`
2. Remove `agents/sentinel.py` (all stub data)
3. Remove `agents/predict.py` (mock ensemble)
4. Remove `agents/base.py` (no agents left to inherit from)
5. Remove all `orchestrator/` files
6. Remove `api/routes_flood.py`
7. Remove `api/routes_auth.py`
8. Remove agent-only models: `models/alert.py`, `models/cap.py`, `models/causal.py`, `models/compound.py`, `models/disease.py`, `models/glof.py`, `models/memory.py`, `models/orchestrator.py`, `models/resource.py`, `models/urban.py`
9. Remove `connectors/reliefweb.py`, `connectors/googleflood.py`
10. Remove `hydrology/` (all 4 files — only served the predict agent)
11. Remove `obs/verification.py` (only scored predict agent forecasts)
12. Remove `llm/memory.py`, `llm/prompts.py`, `llm/reasoning.py`
13. Remove `eo/postgis_store.py`
14. Remove `auth/`
15. Remove tests for removed components
16. Update `api/app.py` lifespan to not create any agents or orchestrator
17. Update `api/routes_system.py` to not report removed agents
18. Update `config.py` to remove agent-specific settings

**Dependency check before each removal:**
- `routes_events.py` does NOT import any agent file ✅
- `services/analysis.py` does NOT import any agent file ✅
- `eo/pipeline.py` does NOT import any agent file ✅
- The dashboard (`api.js`) does NOT call any `routes_flood.py` endpoint ✅
- The landing page calls `/system/overview` and `/flood/simulate` — `/simulate` will be removed (or replaced with a real analysis trigger)

### Phase 3: Simplify EventBus
- Remove `process_pending` dead path and `PendingEvent`
- Remove "Redis-compatible" docstring
- Keep emit/subscribe/unsubscribe/cron/direct_call/WS bridge/metrics

### Phase 4: Create typed event models
- Add `models/events.py` with AnalysisRequest, ObservationResult, HazardDetected, EvidenceResult, ExposureResult, RiskResult

### Phase 5: Clean connector interfaces
- Ensure each connector returns explicit `unavailable` status on failure
- Remove any silent fallback to fake data in connectors

### Phase 6–9: Wire FloodGuard → ForestGuard → Evidence → Exposure → Risk through the new typed events
- The EO pipeline already does all of this — this phase wraps its outputs in the new event types and emits them on the bus

### Phase 10: Clean API + WebSocket
- Simplify routes: the dashboard-used routes stay as-is
- WebSocket emits typed events (analysis_started, detection_complete, etc.)
- Remove or consolidate `routes_v4.py`

### Phase 11: Clean dashboard
- Remove UI for GLOF, disease, evacuation, rescue
- Remove the "simulate" button on landing (or rewire to a real analysis)
- Update agent ring on landing page (fewer agents, honest descriptions)

### Phase 12: Run tests
- `test_eo.py`, `test_forest.py`, `test_events.py`, `test_event_bus.py`, `test_graph_stores.py` must pass
- Write new tests for the typed event pipeline

---

## H. Risks and Dependencies

### Critical: do not break the EO pipeline
The EO pipeline (`eo/`, `services/analysis.py`, `services/detection_events.py`, `services/events.py`) is the working system. None of these files import agents, the orchestrator, or the LLM fleet. **They are safe to leave untouched while everything else is removed.**

### The `/simulate` button on the landing page
`landing/status.js` calls `POST /api/v1/flood/simulate`. This route creates a fake `AnomalyAlert` and emits it on the bus, which triggers the agent chain. After the agents are removed, this button will fail. Options:
- Remove the button
- Replace it with a trigger for a real EO analysis at a demo location

### The landing page agent ring
`index.html` shows 8 agent cards. After removal, these need to be updated to show the new pipeline stages or removed entirely.

### The `/system/overview` route
Reports agents, phases, connectors. After agent removal, this needs to return the simplified system state.

### The assistant
`services/assistant.py` is a deterministic responder that does NOT depend on agents — it reads from the event store. **Safe to keep.** But check whether it references agent-specific state.

### The WebSocket
Currently bridges ALL EventBus channels to the frontend. After agents are removed, only EO pipeline events and analysis-job progress will flow. The frontend `websocket.js` dispatches by `msg.type` — unknown types are silently ignored, so removing agent channels won't crash the frontend.

### LLM client
`llm/client.py` and `llm/providers.py` are only needed if we keep the assistant or add report generation. They do NOT depend on agents. Keep them slim (one provider) or remove entirely if not needed.

### SQLite store
`obs/store.py` currently stores forecasts and alerts from the agent pipeline. After agent removal, it should store analysis results (or the EO repository already handles this).

### Alert Agent (decision needed)
The alert agent has real deterministic severity logic (thresholds at 0.40/0.70/0.90 probability). This could be useful if wired to real EO detections. **Recommend: extract the threshold logic into a simple function in `eo/risk.py` rather than keeping the agent.**

---

## Proposed Final Architecture

```
User → POST /api/analyze { location, type }
         ↓
    services/analysis.py (job manager)
         ↓
    eo/pipeline.py
    ├── eo/access.py     → Sentinel-1/2, DEM, WorldCover, JRC
    ├── eo/detectors.py  → Change detection
    ├── eo/forest.py     → Hansen, FIRMS, protected areas
    ├── eo/population.py → HRSL, WorldPop, OSM facilities
    └── eo/risk.py       → Hazard × exposure → risk level
         ↓
    eo/repository.py (SQLite + PNGs)
         ↓
    services/detection_events.py → event model
         ↓
    EventBus → WebSocket → Dashboard
         ↓
    GET /api/events → Dashboard renders result
```

**Connectors (real, keyless):**
- Open-Meteo (GloFAS)
- OSM Overpass
- GDACS
- Earth Search (Sentinel-2)
- Planetary Computer (Sentinel-1, DEM, WorldCover, JRC)

**Optional (key-gated):**
- FIRMS (fire detection)
- LLM (report summaries only)

**Agents: 0.** The EO pipeline IS the analysis engine. It doesn't need agents wrapping it — it's called directly by the job manager.

**Lines of code removed (estimated):** ~5,500 of 15,243 backend Python lines (36%).
