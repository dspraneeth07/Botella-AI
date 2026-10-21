"""Build the compact prompt for the single LLM call.

The system prompt is static (it caches across every store in a daily run). All
volatile, per-store content lives in the user payload so the cached prefix
stays byte-identical.

Note on length: the system prompt is deliberately substantial. Sonnet 4.6 only
caches prefixes of >= 2,048 tokens — below that, ``cache_control`` is silently
ignored — and the detail (category/action definitions, the candidate-line
legend, quantity arithmetic) measurably grounds the output, so the extra
tokens are cached after the first store anyway.
"""

from __future__ import annotations

from datetime import UTC, datetime

from app.config import Settings
from app.schemas.context import RecommendationContext
from app.schemas.derived import Candidate, StoreSummary
from app.schemas.feedback import (
    CoPurchasePair,
    EffectivenessEntry,
    FeedbackDigest,
    LearnedEffectiveness,
    PastRecommendation,
)
from app.schemas.signals import SignalBundle
from app.schemas.store import AreaWinner, TrendProof

_FLAGGED = {"understock", "overstock_mild", "overstock_severe", "stockout"}

_MAX_CO_PURCHASE_LINES = 12

# --- MEASURED TRACK RECORD budget caps (the section must stay short) --------
_MAX_TRACK_ENTRIES = 8  # proven / avoid entries each
_MAX_TRACK_RECS = 4  # followed-and-failed / ignored rec lines each
_MAX_TRACK_REC_SKUS = 3  # SKUs named per rec line
# Honesty rule shared with Node: displayed/averaged lift is capped at 5.
_LIFT_CAP = 5.0


def build_system_prompt(settings: Settings) -> str:
    lo, hi = settings.target_min_recommendations, settings.max_recommendations
    t_lo, t_hi = settings.trending_min_recommendations, settings.trending_max_recommendations
    return f"""You are an expert US liquor retail strategist generating tomorrow's \
recommendations for one store from its active signals, 90-day sales summary, \
inventory health flags, and curated candidate list.

=== HARD RULES ===
1. Recommend ONLY products from the candidate list; every primary_sku must \
appear verbatim there. THREE exceptions, all SKU-less stock_new picks (leave \
primary_skus empty) for products the store does not carry, each starting the \
rationale with the exact product name from its line: (a) new_arrival for an \
AREA WINNER marked NOT CARRIED, citing area_winner; (b) social_trending for \
a NOT CARRIED TREND PROOF line that names a top seller, citing the trend's \
key; (c) new_arrival for a MARKET GAP line, citing market_gap (at most ONE \
market-gap pick per run).
2. Aim for {lo}-{hi} recommendations across the seven DAILY categories below \
(per-category counts are targets, not quotas); on a quiet day produce fewer \
({lo - 2}-{lo}) rather than padding with weak picks. social_trending is a \
SEPARATE budget on top: {t_lo}-{t_hi} picks when the TREND lines support \
them, never counting toward or displacing the daily total.
3. Every rationale must rest on a real reason from the data: a named signal, \
a date, or the product's own stock situation. Exact signal keys and flag \
names go in signals_cited, never in rationale prose; cite only keys shown \
in ACTIVE SIGNALS / ACTIVE KEYS, plus inventory flags (understock, \
overstock_mild, overstock_severe).
4. confidence is 0-1. valid_through is an ISO date no later than the last \
shown signal date or 21 days out, whichever is sooner.
5. Write rationale and quantity_hint in plain language for a non-technical \
owner (see WRITING STYLE): no shorthand, no internal flag names, no em dash.
6. Use each product in at most ONE recommendation, its single best action \
(duplicates are removed, best-ranked pick wins).
7. Prefer FULL-SIZE bottles. A NIP-tagged candidate (50/100ml mini) may \
anchor at most ONE recommendation per run, and only when the data is \
specifically about minis (their own stockout, velocity, or signal): minis \
are pocket-priced impulse buys, so their big unit counts do not make them \
the store's real movers - the dollar figures do.
8. Output ONLY through the recommend_products tool call.

=== RECOMMENDATION CATEGORIES (target count) ===
- inventory_understock (1-2): a fast mover will run out before the next \
order cycle (flagged understock, or low cover with high velocity), or \
already has (flagged stockout). A LOST_SALE tag is the strongest case of \
all: the shelf is empty with measured days out and dollars already missed, \
so reorder it, cite lost_sale, and quote those measured figures.
- inventory_overstock (1-2): capital stuck in stock that sells too slowly \
(flagged overstock_mild/overstock_severe, or very high cover).
- weather (1-2): the forecast or an alert shifts demand. Heat favors cold, \
light drinks (Mexican/light lager, seltzer, RTDs, rose/white wine, tequila, \
vodka); cold favors warming ones (bourbon, scotch, brandy, red wine, stout); \
storms drive stock-up trips (multipacks, bestsellers).
- calendar_sports (1-2): an upcoming holiday or a LOCAL HOME game spikes \
demand in the categories it favors.
- news (0-1): a strong, direction-clear story; follow the NEWS impact rules \
below (a demand story supports promote/endcap/pre_stock toward it; a supply \
or price story means buy the affected products ahead, never promote them).
- bundle (1-2): two-plus products sold as one offer, tied to an active \
signal or to shown co-purchase data.
- new_arrival (0-2): a product added within the last 7 days (NEW or NEW_HOT \
tag), or an AREA WINNER. Prefer NEW_HOT, already selling fast for its days \
on the shelf: give it visibility or reorder before the first stockout kills \
its momentum. A plain NEW product needs a second supporting reason (a \
favoring signal, or a strong margin worth featuring). A NOT CARRIED area \
winner or MARKET GAP product may earn a stock_new pick (rule 1). Cite \
new_arrival (plus area_winner or market_gap when it applies).
- social_trending ({t_lo}-{t_hi}, SEPARATE budget, see rule 2): a drink \
trending RIGHT NOW on social media, in search, or at nearby registers (TREND \
lines). ONE pick per trend, its single best product match; spread multiple \
picks across DIFFERENT trends. Prefer candidates tagged SOCIAL_TREND (they \
match the trending drink by name): feature them (endcap, cold_box, promote) \
or pre_stock ahead of weekend demand, citing the trend's shown key. These \
render in their own Trending section and only the top {t_hi} by confidence \
are kept, so score each confidence honestly against the strength of its \
trend evidence.

=== ACTION TYPES (pick the single best-fit action; each has criteria) ===
- reorder = order now because stock cannot cover near-term demand \
(understock or stockout flag).
- pre_stock = buy ahead of a DATED driver: a holiday, game, or heatwave, OR \
a supply_risk / price_increase_risk story on the affected products.
- endcap = move to an end display. A store has only a couple of ends: use \
it AT MOST TWICE per run, for the strongest visibility cases.
- promote = feature in signage or shelf talkers, no price cut, for \
demand-side reasons (a trend, event, or holiday). The default visibility \
action. NEVER promote the products a supply_risk or price_increase_risk \
story is about (that calls for pre_stock or reorder); a SUBSTITUTE may be \
promoted only when the affected product cannot be restocked, and the \
rationale must name it as a substitute.
- cold_box = cold-door placement, the scarcest and most expensive space in \
the store: AT MOST ONCE per run, and only when ALL hold: drunk cold (beer, \
seltzer, RTD, cider, white/rose/sparkling wine), a demand driver within the \
next 3 days cited (game, event, heatwave, imminent holiday), and a fast \
mover (v:high or very_high) or rising. Anything less: endcap or promote.
- bundle = merchandise two-plus products together; needs at least 2 SKUs, \
grounded in co-purchase data or an obvious pairing.
- markdown = price cut for mild overstock (overstock_mild flag cited).
- liquidate = deep cut to recover capital on severe or dead stock \
(overstock_severe flag cited).
- stock_new = start carrying a product the store does not stock yet (order \
from the distributor); only for the three NOT CARRIED shapes in rule 1.
Placement actions (endcap, promote, cold_box) need stock on the shelf: a \
stocked-out or LOST_SALE product needs reorder, never a display.

=== CANDIDATE LINE LEGEND ===
SKU:<id> | <name> | <category>/<sub> | $<price>/<tier> | m:<margin %> | \
v:<velocity> | trend:<rising|stable|falling> | stock:<units> | \
wks:<weeks of cover> | wk:<units/week> | \
order:<units>u/<days covered>d by:<date> out:<date> | FLAG:<health flag> | tags
v is velocity z-scored within the product's own category (very_low..\
very_high). tier is the price POSITION within its own category at this \
store: value (bottom quarter), mid, or premium (top quarter). wk is the pace \
it is expected to sell at RIGHT NOW (units/week, recent trend included); wks \
is stock divided by that pace ("?" = no recent sales). m, order, and FLAG \
show only when known. The order field comes from the same demand engine \
behind the owner's Buying report: <units>u is the buy quantity (sized to \
keep the shelf stocked until a next order can realistically land, minus \
current stock), /<days>d the days of selling it covers, by:<date> the day to \
place the order (never in the past; equal to today's DATE = due TODAY), \
out:<date> when current stock runs out at the current pace. Tags: PROVEN = \
recommended here before and it converted; NEWS_MATCH = flagged by news \
analysis; SOCIAL_TREND = matches a drink on a TREND line by name; NEW = \
added within the last 7 days; NEW_HOT = added within 7 days AND already \
selling fast; REORDER_DUE = order-by date within the next 7 days, the \
week-ahead restock notice, worth a reorder pick even before stock looks \
low; NIP = a 50/100ml mini (rule 7). Three tags carry the owner's own Store \
Intelligence reports: LOST_SALE:<N>d out = the shelf is EMPTY on a proven \
mover, out N days with the shown dollars already missed (cite lost_sale); \
DONT_BUY = the owner's buying report says STOP ordering it (dead, or fading \
with months of supply): NEVER reorder or pre_stock it; markdown, liquidate, \
bundle, or visibility to clear it (cite dont_buy); DEAD_STOCK = the \
inventory report classes it dead, showing time since its last sale: solid \
ground for a markdown or liquidate pick (cite dead_stock).

=== PRICING LANGUAGE ===
Describe price ONLY relative to the product's own category, using its shown \
tier: premium tier products are the only ones you may call premium, \
high-end, or luxury; value tier the only bargains; a $20 wine at tier:mid \
is a mid-priced wine, full stop. Dollar stock value (price times units) \
measures CASH TIED UP, not how upscale the product is.

=== QUANTITY RULES ===
Quantities are computed for you where possible; quote them, never your own \
arithmetic. Always speak in UNITS, never cases (there is no case-size data).
- Each recommendation STANDS ALONE. NEVER reference other recommendations \
or claim a product "is being reordered separately"; recs are removed and \
reordered independently. A line with NO order figure needs nothing ordered \
right now: say it is well stocked or leave it out, never "running low", \
never an implied order elsewhere. Exception: a line flagged understock with \
no order figure may get a reorder with a qualitative hint ("order enough \
for about two weeks"), never an invented number.
- reorder / pre_stock with order:<N>u shown: quantity_hint MUST quote \
exactly N units AND say what the order buys the owner, anchored on THAT \
line's own dates (by:, out:, /<days>d): "order 45 units by Thursday, that \
carries you through about Sep 12". Vary the wording pick to pick; never \
stamp one identical stock phrase on every rec. by: today or earlier = \
"order today"; NEVER phrase an order date in the past tense, and NEVER \
state or guess delivery times (the owner knows their suppliers); anchor \
urgency on the run-out date instead.
- When NO line shows an order figure (the engine had no data this run), \
size reorders yourself: about 2 to 3 weeks of the wk rate minus stock.
- A NEW or NEW_HOT order figure is deliberately small (days of history); \
say so: "it is brand new, so start with about a week's worth and reorder \
as it proves out".
- MULTI-PACK products ("6pk", "4 pack", "12pk"...): one unit IS one pack; \
say packs, never bare units or single cans. order:19u on a 6pk line = \
"order 19 six-packs"; the weekly rate is packs per week too.
- pre_stock without an order figure: keep quantity_hint qualitative \
("stock up ahead of Saturday") rather than inventing a number.
- markdown/liquidate: state the units to clear from the line's stock and \
weeks of cover.
- Scale wording to the store SIZE; never suggest more than ~8 weeks of cover.

=== SIGNAL NOTES ===
- The WEATHER line leads with live observed conditions ("now 72F, Light \
Rain") then today's forecast high and low, each naming its day. Never \
present a forecast high as the temperature outside right now, and never \
state a temperature not on the line.
- A LOCAL HOME game means the store is in the team's MARKET, not that the \
stadium is close: demand is watch parties at home (day-before and day-of \
beer, RTDs, party staples). Only a line marked STADIUM NEARBY means \
game-day foot traffic (cold box, single serves); otherwise NEVER call the \
game "nearby" or imply fans stopping in en route. Away games matter only \
for marquee matchups.
- Holiday demand builds 2-5 days ahead; pre_stock must leave delivery time.
- EVENT lines (screened for liquor relevance; day-of single-serve, chilled, \
RTD demand) may carry "[draw:...; key:...]" plus a note: major draw = \
stadium/arena/festival scale, worth pre_stock or endcap; moderate = \
mid-size venue, usually promote or endcap; minor = soft context only. \
Weight multi-night runs above one-offs. Name the specific event and venue \
from the line ("the Zach Bryan show at Moody Center"), never a vague "a \
nearby concert", use its shown date, and reference only listed events.
- A NEWS line may carry "[impact; key:...]": demand_up = stock toward it; \
demand_down = ease off (markdown if also overstocked); price_increase_risk \
/ supply_risk = pre_stock or reorder the affected products NOW before \
prices rise or supply pauses (promote only an explicitly named SUBSTITUTE, \
and only when the affected product cannot be restocked). Cite the shown \
key; a NEWS_MATCH candidate is the affected product, prefer it for the \
buy-ahead. News with a key but no impact, or unanalyzed, is soft context \
only. Lines tagged [industry_email] come from the network's daily industry \
digest: national rather than local, but treat their impact, key, and note \
exactly like analyzed news.
- TREND lines are drinks trending THIS WEEK, each with its citable key and \
evidence naming its platform; attribute the trend to THAT platform, never \
another. reddit/youtube = popular posts and videos; instagram = measured \
hashtag post velocity above the tag's own baseline; Google Trends = search \
interest (rising in this store's state = local shoppers already looking); \
registers = measured sales acceleration at nearby same-state stores, the \
STRONGEST trend evidence there is (real purchases, not chatter), deserving \
clearly higher confidence than a single-platform social trend. Recommend \
only the store's own matching products (SOCIAL_TREND tag or a clear name \
match); nothing matches = skip the trend rather than invent a product. \
Trends fade: keep valid_through short (about a week) and mention the trend \
naturally ("trending on social media right now").

=== MARGIN ===
When margin is shown, prefer the higher-margin option among comparable picks, \
favor higher-margin categories for endcaps and promotions, and for a markdown \
note the margin given up. If margin is absent, ignore it and do not guess.

=== OPTIONAL SECTIONS (use only if present) ===
- CO-PURCHASE PAIRS are real basket data: ground bundles in them instead of \
inventing affinities, preferring pairs where both SKUs are candidates.
- AREA WINNERS are new products already selling well at other stores in \
this store's area (anonymized, matched by barcode). CARRIED ones appear as \
AREA_WINNER candidates: strong evidence for a promote/endcap/reorder. A \
NOT CARRIED one whose category fits this store's mix warrants a stock_new \
pick (rule 1). Weight more stores and same-city stores higher.
- TREND PROOF is register-measured validation of the TREND lines at other \
same-state stores (anonymized). Several stores selling with some \
accelerating = the trend is real locally: a SOCIAL_TREND candidate \
deserves a confident social_trending pick, saying the proof plainly \
("stores near you are already selling more of it each week"). "Not selling \
at nearby stores yet" = keep confidence low or skip. A NOT CARRIED line \
naming a top seller may earn a stock_new pick (rule 1b).
- MARKET GAP lines are products this store does NOT carry that peer stores \
statewide sell steadily (anonymized units, store count, typical price). One \
that fits the mix may earn a stock_new pick (rule 1c): cite market_gap and \
say the peer evidence plainly ("stores across the state sell about N a \
quarter"). Prefer the strongest line; at most ONE per run.
- FEEDBACK shows how past recs converted (0-1, 0.5 = neutral): lean toward \
categories above 0.6, be selective below 0.4, calibrate confidence to the \
shown split. DID NOT CONVERT SKUs are to avoid unless today's signals \
clearly change their case (say so if you re-recommend one).
- PROVEN candidates are pre-vetted; prefer them over otherwise-equal options.
- MEASURED TRACK RECORD is register-measured history for this store, never \
a projection. PROVEN AT THIS STORE entries converted when recommended \
before: prefer them among comparable picks. REPEATEDLY MISSED entries \
failed more than once when the store acted: do not recommend again. A \
FOLLOWED AND FAILED rec was acted on and sales still missed: drop the idea \
or switch products. An IGNORED rec was never acted on, so it is untested \
rather than disproven: repeat it only when today's data gives a genuinely \
new hook, named in the rationale.

=== WRITING STYLE (rationale and quantity_hint go to the shop owner) ===
The owner is non-technical. Explain it like you would across the counter: \
1-3 short sentences, concrete, products by name. Translate, never echo the \
shorthand: understock = "running low"; overstock_severe = "badly \
overstocked"; high velocity = "one of your faster sellers"; trend falling = \
"sales are slowing"; wks = a plain sense of time (about 4 = "a month's \
worth", 52+ = "more than a year's worth"); wk = "sells about N a week"; \
margin = a plain percent; tier:premium = "one of your pricier <category> \
picks", tier:value = "one of your more affordable ones", tier:mid = say \
nothing about price level; NEW = "new to your shelf"; NEW_HOT = "a new \
product that is already taking off"; order:<N>u = "order N units", with \
by:, /<days>d, and out: in plain words ("by Friday", "that carries you \
into mid-September", "you'll be empty by Sunday"); REORDER_DUE = "due for \
a reorder this week"; LOST_SALE = "it has been out for N days and you have \
already missed about $X in sales"; DEAD_STOCK = "it has not sold in N \
months". Keep the numbers an owner acts on (units, price, percent off, how \
long stock lasts). Name the specific driver behind each pick (the actual \
event and venue, the holiday, the team) as shown in ACTIVE SIGNALS, never \
a vague "a nearby event". No em dashes; use commas, periods, or "and".

=== WORKED EXAMPLE (format and tone only; never copy the content) ===
A store shows HOLIDAY: Cinco de Mayo in 3 days, and the candidate \
"SKU:0245 | Casamigos Blanco 750ml | tequila/ | $52.99/premium | m:31% | \
v:high | trend:rising | stock:6 | wks:1.1 | wk:5.4 | order:21u/21d \
by:2026-05-03 out:2026-05-10 | FLAG:understock". A correct recommendation, \
for the owner:
- category: calendar_sports, action_type: pre_stock, primary_skus: ["0245"]
- quantity_hint: "order 21 units by Friday, enough to carry you through the \
holiday and the two weeks after"
- rationale: "Cinco de Mayo is 3 days away and Casamigos Blanco is one of your \
faster sellers, with about a week of stock left and empty shelves likely by \
May 10. Order 21 units by Friday to stay ahead of the holiday rush. It \
also earns a good margin, so it is worth a front display."
- signals_cited: ["cinco_de_mayo", "understock"], confidence: 0.85, \
valid_through: the holiday date.

Every action follows this shape: work out the numbers from the candidate \
line privately, then tell the owner in plain words what is going on, what \
to do, and how much, with no shorthand and no em dashes.
"""


def _natural_day(iso_date: str | None) -> str:
    """'2026-08-07' -> 'Thu Aug 7' — how a person names a nearby day."""
    if not iso_date:
        return ""
    try:
        dt = datetime.strptime(iso_date, "%Y-%m-%d")
    except ValueError:
        return iso_date
    return f"{dt:%a} {dt:%b} {dt.day}"


def format_signals(signals: SignalBundle) -> str:
    if signals.is_empty():
        return "No notable external signals in the window."
    parts: list[str] = []
    w = signals.weather
    if w:
        alerts = ", ".join(w.alerts) or "none"
        # Lead with the live observation — that is the weather the owner feels
        # when they read this. Forecast figures follow, each dated, so a
        # later-today high is never read as the temperature right now. Signals
        # cached before observations existed have no ``current_f``; the line
        # then falls back to the first forecast period's summary as before.
        if w.current_f is not None:
            conditions = f"now {w.current_f}F"
            if w.current_summary:
                conditions += f", {w.current_summary}"
        else:
            conditions = w.summary
        # An observation-only signal has no forecast figures; render only what
        # exists so the model can never echo a literal "high NoneF" to the owner.
        segments = [conditions]
        if w.high_f is not None:
            segments.append(
                f"high {w.high_f}F" + (f" on {_natural_day(w.high_date)}" if w.high_date else "")
            )
        if w.low_f is not None:
            segments.append(
                f"low {w.low_f}F" + (f" on {_natural_day(w.low_date)}" if w.low_date else "")
            )
        segments.append(f"alerts: {alerts}")
        parts.append("WEATHER: " + " | ".join(segments))
    # Per-type display caps match the upstream bundle bounds (sports<=8 from
    # localize, events<=events_max_kept, news<=3 email+news_max_kept), so
    # every signal that made the bundle renders and every key in ACTIVE KEYS
    # has a visible line behind it.
    for g in signals.sports[:8]:
        loc = "LOCAL HOME" if g.is_local_home else "away/other"
        # Disclose the metro distance so the model can phrase honestly:
        # STADIUM NEARBY only within the tight foot-traffic radius.
        if g.stadium_nearby:
            loc += f", STADIUM NEARBY ~{round(g.distance_mi or 0)}mi"
        elif g.distance_mi is not None:
            loc += f", metro ~{round(g.distance_mi)}mi away"
        when = f"{g.date} to {g.end_date} ({g.games} games)" if g.games > 1 else g.date
        parts.append(f"SPORTS: {g.league.upper()} {g.away} @ {g.home} on {when} ({loc})")
    for e in signals.events[:8]:
        dist = f" ({e.distance_mi} mi)" if e.distance_mi is not None else ""
        nights = f", {e.nights} nights" if e.nights > 1 else ""
        analysis = ""
        if e.key:
            note = f" {e.note}" if e.note else ""
            analysis = f" [draw:{e.draw}; key:{e.key}]{note}"
        parts.append(
            f"EVENT: {e.name} at {e.venue or 'venue n/a'} on {e.date}{nights}{dist}{analysis}"
        )
    for h in signals.holidays[:5]:
        parts.append(f"HOLIDAY: {h.name} in {h.days_away} days ({h.date}) [key:{h.key}]")
    for t in signals.social[:8]:
        evidence: list[str] = []
        plural = "s" if t.mentions != 1 else ""
        if "reddit" in t.source and "youtube" in t.source:
            evidence.append(f"{t.mentions} top posts and videos this week (reddit + youtube)")
        elif "reddit" in t.source:
            upvotes = f", {t.score} upvotes" if t.score else ""
            evidence.append(f"reddit: {t.mentions} top post{plural} this week{upvotes}")
        elif "youtube" in t.source:
            views = f", {t.score} views" if t.score else ""
            evidence.append(f"youtube: {t.mentions} top video{plural} this week{views}")
        if "instagram" in t.source:
            # t.evidence carries the measured velocity line ("#tag at N
            # posts/hr, Nx its recent baseline") when Instagram contributed.
            engagement = f", {t.score} engagement on top posts" if t.score else ""
            evidence.append(f"instagram: {t.evidence or 'post velocity surging'}{engagement}")
        if "registers" in t.source:
            # Measured purchases at nearby stores — the strongest tier.
            evidence.append(f"registers: {t.evidence or 'sales accelerating at nearby stores'}")
        # Search attribution belongs to Google Trends only; Instagram entries
        # also carry momentum="rising" and must not masquerade as search.
        if "google_trends" in t.source and t.momentum:
            interest = f" ({t.interest}/100)" if t.interest is not None else ""
            evidence.append(f"search interest {t.momentum}{interest}")
        detail = "; ".join(evidence) or t.evidence or "trending"
        note = f" {t.note}" if t.note else ""
        parts.append(f"TREND: {t.term} ({detail}) [key:{t.key}]{note}")
    # Impact-bearing items first (stable: email items lead, then analyzed
    # state news, then unanalyzed soft context), so a keyword-mode headline
    # can never displace an actionable analyzed item at the cap.
    ordered_news = sorted(signals.news, key=lambda n: n.impact is None)
    for n in ordered_news[:8]:
        analysis = ""
        note = f" {n.note}" if n.note else ""
        if n.impact:
            analysis = f" [{n.impact}; key:{n.key}]{note}"
        elif n.key:
            # Analyst-kept but direction-less: still citable, so its key must
            # render — every key in ACTIVE KEYS needs a visible line behind it.
            analysis = f" [key:{n.key}]{note}"
        parts.append(f"NEWS: [{n.category}] {n.headline}{analysis}")
    if signals.active_keys:
        parts.append(f"ACTIVE KEYS: {', '.join(signals.active_keys)}")
    return "\n".join(parts)


def format_summary(summary: StoreSummary) -> str:
    margin_mix = summary.category_margin_pct or "n/a (no cost data)"
    return (
        f"CATEGORY MIX (90d revenue %): {summary.category_revenue_pct}\n"
        f"CATEGORY MARGIN (gross %): {margin_mix}\n"
        f"TOP MOVERS (30d): {', '.join(summary.top_movers_30d) or 'n/a'}\n"
        f"RECENT WINNERS: {', '.join(summary.recent_winners) or 'n/a'}\n"
        f"RECENT LOSERS: {', '.join(summary.recent_losers) or 'n/a'}\n"
        f"SLOW STOCK FLAGGED: {len(summary.slow_movers_with_stock)} SKUs"
    )


def format_feedback(digest: FeedbackDigest, candidates: list[Candidate]) -> str:
    overall_lift = f"{digest.overall_lift}x" if digest.overall_lift is not None else "n/a"
    lines = [
        f"Scored recs (last {digest.window_days}d): {digest.measured_recs} | "
        f"overall lift: {overall_lift} | overall score: {digest.overall_score} "
        f"(0-1, 0.5 = neutral; blends realized lift with user thumbs votes)"
    ]
    for c in digest.categories:
        lines.append(
            f"- {c.category}: score {c.avg_score} | {c.avg_lift}x baseline (n={c.recs})"
        )
    if digest.high_confidence_lift is not None or digest.low_confidence_lift is not None:
        lines.append(
            f"Confidence calibration: >=0.75 conf -> {digest.high_confidence_lift}x | "
            f"<0.75 conf -> {digest.low_confidence_lift}x"
        )
    by_sku = {c.sku: c.product_name for c in candidates}
    if digest.loser_skus:
        named = ", ".join(
            f"{sku} ({by_sku[sku]})" if sku in by_sku else sku for sku in digest.loser_skus
        )
        lines.append(
            f"DID NOT CONVERT when recommended recently (avoid unless conditions "
            f"clearly changed): {named}"
        )
    return "\n".join(lines)


def _entry_line(entry: EffectivenessEntry) -> str:
    """One proven/avoid lesson; ``evidence`` is Node's measured wording."""
    label = (
        f"{entry.sku} ({entry.name}, {entry.category})"
        if entry.name
        else f"{entry.sku} ({entry.category})"
    )
    return f"- {label}: {entry.evidence}" if entry.evidence else f"- {label}"


def _rec_line(rec: PastRecommendation, by_sku: dict[str, str]) -> str:
    skus = rec.primary_skus[:_MAX_TRACK_REC_SKUS]
    named = ", ".join(f"{sku} ({by_sku[sku]})" if sku in by_sku else sku for sku in skus)
    if len(rec.primary_skus) > len(skus):
        named += f" (+{len(rec.primary_skus) - len(skus)} more)"
    lift = ""
    if rec.lift is not None:
        # Stored lift is raw and uncapped; the honesty rule caps every shown
        # or averaged lift at 5 so one outlier week can't oversell a rec.
        lift = f" | measured {round(min(rec.lift, _LIFT_CAP), 1)}x baseline"
    return f"- {rec.rec_date.isoformat()} {rec.category}: {named or 'no SKUs'}{lift}"


def _followed_and_failed(rec: PastRecommendation) -> bool:
    """The owner acted on the rec and it STILL underperformed — the idea
    itself is disproven for this store; drop or replace it."""
    return rec.action_taken is True and rec.verdict == "underperformer"


def _ignored(rec: PastRecommendation) -> bool:
    """The owner provably never acted (or self-reported not acting where the
    detectors couldn't tell), so the idea is untested rather than disproven.

    'dismissed' means the owner declined to answer — evidence of nothing, so
    it never lands a rec here. Winners are excluded: demand showed up without
    action, which is not a "repeat only with a hook" situation. A verdict of
    None / insufficient_data stays eligible — ignoring a rec is a fact about
    the owner, not about the measurement window.
    """
    not_acted = rec.action_taken is False or (
        rec.action_taken is None and rec.action_claim == "did_not"
    )
    return not_acted and rec.verdict != "winner"


def format_track_record(
    learned: LearnedEffectiveness | None,
    history: list[PastRecommendation],
    candidates: list[Candidate],
) -> str:
    """Render the MEASURED TRACK RECORD section, or "" when nothing measured.

    Everything here is register-measured by Node (never projected): the
    proven/avoid SKU lists arrive pre-worded, and the per-rec measured fields
    split past recs the owner ACTED on and lost (drop the idea) from recs the
    owner IGNORED (repeat only with a fresh hook). List sizes are capped so
    the section can never balloon the prompt.
    """
    proven = (learned.proven if learned else [])[:_MAX_TRACK_ENTRIES]
    avoid = (learned.avoid if learned else [])[:_MAX_TRACK_ENTRIES]
    newest_first = sorted(history, key=lambda r: r.rec_date, reverse=True)
    failed = [r for r in newest_first if _followed_and_failed(r)][:_MAX_TRACK_RECS]
    ignored = [r for r in newest_first if _ignored(r)][:_MAX_TRACK_RECS]
    if not (proven or avoid or failed or ignored):
        return ""

    by_sku = {c.sku: c.product_name for c in candidates}
    lines: list[str] = []
    if proven:
        lines.append("PROVEN AT THIS STORE (prefer these among comparable picks):")
        lines.extend(_entry_line(entry) for entry in proven)
    if avoid:
        lines.append("REPEATEDLY MISSED when the store acted (do not recommend again):")
        lines.extend(_entry_line(entry) for entry in avoid)
    if failed:
        lines.append(
            "FOLLOWED AND FAILED (the owner acted and sales still missed; "
            "drop the idea or switch products):"
        )
        lines.extend(_rec_line(rec, by_sku) for rec in failed)
    if ignored:
        lines.append(
            "IGNORED BY THE OWNER (never acted on, so untested rather than "
            "disproven; repeat only with a new concrete hook, and say what changed):"
        )
        lines.extend(_rec_line(rec, by_sku) for rec in ignored)
    return "\n".join(lines)


def format_co_purchases(
    pairs: list[CoPurchasePair], candidates: list[Candidate]
) -> str:
    """Render co-purchase pairs the model can actually act on.

    Only pairs where BOTH SKUs are in the candidate list are shown — the model
    is forbidden from recommending anything else, so other pairs are noise.
    """
    by_sku = {c.sku: c.product_name for c in candidates}
    lines: list[str] = []
    for pair in pairs:
        name_a, name_b = by_sku.get(pair.sku_a), by_sku.get(pair.sku_b)
        if name_a is None or name_b is None:
            continue
        lines.append(
            f"- {pair.sku_a} ({name_a}) + {pair.sku_b} ({name_b}): "
            f"{pair.support} baskets"
        )
        if len(lines) >= _MAX_CO_PURCHASE_LINES:
            break
    return "\n".join(lines)


_SLICE_TAGS = {
    "proven": " | PROVEN",
    "news_match": " | NEWS_MATCH",
    "social_trend": " | SOCIAL_TREND",
    "area_winner": " | AREA_WINNER",
    "new_hot": " | NEW_HOT",
    "new": " | NEW",
    "reorder_due": " | REORDER_DUE",
}


def format_trend_proof(proofs: list[TrendProof]) -> str:
    """Render the register-measured TREND PROOF lines, strongest proof first.

    Negative evidence renders too: "trending online, not selling nearby" is
    exactly what keeps the model from chasing hype with no local legs. Terms
    below Node's k-anonymity floor show only the store count.
    """
    def _strength(p: TrendProof) -> tuple:
        return (p.avg_weekly_units is not None, p.accelerating_stores or 0, p.stores_selling)

    lines: list[str] = []
    for p in sorted(proofs, key=_strength, reverse=True):
        if p.stores_selling <= 0:
            lines.append(
                f"- {p.term}: no matching sales at nearby stores yet (online buzz only)"
            )
            continue
        if p.avg_weekly_units is None:
            lines.append(
                f"- {p.term}: selling at {p.stores_selling} nearby "
                f"store{'s' if p.stores_selling != 1 else ''} (too few for averages)"
            )
            continue
        accel = (
            f", {p.accelerating_stores} accelerating this week"
            if p.accelerating_stores
            else ""
        )
        if p.carried and p.this_store_sku:
            here_rate = (
                f", ~{p.this_store_weekly_units}/wk here"
                if p.this_store_weekly_units is not None
                else ""
            )
            status = f"CARRIED here as SKU:{p.this_store_sku}{here_rate}"
        elif p.carried:
            status = "CARRIED here"
        else:
            named = f" (top seller: {p.product_name})" if p.product_name else ""
            status = f"NOT CARRIED at this store{named}"
        lines.append(
            f"- {p.term}: selling at {p.stores_selling} stores in this state, "
            f"~{p.avg_weekly_units} units/wk each{accel} | {status}"
        )
    return "\n".join(lines)


def format_area_winners(winners: list[AreaWinner]) -> str:
    """Render the anonymized cross-store section, carried items first (they are
    directly actionable via the candidate list)."""
    lines: list[str] = []
    for w in sorted(winners, key=lambda w: not w.carried):
        stores = f"{w.store_count} nearby store{'s' if w.store_count != 1 else ''}"
        if w.same_city_stores:
            stores += f" ({w.same_city_stores} in this city)"
        age = (
            f", arrived about {w.days_since_first_seen} days ago"
            if w.days_since_first_seen is not None
            else ""
        )
        status = (
            f"CARRIED here as SKU:{w.this_store_sku}"
            + (f" ({w.this_store_on_hand} on hand)" if w.this_store_on_hand is not None else "")
            if w.carried
            else "NOT CARRIED at this store"
        )
        lines.append(
            f"- {w.product_name} ({w.category or 'uncategorized'}): "
            f"~{w.avg_weekly_units}/wk across {stores}{age} | {status}"
        )
    return "\n".join(lines)


def _format_candidate(c: Candidate) -> str:
    flag = f" | FLAG:{c.health_status}" if c.health_status in _FLAGGED else ""
    tag = _SLICE_TAGS.get(c.slice, "")
    if c.size_ml is not None and c.size_ml <= 100:
        tag += " | NIP"
    # Store-intelligence tags: the same measured facts the owner's Store
    # Intelligence tabs print (lost-sales bleed, the don't-buy list, the
    # dead classification), so a rationale can quote them verbatim.
    if c.lost_days_out is not None:
        missed = f", ~${c.lost_revenue:,.0f} missed" if c.lost_revenue else ""
        tag += f" | LOST_SALE:{c.lost_days_out}d out{missed}"
    if c.dont_buy:
        tag += " | DONT_BUY"
    if c.si_class in ("dead", "never_sold") and c.on_hand > 0:
        since = (
            "never sold"
            if c.si_class == "never_sold" or c.days_since_last_sale is None
            else f"no sale in {c.days_since_last_sale}d"
        )
        tag += f" | DEAD_STOCK ({since})"
    weeks = c.weeks_on_hand if c.weeks_on_hand is not None else "?"
    sub = c.sub_category or ""
    margin = f" | m:{c.margin_pct}%" if c.margin_pct is not None else ""
    # The canonical reorder figure from the shared demand engine — the same
    # number the Buying tab prints. Rendered only when there is something to
    # order; the QUANTITY rules require the model to quote it verbatim.
    # /Nd = the days the order covers; by = place the order by then (already
    # clamped to today or later); out = when current stock hits zero.
    order = ""
    if c.suggested_order_qty is not None:
        cov = f"/{c.coverage_days}d" if c.coverage_days else ""
        by = f" by:{c.order_by}" if c.order_by else ""
        out = f" out:{c.run_out}" if c.run_out else ""
        order = f" | order:{c.suggested_order_qty}u{cov}{by}{out}"
    return (
        f"SKU:{c.sku} | {c.product_name} | {c.category}/{sub} | "
        f"${c.price}/{c.price_tier}{margin} | "
        f"v:{c.velocity_bucket} | trend:{c.trend} | stock:{c.on_hand} | "
        f"wks:{weeks} | wk:{c.weekly_rate}{order}{flag}{tag}"
    )


def format_candidates(candidates: list[Candidate]) -> str:
    return "\n".join(_format_candidate(c) for c in candidates)


def format_market_gaps(gaps: list) -> str:
    """Render the Market tab's assortment gaps (peer-proven, not carried),
    strongest projected revenue first (they arrive pre-ranked)."""
    lines: list[str] = []
    for g in gaps:
        price = f" at ~${g.avg_price}" if g.avg_price else ""
        est = (
            f"; est ~${g.est_annual_revenue:,.0f}/yr here"
            if g.est_annual_revenue
            else ""
        )
        lines.append(
            f"- {g.product_name} ({g.category or 'uncategorized'}): "
            f"~{g.peer_units} units/90d across {g.peer_stores} peer stores "
            f"statewide{price}{est}"
        )
    return "\n".join(lines)


def build_user_payload(context: RecommendationContext, settings: Settings) -> str:
    store = context.store
    health = context.inventory_health
    understock_n = sum(1 for h in health if h.status == "understock")
    overstock_n = sum(1 for h in health if h.status.startswith("overstock"))
    today = datetime.now(UTC).date().isoformat()
    lo, hi = settings.target_min_recommendations, settings.max_recommendations

    optional_sections = ""
    if context.feedback is not None:
        optional_sections += (
            f"\n=== FEEDBACK (how past recs converted) ===\n"
            f"{format_feedback(context.feedback, context.candidates)}\n"
        )
    track_record = format_track_record(
        context.learned, context.past_recommendations, context.candidates
    )
    if track_record:
        optional_sections += (
            f"\n=== MEASURED TRACK RECORD (register-measured at this store, "
            f"never projected) ===\n{track_record}\n"
        )
    if context.co_purchases:
        co_purchase_block = format_co_purchases(context.co_purchases, context.candidates)
        if co_purchase_block:
            optional_sections += (
                f"\n=== CO-PURCHASE PAIRS (observed baskets, 90d) ===\n{co_purchase_block}\n"
            )
    if context.area_winners:
        optional_sections += (
            f"\n=== AREA WINNERS (new products selling at nearby stores, 7d) ===\n"
            f"{format_area_winners(context.area_winners)}\n"
        )
    if context.trend_proof:
        optional_sections += (
            f"\n=== TREND PROOF (register-measured at same-state stores, "
            f"anonymized) ===\n{format_trend_proof(context.trend_proof)}\n"
        )
    if context.intel is not None and context.intel.market_gaps:
        optional_sections += (
            f"\n=== MARKET GAP (peer-proven products this store does not "
            f"carry) ===\n{format_market_gaps(context.intel.market_gaps)}\n"
        )

    return f"""DATE: {today} (sales data through {context.data_as_of.isoformat()})
STORE: {store.name} (id {store.id})
LOCATION: {store.city or '?'}, {store.state or '?'}
SIZE: {store.size_class}

=== ACTIVE SIGNALS ===
{format_signals(context.signals)}

=== 90-DAY STORE SUMMARY ===
{format_summary(context.summary)}

=== INVENTORY HEALTH FLAGS ===
Understock: {understock_n} SKUs
Overstock:  {overstock_n} SKUs
{optional_sections}
=== CANDIDATE PRODUCTS ({len(context.candidates)}) ===
{format_candidates(context.candidates)}

Generate {lo}-{hi} daily recommendations (plus separate-budget social_trending \
picks per rule 2) now via the recommend_products tool."""


def build_prompt(context: RecommendationContext, settings: Settings) -> dict[str, str]:
    return {
        "system": build_system_prompt(settings),
        "user": build_user_payload(context, settings),
    }
