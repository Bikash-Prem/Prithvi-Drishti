/**
 * Global search (header): places, coordinates and events. Debounced, with
 * the previous request cancelled, and a keyboard-navigable result list.
 */
import { goTo, selectEvent, setAoi } from '../actions.js';
import { api, ApiError, describeError } from '../api.js';
import { esc, fmtNumber } from '../format.js';
import { severityBadge } from './dom.js';

const KIND_LABEL = { place: 'Place', event: 'Event', coordinates: 'Coordinates' };

export function mountSearch(form) {
    const input = form.querySelector('input');
    const list = form.querySelector('.search-results');
    let results = [];
    let active = -1;
    let abort = null;
    let timer = null;

    const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; };
    const open = () => { list.hidden = false; input.setAttribute('aria-expanded', 'true'); };

    function show(html) { list.innerHTML = html; open(); }

    function renderResults(note = '') {
        if (!results.length) {
            show(`<li class="search-empty" role="status">No matches.${note ? ` ${esc(note)}` : ''}</li>`);
            return;
        }
        show(results.map((r, i) => {
            const extra = r.kind === 'place'
                ? [r.population ? `pop. ${fmtNumber(r.population)}` : '',
                    `${r.active_events_nearby} current event${r.active_events_nearby === 1 ? '' : 's'} nearby`].filter(Boolean).join(' · ')
                : '';
            return `
                <li role="option" id="sr-${i}" aria-selected="${i === active}" class="${i === active ? 'is-active' : ''}" data-index="${i}">
                    <span class="search-kind">${esc(KIND_LABEL[r.kind] || r.kind)}</span>
                    <span class="search-main"><strong>${esc(r.title)}</strong>${r.severity ? severityBadge(r.severity) : ''}
                        <small>${esc([r.subtitle, extra].filter(Boolean).join(' · '))}</small></span>
                </li>`;
        }).join('') + (note ? `<li class="search-empty" role="status">${esc(note)}</li>` : ''));
        input.setAttribute('aria-activedescendant', active >= 0 ? `sr-${active}` : '');
    }

    function choose(r) {
        if (!r) return;
        close();
        input.value = r.title;
        if (r.kind === 'event') selectEvent(r.event_id);
        else {
            goTo(r.lat, r.lng);
            // Seed the analysis draft so "search → analyse" is two clicks.
            setAoi({ south: r.lat - 0.12, north: r.lat + 0.12, west: r.lng - 0.15, east: r.lng + 0.15 }, r.title);
        }
    }

    async function run(q) {
        abort?.abort();
        abort = new AbortController();
        show('<li class="search-empty" role="status"><span class="spinner spinner-sm" aria-hidden="true"></span> Searching…</li>');
        try {
            const payload = await api.search(q, abort.signal);
            results = payload.results;
            active = results.length ? 0 : -1;
            renderResults(payload.place_error || '');
        } catch (e) {
            if (e instanceof ApiError && e.kind === 'cancelled') return;
            results = [];
            show(`<li class="search-empty" role="alert">${esc(describeError(e).title)}</li>`);
        }
    }

    input.addEventListener('input', () => {
        clearTimeout(timer);
        const q = input.value.trim();
        if (q.length < 2) { abort?.abort(); close(); return; }
        timer = setTimeout(() => run(q), 280);
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { close(); return; }
        if (list.hidden || !results.length) return;
        if (e.key === 'ArrowDown') { active = (active + 1) % results.length; renderResults(); e.preventDefault(); }
        if (e.key === 'ArrowUp') { active = (active - 1 + results.length) % results.length; renderResults(); e.preventDefault(); }
    });
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (!list.hidden && results.length) choose(results[Math.max(0, active)]);
        else if (input.value.trim().length >= 2) { clearTimeout(timer); run(input.value.trim()); }
    });
    list.addEventListener('mousedown', (e) => {
        const li = e.target instanceof Element ? e.target.closest('[data-index]') : null;
        if (li) { e.preventDefault(); choose(results[Number(li.dataset.index)]); }
    });
    document.addEventListener('click', (e) => { if (!form.contains(e.target)) close(); });
}
