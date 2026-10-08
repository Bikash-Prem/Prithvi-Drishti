"""System overview route + EventBus topology introspection."""

from __future__ import annotations

import pytest

from prithvidrishti.models.enums import FloodPhase
from prithvidrishti.queue.event_bus import EventBus


class _Owner:
    def __init__(self, agent_id=None):
        if agent_id:
            self.agent_id = agent_id

    async def handle(self, channel, payload):
        return None


@pytest.mark.asyncio
async def test_get_subscriptions_maps_agents_and_skips_non_agents():
    bus = EventBus()
    agent, store = _Owner("demo_agent"), _Owner()
    await bus.subscribe("flood_forecasts", agent.handle)
    await bus.subscribe("disease_risk", agent.handle)
    await bus.subscribe("flood_forecasts", store.handle)

    assert bus.get_subscriptions() == {
        "demo_agent": ["flood_forecasts", "disease_risk"],
    }


def test_overview_cold_start_is_honest_not_an_error():
    from fastapi.testclient import TestClient

    from prithvidrishti.api.app import _app_state, create_app

    saved = dict(_app_state)
    _app_state.clear()
    try:
        client = TestClient(create_app())          # no lifespan — nothing built
        resp = client.get("/api/v1/system/overview")
    finally:
        _app_state.update(saved)

    assert resp.status_code == 200
    body = resp.json()
    assert body["ready"] is False
    assert body["agents"] == [] and body["connectors"] == {}
    assert body["llm"] == {"available": False, "fleet": []}
    assert body["events"]["total_emits"] == 0
    assert body["phase"]["current"] == FloodPhase.MONITORING.value
    assert body["phase"]["all"] == [p.value for p in FloodPhase]


def test_overview_reports_live_agents_and_topology():
    from fastapi.testclient import TestClient

    from prithvidrishti.api.app import create_app

    with TestClient(create_app()) as client:       # runs the real lifespan
        body = client.get("/api/v1/system/overview").json()

    assert body["ready"] is True
    by_id = {a["agent_id"]: a for a in body["agents"]}
    assert len(by_id) == 8
    assert "anomaly_alerts" in by_id["flood_predict_agent"]["consumes"]
    assert by_id["sentinel_agent"]["name"] == "SentinelAgent"
    assert by_id["sentinel_agent"]["role"]
    assert "openmeteo" in body["connectors"]
