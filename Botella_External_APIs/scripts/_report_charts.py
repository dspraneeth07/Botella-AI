"""Inline SVG charts for the backtest report. No matplotlib, no CDN, no fonts.

WHY HAND-ROLLED SVG AND NOT A CHART LIBRARY
    This report gets emailed. It has to open from a file:// URL, on a laptop
    with no network, six months from now, and still render. A CDN <script> tag
    fails silently in exactly that situation and leaves a blank rectangle where
    the evidence used to be - which is worse than no chart, because the reader
    cannot tell whether the chart is missing or the result is.

    Embedded PNGs would survive, but they need matplotlib, which the pipeline
    deliberately does not depend on. SVG costs a few hundred lines and depends
    on nothing.

Every function here takes plain numbers and returns a string. No state, no
files, no I/O - so each one is trivially testable and none of them can fail
halfway through a report.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any

# The palette is duplicated as literals rather than imported from the CSS,
# because an SVG attribute cannot read a CSS custom property. Kept in one place
# here so a theme change is one edit.
BLUE = "#2563eb"
GREY = "#cbd5e1"
GREEN = "#059669"
RED = "#dc2626"
AXIS = "#94a3b8"
TEXT = "#475569"


def _esc(s: Any) -> str:
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _svg(w: int, h: int, body: str, title: str) -> str:
    return (
        f'<div class="scroll"><svg viewBox="0 0 {w} {h}" width="100%" '
        f'style="max-width:{w}px;height:auto" role="img" '
        f'aria-label="{_esc(title)}" xmlns="http://www.w3.org/2000/svg">'
        f"{body}</svg></div>"
    )


def horizon_bars(by_horizon: dict[str, dict], horizons: list[int]) -> str:
    """Engine against the hard null, per horizon, with 95% whiskers.

    The whiskers are the point of it. Two bars without intervals invite the
    reader to believe a two-point difference; with them, they can see for
    themselves which gaps are real.
    """
    W, H = 118, 300
    pad_l, pad_b, top = 46, 46, 18
    plot_h = H - pad_b - top
    n = len(horizons)
    width = pad_l + n * W + 16

    def y(pct: float) -> float:
        return top + plot_h * (1 - pct / 100.0)

    parts = []
    for g in (0, 25, 50, 75, 100):
        yy = y(g)
        parts.append(
            f'<line x1="{pad_l - 6}" y1="{yy:.1f}" x2="{width - 10}" '
            f'y2="{yy:.1f}" stroke="{AXIS}" stroke-width="0.6" '
            f'{"" if g else "stroke-width=\'1.2\'"} opacity="0.45"/>'
            f'<text x="{pad_l - 10}" y="{yy + 4:.1f}" font-size="11" '
            f'text-anchor="end" fill="{TEXT}">{g}%</text>')

    for i, h in enumerate(horizons):
        d = by_horizon.get(str(h))
        if not d:
            continue
        x0 = pad_l + i * W
        eh, nh = d["hit_rate"], d["null_reversion"]
        lo, hi = d["ci_lo"], d["ci_hi"]
        parts.append(
            f'<rect x="{x0 + 10}" y="{y(eh):.1f}" width="40" '
            f'height="{plot_h * eh / 100:.1f}" fill="{BLUE}" rx="2"/>'
            f'<rect x="{x0 + 58}" y="{y(nh):.1f}" width="40" '
            f'height="{plot_h * nh / 100:.1f}" fill="{GREY}" rx="2"/>')
        cx = x0 + 30
        parts.append(
            f'<line x1="{cx}" y1="{y(lo):.1f}" x2="{cx}" y2="{y(hi):.1f}" '
            f'stroke="#0f172a" stroke-width="1.6"/>'
            f'<line x1="{cx - 7}" y1="{y(lo):.1f}" x2="{cx + 7}" '
            f'y2="{y(lo):.1f}" stroke="#0f172a" stroke-width="1.6"/>'
            f'<line x1="{cx - 7}" y1="{y(hi):.1f}" x2="{cx + 7}" '
            f'y2="{y(hi):.1f}" stroke="#0f172a" stroke-width="1.6"/>')
        parts.append(
            f'<text x="{cx}" y="{y(hi) - 7:.1f}" font-size="13" '
            f'font-weight="600" text-anchor="middle" fill="{BLUE}">'
            f'{eh:.0f}%</text>'
            f'<text x="{x0 + 78}" y="{y(nh) - 6:.1f}" font-size="12" '
            f'text-anchor="middle" fill="{TEXT}">{nh:.0f}%</text>'
            f'<text x="{x0 + 54}" y="{H - 24}" font-size="12" '
            f'text-anchor="middle" fill="{TEXT}">{h} days</text>'
            f'<text x="{x0 + 54}" y="{H - 9}" font-size="10" '
            f'text-anchor="middle" fill="{TEXT}">n={d["n"]}</text>')

    parts.append(
        f'<rect x="{pad_l}" y="4" width="10" height="10" fill="{BLUE}"/>'
        f'<text x="{pad_l + 15}" y="13" font-size="11" fill="{TEXT}">engine'
        f'</text>'
        f'<rect x="{pad_l + 68}" y="4" width="10" height="10" fill="{GREY}"/>'
        f'<text x="{pad_l + 83}" y="13" font-size="11" fill="{TEXT}">'
        f'reversion-matched null</text>')
    return _svg(width, H, "".join(parts),
                "hit rate by forecast horizon against the hard null")


def over_time(picks: list[dict]) -> str:
    """Hit rate at every decision date. A result resting on one lucky window
    shows up here as a single tall bar in a field of short ones."""
    by_date: dict[str, list[bool]] = defaultdict(list)
    for r in picks:
        if r.get("measurable") and r.get("lift") is not None:
            by_date[r["as_of"]].append(bool(r["hit"]))
    dates = sorted(by_date)
    if not dates:
        return ""
    W, H = max(720, len(dates) * 13 + 70), 210
    top, pad_b, pad_l = 16, 40, 40
    plot_h = H - top - pad_b
    step = (W - pad_l - 16) / max(len(dates), 1)

    def y(pct: float) -> float:
        return top + plot_h * (1 - pct / 100.0)

    parts = []
    for g in (0, 50, 100):
        yy = y(g)
        parts.append(
            f'<line x1="{pad_l - 4}" y1="{yy:.1f}" x2="{W - 12}" y2="{yy:.1f}" '
            f'stroke="{AXIS}" stroke-width="0.7" opacity="0.5"/>'
            f'<text x="{pad_l - 8}" y="{yy + 4:.1f}" font-size="10" '
            f'text-anchor="end" fill="{TEXT}">{g}%</text>')

    overall = sum(sum(v) for v in by_date.values()) / max(
        sum(len(v) for v in by_date.values()), 1) * 100
    parts.append(
        f'<line x1="{pad_l}" y1="{y(overall):.1f}" x2="{W - 12}" '
        f'y2="{y(overall):.1f}" stroke="{GREEN}" stroke-width="1.4" '
        f'stroke-dasharray="5 4"/>'
        f'<text x="{W - 14}" y="{y(overall) - 6:.1f}" font-size="11" '
        f'text-anchor="end" fill="{GREEN}">overall {overall:.0f}%</text>')

    bw = max(3.0, step - 3)
    for i, d in enumerate(dates):
        v = by_date[d]
        pct = sum(v) / len(v) * 100
        x = pad_l + i * step
        colour = BLUE if pct >= 50 else RED
        parts.append(
            f'<rect x="{x:.1f}" y="{y(pct):.1f}" width="{bw:.1f}" '
            f'height="{plot_h * pct / 100:.1f}" fill="{colour}" opacity="0.85">'
            f'<title>{_esc(d)}: {pct:.0f}% of {len(v)} cards</title></rect>')

    for i in (0, len(dates) // 2, len(dates) - 1):
        parts.append(
            f'<text x="{pad_l + i * step + bw / 2:.1f}" y="{H - 20}" '
            f'font-size="10" text-anchor="middle" fill="{TEXT}">'
            f'{_esc(dates[i])}</text>')
    good = sum(1 for d in dates if sum(by_date[d]) / len(by_date[d]) >= 0.5)
    parts.append(
        f'<text x="{pad_l}" y="{H - 5}" font-size="11" fill="{TEXT}">'
        f'{good} of {len(dates)} decision dates scored 50% or better</text>')
    return _svg(W, H, "".join(parts), "hit rate at every decision date")


def lift_histogram(picks: list[dict]) -> str:
    """Where the lifts actually land. An average hides whether a 1.44 median
    came from many small wins or a few enormous ones."""
    lifts = [r["lift"] for r in picks
             if r.get("measurable") and r.get("lift") is not None]
    if not lifts:
        return ""
    edges = [0, .25, .5, .75, 1.0, 1.25, 1.5, 2.0, 3.0, 99]
    labels = ["0-.25", ".25-.5", ".5-.75", ".75-1", "1-1.25", "1.25-1.5",
              "1.5-2", "2-3", "3+"]
    counts = [0] * (len(edges) - 1)
    for v in lifts:
        for i in range(len(edges) - 1):
            if edges[i] <= v < edges[i + 1]:
                counts[i] += 1
                break
    top_count = max(counts) or 1
    W, H = 720, 232
    pad_l, top, pad_b = 40, 16, 50
    plot_h = H - top - pad_b
    bw = (W - pad_l - 20) / len(counts)
    parts = [f'<line x1="{pad_l}" y1="{top + plot_h}" x2="{W - 16}" '
             f'y2="{top + plot_h}" stroke="{AXIS}" stroke-width="1"/>']
    for i, c in enumerate(counts):
        x = pad_l + i * bw
        h = plot_h * c / top_count
        # Below 1.0 the recommendation did not beat the product's own rate.
        colour = RED if edges[i + 1] <= 1.0 else BLUE
        parts.append(
            f'<rect x="{x + 3:.1f}" y="{top + plot_h - h:.1f}" '
            f'width="{bw - 6:.1f}" height="{h:.1f}" fill="{colour}" '
            f'opacity="0.88" rx="2"/>'
            f'<text x="{x + bw / 2:.1f}" y="{top + plot_h - h - 5:.1f}" '
            f'font-size="11" text-anchor="middle" fill="{TEXT}">{c}</text>'
            f'<text x="{x + bw / 2:.1f}" y="{top + plot_h + 15:.1f}" '
            f'font-size="10" text-anchor="middle" fill="{TEXT}">'
            f'{labels[i]}</text>')
    xline = pad_l + 4 * bw
    parts.append(
        f'<line x1="{xline:.1f}" y1="{top}" x2="{xline:.1f}" '
        f'y2="{top + plot_h}" stroke="#0f172a" stroke-width="1.4" '
        f'stroke-dasharray="4 3"/>'
        f'<text x="{xline + 6:.1f}" y="{top + 12}" font-size="11" '
        f'fill="#0f172a">lift 1.0 - the recommendation changed nothing</text>')
    won = sum(1 for v in lifts if v >= 1.5)
    parts.append(
        f'<text x="{pad_l}" y="{H - 8}" font-size="11" fill="{TEXT}">'
        f'red bars are picks that did NOT beat their own rate &#183; '
        f'{won} of {len(lifts)} cleared 1.5x, production&#39;s winner bar</text>')
    return _svg(W, H, "".join(parts), "distribution of realised lift")


def calibration(picks: list[dict]) -> str:
    """Does a higher p_hit really mean a better pick?

    A confidence that does not track outcomes is worse than none: it ranks the
    cards and it is printed on them. Sheet 08 measured the previous engine at
    0.48 stated against 0.23 actual, which is the reason this chart exists.
    """
    rows = [r for r in picks
            if r.get("measurable") and r.get("p_hit") is not None]
    if len(rows) < 40:
        return ""
    rows.sort(key=lambda r: r["p_hit"])
    k = 5
    size = len(rows) // k
    pts = []
    for i in range(k):
        chunk = rows[i * size:(i + 1) * size] if i < k - 1 else rows[(k - 1) * size:]
        if not chunk:
            continue
        pts.append((sum(c["p_hit"] for c in chunk) / len(chunk),
                    sum(1 for c in chunk if c["hit"]) / len(chunk),
                    len(chunk)))
    if len(pts) < 2:
        return ""
    W, H = 470, 330
    pad_l, pad_b, top = 52, 48, 18
    pw, ph = W - pad_l - 22, H - top - pad_b
    xs = [p[0] for p in pts]
    lo_x, hi_x = min(xs) - 0.02, max(xs) + 0.02

    def px(v: float) -> float:
        return pad_l + pw * (v - lo_x) / max(hi_x - lo_x, 1e-9)

    def py(v: float) -> float:
        return top + ph * (1 - v)

    parts = [f'<rect x="{pad_l}" y="{top}" width="{pw}" height="{ph}" '
             f'fill="none" stroke="{AXIS}" stroke-width="0.8" opacity="0.6"/>']
    for g in (0.0, 0.25, 0.5, 0.75, 1.0):
        parts.append(
            f'<line x1="{pad_l}" y1="{py(g):.1f}" x2="{pad_l + pw}" '
            f'y2="{py(g):.1f}" stroke="{AXIS}" stroke-width="0.5" '
            f'opacity="0.4"/>'
            f'<text x="{pad_l - 8}" y="{py(g) + 4:.1f}" font-size="10" '
            f'text-anchor="end" fill="{TEXT}">{g * 100:.0f}%</text>')
    path = " ".join(f"{'M' if i == 0 else 'L'}{px(x):.1f},{py(y):.1f}"
                    for i, (x, y, _) in enumerate(pts))
    parts.append(f'<path d="{path}" fill="none" stroke="{BLUE}" '
                 f'stroke-width="2.4"/>')
    for x, y, n in pts:
        parts.append(
            f'<circle cx="{px(x):.1f}" cy="{py(y):.1f}" r="5.5" fill="{BLUE}">'
            f'<title>p_hit {x:.2f} -> {y * 100:.0f}% actual, n={n}</title>'
            f'</circle>'
            f'<text x="{px(x):.1f}" y="{py(y) - 11:.1f}" font-size="11" '
            f'text-anchor="middle" fill="{BLUE}">{y * 100:.0f}%</text>')
    first, last = pts[0][1], pts[-1][1]
    ys = [y for _, y, _ in pts]
    monotone = all(ys[i] <= ys[i + 1] + 1e-9 for i in range(len(ys) - 1))
    peak = max(range(len(ys)), key=lambda i: ys[i])
    # State the shape the chart actually has. A caption claiming a clean rise
    # over a line that visibly dips is the fastest way to lose a reader who
    # can see both.
    note = (f'rises {first * 100:.0f}% &#8594; {last * 100:.0f}%, and does so '
            f'monotonically' if monotone else
            f'rises {first * 100:.0f}% &#8594; {last * 100:.0f}% overall but '
            f'NOT monotonically - it peaks in fifth {peak + 1} of {len(ys)}')
    parts.append(
        f'<text x="{pad_l}" y="{H - 26}" font-size="11" fill="{TEXT}">'
        f'{note}</text>'
        f'<text x="{pad_l}" y="{H - 10}" font-size="11" fill="{TEXT}">'
        f'the FLOOR does the work; p_hit does not finely rank above it</text>')
    return _svg(W, H, "".join(parts), "does higher confidence mean a better pick")


def architecture() -> str:
    """The pipeline, as one picture, so the report is self-contained."""
    W, H = 900, 560
    box = ('<rect x="%d" y="%d" width="%d" height="%d" rx="6" fill="%s" '
           'stroke="%s" stroke-width="1.4"/>'
           '<text x="%d" y="%d" font-size="12" font-weight="600" '
           'text-anchor="middle" fill="#0f172a">%s</text>')
    sub = ('<text x="%d" y="%d" font-size="10.5" text-anchor="middle" '
           'fill="%s">%s</text>')
    arrow = ('<line x1="%d" y1="%d" x2="%d" y2="%d" stroke="%s" '
             'stroke-width="1.6" marker-end="url(#a)"/>')
    p = [f'<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" '
         f'markerWidth="6" markerHeight="6" orient="auto">'
         f'<path d="M0,0 L10,5 L0,10 z" fill="{AXIS}"/></marker></defs>']

    p.append(box % (30, 16, 250, 46, "#f1f5f9", AXIS, 155, 36, "POS / warehouse"))
    p.append(sub % (155, 50, TEXT, "syncgo - PostgreSQL, SELECT-only"))
    p.append(arrow % (155, 64, 155, 92, AXIS))
    p.append(box % (30, 94, 250, 50, "#f1f5f9", AXIS, 155, 114,
                    "bottleai_analytics"))
    p.append(sub % (155, 130, TEXT, "Node is the ONLY writer"))
    p.append(arrow % (280, 118, 330, 118, AXIS))
    p.append(sub % (305, 110, TEXT, "payload"))

    p.append('<rect x="330" y="16" width="545" height="470" rx="8" '
             f'fill="#f8fafc" stroke="{BLUE}" stroke-width="1.6" '
             'stroke-dasharray="6 4"/>')
    p.append(sub % (602, 34, BLUE,
                    "app/pipeline - STATELESS. No DB handle. No credentials."))

    rows = [
        (46, "01 ingest  &#183;  02 contracts  &#183;  03 feature store", "#fff"),
        (96, "04 evidence (n)  &#183;  05 cohort prior", "#fff"),
    ]
    for y, label, fill in rows:
        p.append(box % (350, y, 505, 38, fill, AXIS, 602, y + 24, label))
        p.append(arrow % (602, y + 38, 602, y + 48, AXIS))

    p.append(box % (350, 146, 505, 56, "#dbeafe", BLUE, 602, 170,
                    "20  TEMPORAL REVERSION"))
    p.append(sub % (602, 188, "#1e40af",
                    "shrink recent rate toward its own long run &#8594; "
                    "deficit_units, p_hit"))
    p.append(arrow % (602, 202, 602, 214, AXIS))

    more = [
        (214, "06 shrinkage (own &#8596; cohort)  &#183;  07 forecast p10/p50/p90"),
        (264, "08 calibration  &#183;  09 elasticity  &#183;  10 policy  &#183;  11 constraints"),
        (314, "12 typed candidates"),
    ]
    for y, label in more:
        p.append(box % (350, y, 505, 38, "#fff", AXIS, 602, y + 24, label))
        p.append(arrow % (602, y + 38, 602, y + 48, AXIS))

    p.append(box % (350, 364, 505, 52, "#dbeafe", BLUE, 602, 386,
                    "13  RANK"))
    p.append(sub % (602, 404, "#1e40af",
                    "EV = margin &#215; DEFICIT   (never total demand)"))
    p.append(arrow % (602, 416, 602, 428, AXIS))
    p.append(box % (350, 428, 505, 44, "#fff", AXIS, 602, 448,
                    "14 decision validation &#183; 15 explanation &#183; 16 numeral check"))
    p.append(sub % (602, 464, TEXT,
                    "the model writes prose only - it decides nothing"))

    p.append(arrow % (602, 486, 602, 506, AXIS))
    p.append(box % (330, 506, 250, 40, "#f1f5f9", AXIS, 455, 531,
                    "17 the gate  &#183;  19 outcomes"))
    p.append(box % (600, 506, 275, 40, "#f1f5f9", AXIS, 737, 531,
                    "React SPA - only what passed"))
    return _svg(W, H, "".join(p), "recommendation engine architecture")
