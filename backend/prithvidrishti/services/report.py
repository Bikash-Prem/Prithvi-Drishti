"""
Printable event report (self-contained HTML).

Built only from an ``EventDetail`` — the same payload the dashboard shows —
so a report can never say something the system does not hold. Every dynamic
string is escaped.
"""

from __future__ import annotations

from datetime import UTC, datetime
from html import escape as e
from typing import Any

from prithvidrishti.services.events import EventDetail, Measure

_CSS = """
body{font:14px/1.55 -apple-system,'Segoe UI',Inter,sans-serif;color:#15202b;max-width:820px;margin:32px auto;padding:0 24px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#52606d;
border-bottom:1px solid #d5dbe1;padding-bottom:4px;margin:28px 0 10px}
.meta{color:#52606d}.sev{display:inline-block;border:1.5px solid #15202b;border-radius:4px;padding:2px 10px;font-weight:700;
text-transform:uppercase;letter-spacing:.04em;margin-top:8px}
table{border-collapse:collapse;width:100%}td,th{text-align:left;vertical-align:top;padding:6px 8px;border-bottom:1px solid #e3e8ed}
th{width:34%;font-weight:600;color:#33404d}.na{color:#7b8794}.tag{font:600 10.5px/1 ui-monospace,monospace;
border:1px solid #9aa5b1;border-radius:3px;padding:2px 5px;margin-right:6px;white-space:nowrap}
.small{font-size:12px;color:#52606d}.bar{margin:0 0 20px;display:flex;gap:8px}
button{font:inherit;padding:6px 14px;border:1px solid #9aa5b1;border-radius:4px;background:#fff;cursor:pointer}
.demo{border:1px solid #7c5cd6;padding:8px 12px;border-radius:4px;margin:12px 0}
@media print{.bar{display:none}body{margin:0}}
"""


def _measure(m: Measure, digits: int = 0) -> str:
    if m.status != "available" or m.value is None:
        word = "Not assessed" if m.status == "not_assessed" else "Not available"
        return f'<span class="na">{word}</span> <span class="small">— {e(m.reason or "")}</span>'
    text = f"{m.value:,.{digits}f}{'+' if m.lower_bound else ''} {e(m.unit)}"
    if m.low is not None and m.high is not None and m.low != m.high:
        text += f' <span class="small">(range {m.low:,.{digits}f}–{m.high:,.{digits}f})</span>'
    if m.source:
        text += f' <span class="small">· {e(m.source)}</span>'
    return text


def _rows(pairs: list[tuple[str, str]]) -> str:
    return "<table>" + "".join(f"<tr><th>{e(k)}</th><td>{v}</td></tr>" for k, v in pairs) + "</table>"


def _range(u: dict[str, Any]) -> str:
    if u.get("unit") in ("time", "text"):
        return e(str(u.get("value")))
    if u.get("unit") == "fraction":
        return f"{float(u['value']):.0%}" if u.get("value") is not None else "—"
    d = u.get("decimals", 2)
    if u.get("low") is None or u.get("high") is None:
        return f"{float(u['value']):,.{d}f} {e(u.get('unit', ''))}"
    return f"{float(u['low']):,.{d}f} – {float(u['high']):,.{d}f} {e(u.get('unit', ''))}"


def build_report(detail: EventDetail) -> str:
    ev = detail.event
    conf = (ev.confidence.label or
            (f"{ev.confidence.value:.0%} ensemble agreement" if ev.confidence.value is not None
             else "Not provided by the source"))
    kind = {"forecast": "Forecast", "reported": "Externally reported event",
            "detected": "Satellite detection"}[ev.kind]
    statements = "".join(
        f'<tr><td style="width:110px"><span class="tag">{e(s["tag"])}</span></td><td>{e(s["text"])}</td></tr>'
        for s in detail.statements)
    risk_rows = [(c.name.capitalize(),
                  f"<strong>{e(c.label)}</strong><br><span class='small'>{e(c.basis)}</span>")
                 for c in detail.risk.components]
    risk_rows.append(("Overall", f"<strong>{e(detail.risk.level.upper())}</strong>"
                                 + ("" if detail.risk.complete else f" <span class='small'>(incomplete — {e(detail.risk.basis)})</span>")
                                 + f"<br><span class='small'>{e(detail.risk.explanation)}</span>"))
    evidence = "".join(
        f"<tr><th>{e(x.role)}</th><td><strong>{e(x.source)}</strong>"
        f"{' · ' + e(x.version) if x.version else ''}<br><span class='small'>{e(x.detail)}"
        f"{' · ' + e(x.timestamp[:16].replace('T', ' ')) + ' UTC' if x.timestamp else ''}"
        f"{' · ' + e(x.url) if x.url else ''}</span></td></tr>" for x in detail.evidence)
    metrics = _rows([(m["label"], f"{e(str(m['value']))} {e(m.get('unit', ''))}"
                      + (f" <span class='small'>— {e(m['note'])}</span>" if m.get("note") else ""))
                     for m in detail.metrics]) if detail.metrics else ""
    uncertainty = _rows([(u["label"], f"{_range(u)}<br><span class='small'>{e(u.get('explanation', ''))}</span>")
                         for u in detail.uncertainty]) if detail.uncertainty else "<p class='na'>No ranges available.</p>"
    missing = _rows([(n["item"], e(n["reason"])) for n in detail.not_available])
    method = ""
    if detail.risk_method:
        rm = detail.risk_method
        method = "<h2>How risk was assessed</h2>" + _rows([
            ("Method", f"{e(rm['id'])} {e(rm['version'])} — {e(rm['summary'])}"),
            ("Hazard bands (km²)", e(", ".join(f"{k}: {v}" for k, v in rm["hazard_bands_km2"].items()))),
            ("Exposure bands (people)", e(", ".join(f"{k}: {v}" for k, v in rm["exposure_bands_people"].items()))),
            ("Exposure rule", e(rm["exposure_rule"])), ("Combination", e(rm["matrix"])),
            ("Vulnerability", e(rm["vulnerability"])),
        ])
    period = e(ev.detected_at[:10]) + (f" – {e(ev.ended_at[:10])}" if ev.ended_at else "")
    demo = (f'<div class="demo"><strong>Demo data.</strong> {e(ev.data_status_note or "")}</div>'
            if ev.data_status == "demo" else "")
    return f"""<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>{e(ev.title)} — event report</title><style>{_CSS}</style></head><body>
<div class="bar"><button onclick="window.print()">Print / save as PDF</button></div>
<p class="meta">Prithvi Drishti — environmental event report</p>
<h1>{e(ev.title)}</h1>
<p class="meta">{e(kind)} · {e(ev.location_name)} · {period} · source: {e(ev.source.provider)}</p>
<span class="sev">{e(ev.severity)}</span>{demo}
<h2>Summary</h2>{_rows([
    ("Confidence", e(conf) + f"<br><span class='small'>{e(ev.confidence.explanation)}</span>"),
    ("Affected area", _measure(ev.affected_area_km2, 2)),
    ("Population exposed", _measure(ev.population_exposed)),
    ("Critical facilities", _measure(ev.assets_exposed)),
    ("Centre", f"{ev.center['lat']:.4f}, {ev.center['lng']:.4f}"),
])}
<h2>Assessment</h2><table>{statements}</table>
{"<h2>Measurements</h2>" + metrics if metrics else ""}
<h2>Risk</h2>{_rows(risk_rows)}
<h2>Uncertainty</h2>{uncertainty}
<h2>Evidence</h2><table>{evidence}</table>
<h2>Not available / limitations</h2>{missing}
{method}
<p class="small" style="margin-top:28px">Generated {datetime.now(UTC):%d %b %Y %H:%M} UTC from the platform's stored
event record. Figures are estimates from the sources listed above; ranges show known uncertainty.</p>
</body></html>"""
