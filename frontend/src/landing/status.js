/**
 * Live status strip — renders `/api/v1/system/overview` on the landing page.
 *
 * Honest by design: when the backend is unreachable the tiles say so; no
 * number is ever shown that the backend did not report.
 */

const API = (typeof window !== 'undefined' && window.PRITHVIDRISHTI_CONFIG?.apiUrl) || '/api/v1';

function authHeaders() {
    const apiKey = (typeof window !== 'undefined' && window.PRITHVIDRISHTI_CONFIG?.API_KEY) || '';
    return apiKey ? { 'X-API-Key': apiKey } : {};
}

/** "02_IMMINENT" → "Imminent", "05_POST_FLOOD" → "Post flood". */
export function phaseLabel(phase) {
    const words = String(phase || '').replace(/^\d+_/, '').replace(/_/g, ' ').toLowerCase();
    return words ? words[0].toUpperCase() + words.slice(1) : '—';
}

/**
 * Reduce an overview payload (or `null` when offline) to display tiles.
 * Pure — exported for tests.
 */
export function summarizeOverview(data) {
    if (!data) {
        return {
            online: false,
            tiles: {
                system: { text: 'Offline', tone: 'bad' },
                phase: { text: '—', tone: '' },
                agents: { text: '—', tone: '' },
                llm: { text: '—', tone: '' },
                events: { text: '—', tone: '' },
            },
            note: 'Backend not reachable on :8000. Start it to see live status — the dashboard still opens with demo data.',
            agentIds: [],
            phaseIndex: -1,
        };
    }

    const agents = Array.isArray(data.agents) ? data.agents : [];
    const ready = Boolean(data.ready);
    const llmOn = Boolean(data.llm?.available);
    const connectors = Object.values(data.connectors || {});
    const liveConnectors = connectors.filter((c) => !c.is_mock).length;
    const errors = data.events?.handler_errors ?? 0;

    return {
        online: true,
        tiles: {
            system: ready ? { text: 'Online', tone: 'ok' } : { text: 'Starting', tone: 'warn' },
            phase: { text: phaseLabel(data.phase?.current), tone: '' },
            agents: { text: `${agents.length} / 8`, tone: agents.length === 8 ? 'ok' : 'warn' },
            llm: llmOn
                ? { text: (data.llm.fleet || []).join(' + ') || 'LLM', tone: 'ok' }
                : { text: 'Deterministic', tone: '' },
            events: { text: String(data.events?.total_emits ?? 0), tone: errors ? 'warn' : '' },
        },
        note: [
            connectors.length ? `${liveConnectors} of ${connectors.length} data connectors set to live mode.` : '',
            llmOn ? '' : 'No LLM key set — agents are running their deterministic reasoning path.',
            errors ? `${errors} handler error(s) logged.` : '',
        ].filter(Boolean).join(' '),
        agentIds: agents.map((a) => a.agent_id),
        phaseIndex: Number.isInteger(data.phase?.index) ? data.phase.index : -1,
    };
}

export async function fetchOverview() {
    try {
        const resp = await fetch(`${API}/system/overview`, { headers: authHeaders() });
        return resp.ok ? await resp.json() : null;
    } catch {
        return null;
    }
}

function setTile(id, tile) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = tile.text;
    el.className = `status-value${tile.tone ? ` ${tile.tone}` : ''}`;
}

export function renderStatus(summary) {
    setTile('st-system', summary.tiles.system);
    setTile('st-phase', summary.tiles.phase);
    setTile('st-agents', summary.tiles.agents);
    setTile('st-llm', summary.tiles.llm);
    setTile('st-events', summary.tiles.events);

    const note = document.getElementById('status-note');
    if (note) note.textContent = summary.note;

    const online = new Set(summary.agentIds);
    document.querySelectorAll('.agent-card').forEach((card) => {
        card.classList.toggle('online', online.has(card.dataset.agent));
    });
    document.querySelectorAll('.phase-step').forEach((step) => {
        step.classList.toggle('current', Number(step.dataset.phase) === summary.phaseIndex);
    });
}

/** Fetch + render now, then keep it fresh while the tab is visible. */
export function initStatus(intervalMs = 20000) {
    const refresh = async () => {
        if (document.hidden) return;
        renderStatus(summarizeOverview(await fetchOverview()));
    };
    refresh();
    return setInterval(refresh, intervalMs);
}

/** Trigger the demo pipeline, then hand over to the dashboard. */
export function initSimulateButton() {
    const btn = document.getElementById('simulate-btn');
    const note = document.getElementById('status-note');
    if (!btn) return;
    btn.addEventListener('click', async () => {
        btn.disabled = true;
        const label = btn.textContent;
        btn.textContent = 'Triggering…';
        try {
            const resp = await fetch(`${API}/flood/simulate`, { method: 'POST', headers: authHeaders() });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            if (note) note.textContent = `Demo event triggered for ${data.area}. Opening the dashboard…`;
            setTimeout(() => { window.location.href = '/dashboard.html'; }, 900);
        } catch (e) {
            if (note) note.textContent = `Could not trigger the demo event (${e.message}). Is the backend running?`;
            btn.disabled = false;
            btn.textContent = label;
        }
    });
}
