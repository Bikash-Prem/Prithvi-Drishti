/**
 * Assistant panel. Answers arrive structured (assessment, factors,
 * confidence, evidence, caveats) with map actions that have already been
 * applied; "Show on map" re-applies them. The backend assembles answers from
 * event evidence — the page never invents content.
 */
import { askAssistant, runActions, selectEvent } from '../actions.js';
import { esc } from '../format.js';
import { assistant, data } from '../state.js';
import { dataBadge, on, severityBadge, stateBlock } from './dom.js';

const SUGGESTIONS = [
    'Which events are most severe?',
    'Why is this event rated the way it is?',
    'Show Kathmandu',
    'System status',
];

function answerHtml(m, index) {
    if (m.error) return stateBlock({ kind: 'error', title: m.error.title, text: m.error.text });
    const a = m.answer;
    const list = (title, items) => (items.length
        ? `<h4>${esc(title)}</h4><ul class="bullets">${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '');
    const items = a.items.length ? `<ul class="answer-items">${a.items.map((it) => `
        <li>${it.event_id
            ? `<button type="button" class="link" data-event="${esc(it.event_id)}">${esc(it.title)}</button>`
            : `<span>${esc(it.title)}</span>`}
            ${it.severity ? severityBadge(it.severity) : ''}${it.data_status ? dataBadge(it.data_status) : ''}
            <p class="kv-note">${esc(it.detail || '')}</p></li>`).join('')}</ul>` : '';
    const evidence = a.evidence.length ? `<h4>Evidence</h4><ul class="chips-static">${a.evidence.map((e) => `
        <li>${esc(e.role)}: ${esc(e.source)} ${dataBadge(e.data_status)}</li>`).join('')}</ul>` : '';
    return `
        <article class="answer">
            <header><h3>${esc(a.title)}</h3>${a.risk_level ? severityBadge(a.risk_level) : ''}</header>
            <p>${esc(a.summary)}</p>
            ${(a.statements || []).length ? `<ul class="stmts">${a.statements.map((s) => `
                <li class="stmt stmt-${esc(s.tag.toLowerCase())}"><span class="stmt-tag">${esc(s.tag)}</span><p>${esc(s.text)}</p></li>`).join('')}</ul>` : ''}
            ${items}
            ${(a.statements || []).length ? '' : list('Primary factors', a.factors)}
            ${a.confidence ? `<p class="answer-conf"><strong>Confidence:</strong> ${esc(a.confidence)}</p>` : ''}
            ${evidence}
            ${list('Limits of this answer', a.caveats)}
            ${m.actions && m.actions.length ? `<button type="button" class="btn btn-sm" data-replay="${index}">Show on map</button>` : ''}
        </article>`;
}

function render(log, busyEl) {
    const { messages, busy } = assistant.get();
    if (!messages.length) {
        log.innerHTML = `
            <div class="assistant-intro">
                <p>Ask about the events on the map. Answers are built from the same forecast and feed data shown in the event panel, and they move the map.</p>
                <ul class="suggestions">${SUGGESTIONS.map((s) => `<li><button type="button" class="chip" data-suggest="${esc(s)}">${esc(s)}</button></li>`).join('')}</ul>
            </div>`;
    } else {
        log.innerHTML = messages.map((m, i) => (m.role === 'user'
            ? `<p class="msg-user"><span class="sr-only">You asked: </span>${esc(m.text)}</p>`
            : answerHtml(m, i))).join('');
        log.scrollTop = log.scrollHeight;
    }
    busyEl.hidden = !busy;
}

export function mountAssistantPanel(root) {
    root.innerHTML = `
        <div class="assistant-log" role="log" aria-live="polite" aria-label="Conversation"></div>
        <p class="assistant-busy" hidden><span class="spinner spinner-sm" aria-hidden="true"></span> Checking the evidence…</p>
        <form class="assistant-form">
            <label class="sr-only" for="assistant-input">Ask the assistant</label>
            <input id="assistant-input" type="text" maxlength="500" autocomplete="off" placeholder="Ask about an event or place…">
            <button type="submit" class="btn btn-primary">Ask</button>
        </form>
        <p class="assistant-context muted"></p>`;
    const log = root.querySelector('.assistant-log');
    const busyEl = root.querySelector('.assistant-busy');
    const input = root.querySelector('#assistant-input');
    const context = root.querySelector('.assistant-context');

    root.querySelector('form').addEventListener('submit', (e) => {
        e.preventDefault();
        const text = input.value;
        input.value = '';
        askAssistant(text);
    });
    on(root, 'click', '[data-suggest]', (_e, el) => askAssistant(el.dataset.suggest));
    on(root, 'click', '[data-event]', (_e, el) => selectEvent(el.dataset.event));
    on(root, 'click', '[data-replay]', (_e, el) => runActions(assistant.get().messages[Number(el.dataset.replay)]?.actions));

    const drawContext = () => {
        const { selectedId, events } = data.get();
        const ev = (events.data?.items || []).find((x) => x.id === selectedId);
        context.textContent = ev ? `Context: ${ev.title}` : 'No event selected — questions apply to all events.';
    };
    assistant.subscribe(() => render(log, busyEl));
    data.subscribe(drawContext, (s) => s.selectedId);
    data.subscribe(drawContext, (s) => s.events);
    render(log, busyEl);
    drawContext();
}
