/**
 * Before / after imagery comparison.
 *
 * Two synchronised maps showing the same product on two dates: the "before"
 * map sits on top and is either clipped by a draggable divider (swipe) or
 * faded (opacity). Each side is described by a `side` object:
 *
 *   { kind: 'tiles', date }                    daily VIIRS true colour (NASA GIBS)
 *   { kind: 'image', url, coordinates }        the detection's own Sentinel image
 *
 * An optional `outline` (GeoJSON) draws the detected extent on both maps and
 * can be toggled — the change mask over the imagery it came from.
 */
import { IMAGERY } from './catalog.js';
import { maplibregl } from './engine.js';

const EMPTY = { type: 'FeatureCollection', features: [] };

function imagerySource(side) {
    if (side.kind === 'image') return { type: 'image', url: side.url, coordinates: side.coordinates };
    return {
        type: 'raster', tiles: IMAGERY.tiles(side.date), tileSize: 256,
        maxzoom: IMAGERY.maxzoom, attribution: IMAGERY.attribution,
    };
}

function style(side, outline, color) {
    return {
        version: 8,
        sources: { imagery: imagerySource(side), outline: { type: 'geojson', data: outline || EMPTY } },
        layers: [
            { id: 'bg', type: 'background', paint: { 'background-color': '#0b0f14' } },
            { id: 'imagery', type: 'raster', source: 'imagery', paint: { 'raster-fade-duration': 0 } },
            { id: 'outline', type: 'line', source: 'outline', paint: { 'line-color': color, 'line-width': 1.6 } },
        ],
    };
}

/**
 * @param {HTMLElement} root  element containing .cmp-after, .cmp-before, .cmp-divider
 * @param {{before: object, after: object, bounds?: number[][], center?: number[], zoom?: number,
 *          maxZoom?: number, outline?: object, outlineColor?: string}} opts
 */
export function createCompare(root, opts) {
    const afterEl = root.querySelector('.cmp-after');
    const beforeEl = root.querySelector('.cmp-before');
    const divider = root.querySelector('.cmp-divider');
    const color = opts.outlineColor || '#ffffff';
    const common = {
        maxZoom: opts.maxZoom ?? 10.5, attributionControl: false, dragRotate: false, pitchWithRotate: false,
        ...(opts.bounds
            ? { bounds: opts.bounds, fitBoundsOptions: { padding: 28 } }
            : { center: opts.center, zoom: Math.min(opts.zoom ?? 8, 9.5) }),
    };
    const after = new maplibregl.Map({ container: afterEl, style: style(opts.after, opts.outline, color), ...common });
    const before = new maplibregl.Map({ container: beforeEl, style: style(opts.before, opts.outline, color), ...common });
    after.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
    after.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

    // Keep the two views locked together (guard against feedback loops).
    let syncing = false;
    const link = (from, to) => from.on('move', () => {
        if (syncing) return;
        syncing = true;
        to.jumpTo({ center: from.getCenter(), zoom: from.getZoom() });
        syncing = false;
    });
    link(after, before);
    link(before, after);

    let mode = 'swipe';
    let split = 50;     // % of width showing "before"
    let fade = 50;      // % opacity of "before" in fade mode

    function apply() {
        if (mode === 'swipe') {
            beforeEl.style.clipPath = `inset(0 ${100 - split}% 0 0)`;
            beforeEl.style.opacity = '1';
            divider.style.display = '';
            divider.style.left = `${split}%`;
            divider.setAttribute('aria-valuenow', String(Math.round(split)));
        } else {
            beforeEl.style.clipPath = 'none';
            beforeEl.style.opacity = String(fade / 100);
            divider.style.display = 'none';
        }
    }

    function setSplitFromClientX(clientX) {
        const rect = root.getBoundingClientRect();
        split = Math.min(98, Math.max(2, ((clientX - rect.left) / rect.width) * 100));
        apply();
    }
    const onPointerMove = (e) => setSplitFromClientX(e.clientX);
    const onPointerUp = () => {
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
    };
    divider.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
    });
    divider.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft') split = Math.max(2, split - 4);
        else if (e.key === 'ArrowRight') split = Math.min(98, split + 4);
        else return;
        e.preventDefault();
        apply();
    });
    apply();

    const whenLoaded = (map, fn) => { if (map.isStyleLoaded()) fn(); else map.once('load', fn); };

    return {
        /** Change the date of tile-based sides (no-op for fixed images). */
        setDates(beforeDate, afterDate) {
            [[before, opts.before, beforeDate], [after, opts.after, afterDate]].forEach(([map, side, date]) => {
                if (side.kind !== 'tiles') return;
                whenLoaded(map, () => map.getSource('imagery').setTiles(IMAGERY.tiles(date)));
            });
        },
        setOutlineVisible(visible) {
            [before, after].forEach((map) => whenLoaded(map, () => map.setLayoutProperty(
                'outline', 'visibility', visible ? 'visible' : 'none')));
        },
        setMode(next) { mode = next === 'fade' ? 'fade' : 'swipe'; apply(); },
        setFade(percent) { fade = Math.min(100, Math.max(0, Number(percent))); apply(); },
        destroy() {
            onPointerUp();
            before.remove();
            after.remove();
        },
    };
}
