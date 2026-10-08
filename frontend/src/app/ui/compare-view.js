/**
 * Before / after view for the selected event (overlay on the map area).
 *
 * Satellite detections compare the two Sentinel images the detector actually
 * used, with the detected extent drawn over both (toggle). Other events fall
 * back to daily VIIRS true colour for two editable dates — real imagery for
 * the eye, explicitly not a change mask.
 */
import { esc, fmtDate } from '../format.js';
import { EXTENT_COLORS, IMAGERY, latestImageryDay } from '../map/catalog.js';
import { createCompare } from '../map/compare.js';
import { compareDates, eventBounds } from '../model.js';
import { data, ui } from '../state.js';
import { on } from './dom.js';

export function mountCompare(root, getMapView) {
    let ctl = null;
    let dates = null;

    const close = () => ui.set({ compare: false });

    function shell(title, controls, note) {
        root.hidden = false;
        root.innerHTML = `
            <div class="cmp-bar">
                <strong>Before / after — ${esc(title)}</strong>
                ${controls}
                <div class="seg" role="group" aria-label="Comparison mode">
                    <button type="button" class="is-on" data-mode="swipe" aria-pressed="true">Swipe</button>
                    <button type="button" data-mode="fade" aria-pressed="false">Fade</button>
                </div>
                <label class="cmp-fade" hidden>Before opacity <input type="range" min="0" max="100" value="50" data-fade></label>
                <button type="button" class="btn btn-sm" data-action="close-compare">Close</button>
            </div>
            <div class="cmp-stage">
                <div class="cmp-after"></div>
                <div class="cmp-before"></div>
                <div class="cmp-divider" role="slider" tabindex="0" aria-label="Swipe position" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50"><span></span></div>
                <span class="cmp-label cmp-label-before"></span>
                <span class="cmp-label cmp-label-after"></span>
            </div>
            <p class="cmp-note">${note}</p>`;
    }

    function labels(before, after) {
        root.querySelector('.cmp-label-before').textContent = `Before · ${fmtDate(before)}`;
        root.querySelector('.cmp-label-after').textContent = `After · ${fmtDate(after)}`;
    }

    function openDetection(event, g) {
        const find = (id) => g.overlays.find((o) => o.id === id);
        const [b, a] = [find('before'), find('after')];
        const side = (o) => ({ kind: 'image', url: o.url, coordinates: g.overlay_coordinates });
        shell(event.title,
            '<label class="check cmp-check"><input type="checkbox" data-outline checked><span>Show detected extent</span></label>',
            `${esc(b.label.replace(', before', ''))} — the two images the detector compared, with its detected extent outlined.
             ${g.extent.patch_count} patch${g.extent.patch_count === 1 ? '' : 'es'}. Baseline method; check the outline against what you can see.`);
        ctl = createCompare(root.querySelector('.cmp-stage'), {
            before: side(b), after: side(a), maxZoom: 15,
            bounds: [[g.bbox.west, g.bbox.south], [g.bbox.east, g.bbox.north]],
            outline: g.extent, outlineColor: EXTENT_COLORS[event.type] || '#ffffff',
        });
        labels(b.date, a.date);
    }

    function openDaily(event) {
        dates = compareDates(event);
        const bnd = eventBounds(event);
        const today = latestImageryDay();
        shell(event.title, `
            <label>Before <input type="date" data-cmp="before" value="${dates.before}" max="${today}"></label>
            <label>After <input type="date" data-cmp="after" value="${dates.after}" max="${today}"></label>`,
            `${esc(IMAGERY.provider)} ${esc(IMAGERY.label)} (${esc(IMAGERY.resolution)}). Real imagery for visual comparison —
             clouds may hide the ground. This is not a change mask;
             run a satellite analysis for this area to get one.`);
        ctl = createCompare(root.querySelector('.cmp-stage'), {
            before: { kind: 'tiles', date: dates.before }, after: { kind: 'tiles', date: dates.after },
            center: [(bnd[0][0] + bnd[1][0]) / 2, (bnd[0][1] + bnd[1][1]) / 2],
            zoom: Math.min(8.5, getMapView().zoom),
        });
        labels(dates.before, dates.after);
    }

    function open() {
        const detail = data.get().detail.data;
        if (!detail) { close(); return; }
        const geometry = data.get().geometry;
        const g = geometry.status === 'ready' && geometry.data.available ? geometry.data : null;
        if (g && g.overlays.some((o) => o.id === 'before') && g.overlays.some((o) => o.id === 'after')) {
            openDetection(detail.event, g);
        } else {
            openDaily(detail.event);
        }
        root.querySelector('[data-action="close-compare"]').focus();
    }

    function teardown() {
        ctl?.destroy();
        ctl = null;
        root.hidden = true;
        root.innerHTML = '';
    }

    on(root, 'change', '[data-cmp]', (_e, el) => {
        if (!el.value || !ctl) return;
        dates = { ...dates, [el.dataset.cmp]: el.value };
        ctl.setDates(dates.before, dates.after);
        labels(dates.before, dates.after);
    });
    on(root, 'change', '[data-outline]', (_e, el) => ctl?.setOutlineVisible(el.checked));
    on(root, 'click', '[data-mode]', (_e, el) => {
        root.querySelectorAll('[data-mode]').forEach((b) => {
            const active = b === el;
            b.classList.toggle('is-on', active);
            b.setAttribute('aria-pressed', String(active));
        });
        root.querySelector('.cmp-fade').hidden = el.dataset.mode !== 'fade';
        ctl?.setMode(el.dataset.mode);
    });
    on(root, 'input', '[data-fade]', (_e, el) => ctl?.setFade(el.value));
    on(root, 'click', '[data-action="close-compare"]', close);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ui.get().compare) close(); });

    ui.subscribe((s) => { if (s.compare) open(); else teardown(); }, (s) => s.compare);
}
