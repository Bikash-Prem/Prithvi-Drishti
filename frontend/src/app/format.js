/**
 * Formatting helpers — pure, no DOM. Everything the UI prints goes through
 * here so "unknown" is always rendered as unknown, never as 0, NaN or "—".
 */

/** Severity presentation. Icon shape differs per level so colour is never the only cue. */
export const SEVERITY = {
    low: { label: 'Low', icon: '●', rank: 0 },
    medium: { label: 'Medium', icon: '◆', rank: 1 },
    high: { label: 'High', icon: '▲', rank: 2 },
    critical: { label: 'Critical', icon: '■', rank: 3 },
};

export const DATA_STATUS = {
    live: { label: 'Live data', short: 'LIVE' },
    demo: { label: 'Demo data', short: 'DEMO' },
    unavailable: { label: 'Unavailable', short: 'N/A' },
};

/** Backend timestamps are UTC but often lack a zone suffix — parse them as UTC. */
export function parseTime(value) {
    if (!value) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    let s = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += 'T00:00:00';
    if (!/(Z|[+-]\d{2}:?\d{2})$/.test(s)) s += 'Z';
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
}

export function timeAgo(value, now = new Date()) {
    const d = parseTime(value);
    if (!d) return 'time unknown';
    const sec = Math.round((now.getTime() - d.getTime()) / 1000);
    if (sec < 0) return `in ${humanSpan(-sec)}`;
    if (sec < 45) return 'just now';
    return `${humanSpan(sec)} ago`;
}

function humanSpan(sec) {
    if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))} min`;
    if (sec < 86400) return `${Math.round(sec / 3600)} h`;
    if (sec < 86400 * 60) return `${Math.round(sec / 86400)} d`;
    if (sec < 86400 * 365) return `${Math.round(sec / (86400 * 30))} mo`;
    return `${(sec / (86400 * 365)).toFixed(1)} y`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function fmtDate(value) {
    const d = parseTime(value);
    if (!d) return 'Date unknown';
    return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function fmtDateTime(value) {
    const d = parseTime(value);
    if (!d) return 'Time unknown';
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    return `${fmtDate(d)}, ${hh}:${mm} UTC`;
}

/** YYYY-MM-DD in UTC — the form date inputs and imagery URLs need. */
export function isoDay(value) {
    const d = parseTime(value);
    return d ? d.toISOString().slice(0, 10) : '';
}

export function monthLabel(date) {
    return MONTHS[date.getUTCMonth()];
}

export function fmtNumber(n, digits = 0) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return null;
    return Number(n).toLocaleString('en-US', {
        minimumFractionDigits: digits, maximumFractionDigits: digits,
    });
}

export function fmtPercent(fraction) {
    if (fraction === null || fraction === undefined || Number.isNaN(Number(fraction))) return null;
    return `${Math.round(Number(fraction) * 100)}%`;
}

/**
 * Render a backend `Measure` ({status, value, low, high, unit, reason}).
 * @returns {{available: boolean, text: string, reason: string}}
 */
export function measureText(measure, digits = 0) {
    if (!measure || measure.status !== 'available' || measure.value === null || measure.value === undefined) {
        const notAssessed = measure && measure.status === 'not_assessed';
        return {
            available: false,
            text: notAssessed ? 'Not assessed' : 'Not available',
            reason: (measure && measure.reason) || 'No data.',
        };
    }
    const unit = measure.unit ? ` ${measure.unit}` : '';
    const hasRange = measure.low !== null && measure.low !== undefined
        && measure.high !== null && measure.high !== undefined && measure.low !== measure.high;
    const plus = measure.lower_bound ? '+' : '';
    // Lead with the central estimate; the range rides along as secondary text.
    const text = `${fmtNumber(measure.value, digits)}${plus}${unit}`;
    const range = hasRange ? `${fmtNumber(measure.low, digits)}–${fmtNumber(measure.high, digits)}` : '';
    return { available: true, text, range, reason: measure.source || '' };
}

/** "0.05–2.00 m" style range for the uncertainty table. */
export function rangeText(item) {
    if (item.unit === 'time') {
        if (!item.low || !item.high) return fmtDateTime(item.value);
        return `${fmtDateTime(item.low)} → ${fmtDateTime(item.high)}`;
    }
    if (item.unit === 'fraction') return fmtPercent(item.value) ?? 'Not available';
    if (item.unit === 'text') return String(item.value ?? 'Not available');
    const digits = item.decimals ?? 2;
    const unit = item.unit ? ` ${item.unit}` : '';
    if (item.low === null || item.low === undefined || item.high === null || item.high === undefined) {
        return item.value === null || item.value === undefined
            ? 'Not available' : `${fmtNumber(item.value, digits)}${unit}`;
    }
    if (item.low === item.high) return `${fmtNumber(item.value, digits)}${unit} (no spread)`;
    return `${fmtNumber(item.low, digits)}–${fmtNumber(item.high, digits)}${unit}`;
}

export function assetLabel(type) {
    const s = String(type || '').replace(/_/g, ' ');
    return s ? s[0].toUpperCase() + s.slice(1) : 'Facility';
}

export function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}
