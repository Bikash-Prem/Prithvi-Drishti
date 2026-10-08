/**
 * System status: the header pill (one-glance health) and the System panel
 * (per-service detail, including capabilities that are not built yet).
 */
import { loadSystem, openPanel } from '../actions.js';
import { describeError } from '../api.js';
import { esc, timeAgo } from '../format.js';
import { data } from '../state.js';
import { on, skeletonRows, stateBlock } from './dom.js';

const STATE_ICON = { operational: '●', degraded: '◐', unavailable: '✕', not_configured: '○', not_implemented: '○' };
const CONN_LABEL = { live: 'Live updates on', reconnecting: 'Reconnecting…', offline: 'Live updates off', connecting: 'Connecting…' };

function render(root) {
    const { system, connection } = data.get();
    if (!system.data) {
        if (system.status === 'error') {
            const d = describeError(system.error);
            root.innerHTML = stateBlock({ kind: 'error', title: d.title, text: d.text, action: { label: 'Retry', name: 'reload' } });
        } else {
            root.innerHTML = `${stateBlock({ kind: 'loading', title: 'Checking services…' })}${skeletonRows(6)}`;
        }
        return;
    }
    const s = system.data;
    const rows = s.groups.map((g) => `
        <li class="svc svc-${esc(g.state)}">
            <span class="svc-icon" aria-hidden="true">${STATE_ICON[g.state] || '○'}</span>
            <div><p class="svc-name">${esc(g.name)} <span class="svc-state">${esc(g.state_label)}</span></p>
                <p class="kv-note">${esc(g.detail)}</p></div>
        </li>`).join('');
    root.innerHTML = `
        ${system.status === 'error' ? '<div class="banner banner-warn" role="alert">Could not refresh — showing the last result.</div>' : ''}
        <div class="list-head"><h3>Services</h3>
            <span class="muted">${system.status === 'loading' ? 'Checking…' : `Checked ${esc(timeAgo(s.checked_at))}`}</span></div>
        <ul class="svc-list">${rows}</ul>
        <div class="list-head"><h3>This browser</h3></div>
        <ul class="svc-list">
            <li class="svc svc-${connection === 'live' ? 'operational' : connection === 'offline' ? 'unavailable' : 'degraded'}">
                <span class="svc-icon" aria-hidden="true">${connection === 'live' ? '●' : connection === 'offline' ? '✕' : '◐'}</span>
                <div><p class="svc-name">Live connection <span class="svc-state">${esc(CONN_LABEL[connection] || connection)}</span></p>
                    <p class="kv-note">WebSocket for forecast and analysis updates. Without it the page refreshes on a timer.</p></div>
            </li>
        </ul>
        <button type="button" class="btn btn-sm" data-action="reload">Check again</button>`;
}

function renderPill(pill) {
    const { system, connection } = data.get();
    let state = 'checking';
    let label = 'Checking…';
    if (system.status === 'error' && !system.data) { state = 'unavailable'; label = 'Backend unreachable'; }
    else if (system.data) {
        const down = system.data.groups.filter((g) => g.state === 'unavailable' || g.state === 'degraded').length;
        state = down ? 'degraded' : 'operational';
        label = down ? `${down} service${down === 1 ? '' : 's'} degraded` : 'Systems operational';
    }
    if (connection === 'offline' && state === 'operational') { state = 'degraded'; label = 'Live updates off'; }
    pill.className = `status-pill status-${state}`;
    pill.innerHTML = `<span class="status-dot" aria-hidden="true"></span><span>${esc(label)}</span>`;
    pill.setAttribute('aria-label', `System status: ${label}. Open details.`);
}

export function mountSystem(root, pill) {
    on(root, 'click', '[data-action="reload"]', () => loadSystem());
    pill.addEventListener('click', () => { openPanel('system'); });
    const draw = () => { render(root); renderPill(pill); };
    data.subscribe(draw, (s) => s.system);
    data.subscribe(draw, (s) => s.connection);
    draw();
}
