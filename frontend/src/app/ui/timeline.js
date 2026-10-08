/**
 * Timeline — twelve months of real events on one axis, plus the imagery date.
 *
 * Bars are each event's actual start→end; nothing is animated or simulated.
 * Click or drag on the track (or use the arrow keys) to set the date of the
 * daily satellite layer; click an event mark to select it.
 */
import { selectEvent, setImageryDate } from '../actions.js';
import { esc, fmtDate, isoDay, monthLabel } from '../format.js';
import { RANGE_PRESETS, eventSpan, filterEvents, fractionToDate, timeFraction, timelineWindow } from '../model.js';
import { data, filters, mapState } from '../state.js';
import { on } from './dom.js';

const DAY = 86400000;
const LANES = 4;

function render(root) {
    const now = new Date();
    const win = timelineWindow(now);
    const { events, selectedId } = data.get();
    const f = filters.get();
    const { imageryDate, layers } = mapState.get();
    const items = filterEvents(events.data?.items || [], f, now);

    const ticks = win.ticks.map((t) => {
        const x = timeFraction(t, win) * 100;
        const jan = t.getUTCMonth() === 0;
        return `<span class="tl-tick${jan ? ' tl-year' : ''}" style="left:${x.toFixed(2)}%">${jan ? t.getUTCFullYear() : monthLabel(t)}</span>`;
    }).join('');

    // Shade what the active range filter excludes.
    const preset = RANGE_PRESETS.find((p) => p.id === f.rangeId);
    const shade = preset && preset.days
        ? `<span class="tl-shade" style="width:${(timeFraction(new Date(now.getTime() - preset.days * DAY), win) * 100).toFixed(2)}%"></span>` : '';

    const marks = items.map((e, i) => {
        const [start, end] = eventSpan(e, now);
        const x0 = timeFraction(start, win) * 100;
        const x1 = timeFraction(end, win) * 100;
        if (x1 <= 0 && x0 <= 0 && end < win.start) return '';
        const width = Math.max(0.6, x1 - x0);
        const label = `${e.title}, ${e.severity}, ${fmtDate(start)}${e.status === 'past' ? ` to ${fmtDate(end)}` : ', current'}`;
        return `<button type="button" class="tl-mark tl-${esc(e.severity)}${e.id === selectedId ? ' is-selected' : ''}${e.kind === 'forecast' ? ' tl-forecast' : ''}"
            style="left:${x0.toFixed(2)}%;width:${width.toFixed(2)}%;top:${4 + (i % LANES) * 7}px"
            data-event="${esc(e.id)}" title="${esc(label)}" aria-label="${esc(label)}"></button>`;
    }).join('');

    const today = timeFraction(now, win) * 100;
    const cursor = timeFraction(imageryDate, win);
    const imageryOn = layers.imagery?.on;
    root.innerHTML = `
        <div class="tl-info">
            <span class="tl-title">Timeline</span>
            <span class="muted">${items.length} event${items.length === 1 ? '' : 's'} · last 12 months</span>
            <span class="tl-date">Imagery date <strong>${esc(fmtDate(imageryDate))}</strong>
                ${imageryOn ? '' : '<button type="button" class="link" data-action="show-imagery">Show imagery</button>'}</span>
        </div>
        <div class="tl-track" tabindex="0" role="slider" aria-label="Imagery date"
            aria-valuemin="0" aria-valuemax="100" aria-valuenow="${cursor === null ? 0 : Math.round(cursor * 100)}"
            aria-valuetext="${esc(fmtDate(imageryDate))}">
            ${shade}
            <span class="tl-today" style="left:${today.toFixed(2)}%" title="Today"></span>
            ${marks}
            ${cursor === null ? '' : `<span class="tl-cursor" style="left:${(cursor * 100).toFixed(2)}%"></span>`}
        </div>
        <div class="tl-axis" aria-hidden="true">${ticks}</div>`;
}

export function mountTimeline(root) {
    const dateFromPointer = (e) => {
        const track = root.querySelector('.tl-track');
        const rect = track.getBoundingClientRect();
        const win = timelineWindow();
        const d = fractionToDate((e.clientX - rect.left) / rect.width, win);
        const latest = new Date(Date.now() - DAY);          // no imagery for the future
        return isoDay(d > latest ? latest : d);
    };
    let dragging = false;
    root.addEventListener('pointerdown', (e) => {
        if (!(e.target instanceof Element) || !e.target.closest('.tl-track') || e.target.closest('.tl-mark')) return;
        dragging = true;
        setImageryDate(dateFromPointer(e));
    });
    window.addEventListener('pointermove', (e) => { if (dragging) setImageryDate(dateFromPointer(e)); });
    window.addEventListener('pointerup', () => { dragging = false; });

    on(root, 'keydown', '.tl-track', (e) => {
        const step = { ArrowLeft: -1, ArrowRight: 1, PageDown: -30, PageUp: 30 }[e.key];
        if (!step) return;
        e.preventDefault();
        const current = new Date(`${mapState.get().imageryDate}T00:00:00Z`).getTime();
        const next = Math.min(Date.now() - DAY, current + step * DAY);
        setImageryDate(isoDay(new Date(next)));
        root.querySelector('.tl-track')?.focus();
    });
    on(root, 'click', '[data-event]', (_e, el) => selectEvent(el.dataset.event));
    on(root, 'click', '[data-action="show-imagery"]', () => setImageryDate(mapState.get().imageryDate, { show: true }));

    const draw = () => {
        const hadFocus = root.contains(document.activeElement) && document.activeElement.classList.contains('tl-track');
        render(root);
        if (hadFocus) root.querySelector('.tl-track')?.focus();
    };
    data.subscribe(draw, (s) => s.events);
    data.subscribe(draw, (s) => s.selectedId);
    filters.subscribe(draw);
    mapState.subscribe(draw, (s) => s.imageryDate);
    mapState.subscribe(draw, (s) => s.layers);
    draw();
}
