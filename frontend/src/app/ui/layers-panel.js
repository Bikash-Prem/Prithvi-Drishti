/**
 * Layer control. Grouped by what a layer *is* — events, observation,
 * exposure, risk — with source, legend, opacity and state per layer.
 * Layers the platform cannot produce yet are listed, disabled, with why.
 */
import { setImageryDate, setLayer, setOverlay } from '../actions.js';
import { SEVERITY, assetLabel, esc, fmtDate } from '../format.js';
import { ASSET_COLORS, BASEMAPS, EXTENT_COLORS, LAYER_GROUPS, LAYERS, OVERLAY_OPTIONS, SEVERITY_COLORS, latestImageryDay } from '../map/catalog.js';
import { data, mapState } from '../state.js';
import { on } from './dom.js';

function legend(kind) {
    if (kind === 'severity') {
        return `<ul class="legend">${Object.entries(SEVERITY).map(([id, s]) => `
            <li><span class="swatch" style="background:${SEVERITY_COLORS[id]};width:${8 + s.rank * 3}px;height:${8 + s.rank * 3}px"></span>${esc(s.label)}</li>`).join('')}
            <li class="legend-note">Larger and redder = more severe. Faded = past event.</li></ul>`;
    }
    if (kind === 'assets') {
        return `<ul class="legend">${Object.entries(ASSET_COLORS).filter(([t]) => t !== 'assembly_point').map(([type, color]) => `
            <li><span class="swatch" style="background:${color}"></span>${esc(assetLabel(type))}</li>`).join('')}</ul>`;
    }
    if (kind === 'extent') {
        return `<ul class="legend">
            <li><span class="swatch swatch-sq" style="background:${EXTENT_COLORS.flood}"></span>Probable inundation</li>
            <li><span class="swatch swatch-sq" style="background:${EXTENT_COLORS.water_change}"></span>New surface water</li>
            <li><span class="swatch swatch-sq" style="background:${EXTENT_COLORS.vegetation_change}"></span>Potential vegetation loss</li>
            <li><span class="swatch swatch-sq" style="background:${EXTENT_COLORS.forest_loss}"></span>Potential forest loss (on tree cover)</li>
            <li><span class="swatch swatch-sq" style="background:${EXTENT_COLORS.secondary}"></span>Vegetation gain / water no longer present</li></ul>`;
    }
    if (kind === 'area') {
        return '<ul class="legend"><li><span class="swatch swatch-dash"></span>Area covered by a forecast</li></ul>';
    }
    return '';
}

function layerState(layer) {
    const { assets, selectedId, geometry } = data.get();
    if (layer.id === 'extent') {
        if (!selectedId) return '<p class="layer-state">Select a satellite detection to see its extent.</p>';
        if (geometry.status === 'loading') return '<p class="layer-state"><span class="spinner spinner-sm" aria-hidden="true"></span> Loading extent…</p>';
        if (geometry.status === 'error') return '<p class="layer-state layer-error">Could not load the extent.</p>';
        if (geometry.status === 'ready' && geometry.data.available) {
            const options = OVERLAY_OPTIONS.map((o) => `<button type="button" data-overlay="${o.id}" class="${mapState.get().overlay === o.id ? 'is-on' : ''}" aria-pressed="${mapState.get().overlay === o.id}">${esc(o.label)}</button>`).join('');
            return `<p class="layer-state">${geometry.data.extent.patch_count} patches shown.</p>
                <p class="layer-state">Satellite image under the extent:</p><div class="seg seg-sm" role="group" aria-label="Satellite image">${options}</div>`;
        }
        return '<p class="layer-state">The selected event has no detected extent (forecasts and external reports do not).</p>';
    }
    if (layer.id !== 'assets') return '';
    if (!selectedId) return '<p class="layer-state">Select an event to load its facilities.</p>';
    if (assets.status === 'loading') return '<p class="layer-state"><span class="spinner spinner-sm" aria-hidden="true"></span> Loading from OpenStreetMap…</p>';
    if (assets.status === 'error' || (assets.status === 'ready' && assets.data.status !== 'available')) {
        return '<p class="layer-state layer-error">Could not load facilities — retry from the event panel.</p>';
    }
    if (assets.status === 'ready') return `<p class="layer-state">${assets.data.total} facilities shown.</p>`;
    return '<p class="layer-state">Not loaded for this event yet — use “Query facilities”.</p>';
}

function layerRow(layer, state, imageryDate) {
    if (!layer.available) {
        return `
            <li class="layer layer-off">
                <label class="check"><input type="checkbox" disabled aria-describedby="why-${layer.id}"><span>${esc(layer.label)}</span></label>
                <p class="layer-state" id="why-${layer.id}"><span class="tag tag-unavailable">UNAVAILABLE</span> ${esc(layer.reason)}</p>
            </li>`;
    }
    const s = state[layer.id];
    const dated = layer.dated ? `
        <label class="field-inline">Date
            <input type="date" data-imagery-date value="${esc(imageryDate)}" max="${esc(latestImageryDay())}">
        </label>
        <p class="layer-state">Showing ${esc(fmtDate(imageryDate))}. Also set from the timeline.</p>` : '';
    return `
        <li class="layer${s.on ? ' is-on' : ''}">
            <label class="check"><input type="checkbox" data-layer="${layer.id}" ${s.on ? 'checked' : ''}><span>${esc(layer.label)}</span></label>
            <div class="layer-body"${s.on ? '' : ' hidden'}>
                <label class="field-inline">Opacity
                    <input type="range" min="10" max="100" step="5" value="${Math.round(s.opacity * 100)}" data-opacity="${layer.id}"
                        aria-label="${esc(layer.label)} opacity">
                </label>
                ${dated}${legend(layer.legend)}
                ${layer.note ? `<p class="layer-note">${esc(layer.note)}</p>` : ''}
                ${layerState(layer)}
            </div>
            <p class="layer-source">Source: ${esc(layer.source)}</p>
        </li>`;
}

function render(root) {
    const { basemap, layers, imageryDate } = mapState.get();
    const base = BASEMAPS.map((b) => `
        <label class="radio"><input type="radio" name="basemap" value="${b.id}" ${basemap === b.id ? 'checked' : ''}>
            <span>${esc(b.label)}<small>${esc(b.source)}</small></span></label>`).join('');
    const groups = LAYER_GROUPS.map((group) => `
        <fieldset class="layer-group">
            <legend>${esc(group)}</legend>
            <ul>${LAYERS.filter((l) => l.group === group).map((l) => layerRow(l, layers, imageryDate)).join('')}</ul>
        </fieldset>`).join('');
    root.innerHTML = `
        <fieldset class="layer-group"><legend>Basemap</legend><div class="radios">${base}</div></fieldset>
        ${groups}`;
}

export function mountLayersPanel(root) {
    on(root, 'change', 'input[name="basemap"]', (_e, el) => mapState.set({ basemap: el.value }));
    on(root, 'change', '[data-layer]', (_e, el) => setLayer(el.dataset.layer, { on: el.checked }));
    on(root, 'change', '[data-imagery-date]', (_e, el) => setImageryDate(el.value));
    on(root, 'click', '[data-overlay]', (_e, el) => setOverlay(el.dataset.overlay));
    // Opacity updates the map live without re-rendering the panel (keeps the drag).
    on(root, 'input', '[data-opacity]', (_e, el) => {
        dragging = true;
        setLayer(el.dataset.opacity, { opacity: Number(el.value) / 100 });
    });
    on(root, 'change', '[data-opacity]', () => { dragging = false; });
    let dragging = false;
    const draw = () => { if (!dragging) render(root); };
    mapState.subscribe(draw);
    data.subscribe(draw, (s) => s.assets);
    data.subscribe(draw, (s) => s.geometry);
    data.subscribe(draw, (s) => s.selectedId);
    draw();
}
