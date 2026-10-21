# Card Statement Analysis

Owners upload their monthly card-processing statements (PDF, or a transaction CSV). Botella reads them,
reconciles the numbers, analyses them deterministically, and shows what the owner paid, where money is
leaking, and how much they would have saved with Rebelipay.

This document is the design and the **binding contract** for the feature: the data model, the extraction
schema, the analysis output, the Rebelipay pricing rules, the API and the screens. Code that disagrees with
it is a bug in one or the other; fix whichever is wrong and keep them in step.

- Ticket: "Card Statement Analysis - Implementation" (scope, acceptance criteria, sub-tasks).
- Plan: `card-statement-analysis-implementation.md` (kept outside the repo; its §14 holds product's answers).
- Target report: `statement.html` and 12 sample statements (4 stores x May/Jun/Jul 2026), kept outside the
  repo because they are real merchant documents. See §9 for how tests use them without committing them.
- Pattern copied: Quick-PO (`QUICK-PO.md`, `backend/routes/purchase-orders.js`,
  `backend/services/purchaseOrderService.js`, `frontend/src/components/PurchaseOrdersScreen.js`).

---

## 0. Decisions where this differs from the plan or the ticket

| # | Decision | Why |
|---|---|---|
| D1 | **Statements are scoped to the client**, not client + location. Every query filters `client_id`, with exactly one exception: the boot-time stale sweep (D13), which only moves `analysing` rows to `failed` across all clients and returns nothing to anyone. `location_id` records where the upload came from and is never a visibility filter. A store filter on the list picks a merchant. | Plan §14 Q1 answer ("Yes"), ticket Scope 3. The routes suite pins both the rule and the one exception. |
| D2 | Status values are `analysing`, `analysed`, `failed`, `duplicate`. UI labels: "Analysing…", "Analysed", "Could not read". `duplicate` rows are never listed. | Ticket wording (newer than the plan's `parsing/parsed`). |
| D3 | **No industry benchmarks.** Finding 01 shows statement facts only (debit volume, the rate charged on it, fees paid on it). No "typical cost", no est. annual recovery, no flat-rate warning chip, no `est_annual_savings_*` columns. | Plan §14 Q3 answer, ticket finding 01. |
| D4 | Rebelipay cost on a PDF is the **exact** sum of `amount x pct + per-txn fee` over every card type, rounded **once** per statement (half up, integer arithmetic). Per-card-type rows are allocated from that total by largest remainder so they add up. CSV rows are rounded per transaction, as the rule says. | Reproduces the plan's worked table to the cent (e.g. WR May: exact sum 5,498.128545 -> $5,498.13; rounding per card type would give $5,498.12). It is also the unbiased estimate of "every transaction rounded to the cent" when individual transactions are not on the PDF. |
| D5 | **Refunds give the fee back** (`rules.rebelipay.refundsReturnFee`, default `true`): the charge on refunded transactions is credited. With it set to `false` the engine reproduces the plan's gross-only worked table exactly; with it `true`, stores that had refunds (Spotswood and Millstone, every month) keep slightly more. | Plan §14 Q5 answer ("the fee is also refunded, this should be configurable"). |
| D6 | **"Explore Rebelipay" opens `REBELIPAY_CTA_URL` (default `https://rebelipay.com`) in a new tab**, records a `rebelipay_interest` event (visible in the log) and forwards the lead to `REBELIPAY_LEAD_WEBHOOK` when set. There is no contact form. | Plan §14 Q7 answer ("CTA should take the user to https://rebelipay.com, that's it for the moment, configurable later"), while keeping the ticket's event + webhook acceptance criterion. |
| D7 | The Rebelipay price (2.55%, 10¢) appears **nowhere** in the UI, CSV or API, not even in the footnote. Only totals and one all-in effective rate are shown. | Ticket acceptance criterion ("anywhere: UI, CSV export or API payload") is stricter than the plan's footnote and wins. |
| D8 | Hash duplicates create no row (`200 {duplicate:true}`). The hash lookup follows a tombstone to its original, so the bytes of a re-scan that already became a duplicate are recognised before any read is paid for. Two uploads of one file arriving together both insert; the later one then sees the earlier and deletes its own row and file. Identity duplicates (same merchant # and period end, found after extraction) become a `duplicate` tombstone pointing at the original, are hidden from the list, lose their stored file, and log a `duplicate` event on both rows. | Ticket: "No second row is created" (none is ever listed); the tombstone lets the screen explain where the row went. |
| D9 | Extraction does **not** capture owner name, street address or the full TIN; only `tin_last4`. Fixtures and examples carry `"0000"` in place of the real last four digits. | Data minimisation; nothing in the analysis needs them (plan §13 sensitive data). |
| D10 | The detail endpoint re-runs the (pure, millisecond) analysis at read time with the merchant's current history, and computes "savings to date" at read time. List columns are the values stored at analysis time, re-filed when they move (D44). | Upload order no longer matters for the legacy trend, and savings to date always covers every uploaded statement. |
| D11 | Fee-line rate check tolerance is `max($0.05, 0.01% of rate x base)`, not a flat $0.02, and a new check compares fee-line bases with card-type sales per network. | The processor rounds per transaction: WR Jul `VISA DEBIT ... 0.03 x $119,190.57` = 3,575.7171 but is printed $3,575.74 (off by $0.0229), and four legacy statements print a DISCOVER DEBIT line 2.2 to 2.7 cents off, so a $0.02 floor fails real statements whose fee lines still add up to the printed total. The base check validates debit volume, the headline KPI. |
| D12 | Extraction and reconciliation live in their own modules (`cardStatementExtract.js`, `cardStatementReconcile.js`); the engine is split into rules, pricing and analysis; list search is its own pure module (`cardStatementSearch.js`). | Testability; each piece is pure or I/O-only. |
| D13 | **One deadline per read, and a sweep that never catches a live one.** Every model call carries `{ timeout, signal: AbortSignal.timeout(ms) }`: the SDK's `timeout` only covers the wait for headers, the signal also cuts off a stalled body, and the SDK's single retry (`maxRetries: 1`) runs under the same signal. A whole read therefore ends within `CS_PARSE_TIMEOUT_MS` (default 240000; the CSV column-mapping call has its own 60 s). Stuck rows: at boot, and lazily on list/detail reads, rows `analysing` for more than `CS_STALE_MINUTES` (default 10) become `failed` with "Interrupted by a server restart. Reanalyse it to read it again." A `CS_STALE_MINUTES` below the read deadline plus 2 minutes (6 with the defaults) is raised to that floor, with one warning in the log. | Ticket + plan §8; the critique of Quick-PO's stranded rows; safe if several instances boot at once. |
| D14 | Fixtures in the repo are hand-verified **JSON only**, with merchant name and number kept and nothing else identifying (TIN `"0000"`, checked by the reconcile suite). The PDFs stay outside the repo; the extraction smoke script takes a path and prints the TIN as `"0000"` too. | `backend/tests/fixtures` is tracked; real statements must not be committed. |
| D15 | Copy never names the AI vendor and uses no em or en dashes, except the "—" the ticket asks for in the list's Rebelipay column when not eligible (and the same placeholder for any unknown figure). | Repo copy rules (`routes/chat.js`, `utils/errors.js`). |
| D16 | `is_prior_period` is **always derived from the date** when the period start is known (`date < period.start`); the model's flag is used only when there is no period start. The engine also marks any row dated before the period as prior-period. | The date is printed; the flag is an inference, and the inference is ours to make. |
| D17 | A read that stops at `max_tokens` **always fails** (`EXTRACTION_TRUNCATED`), even when the JSON happens to close. | A statement cut short reconciles badly and analyses quietly wrong. |
| D18 | multer runs with `defParamCharset: 'utf8'`. | Browsers send the file name as raw UTF-8; the latin1 default turns "Déclaration.pdf" into "DÃ©claration.pdf" on the list. |
| D19 | The service requires the reader, reconciler, engine, pricing and rules **lazily**, on first use. | The router is loaded by `server.js` at boot and by `check-routes`; loading the reader there builds a model client in processes that never read a statement, and a fault in one module would take the whole router down instead of failing the one request that needed it. |
| D20 | Split funding counts only Amounts Funded rows **with sales** (`submitted > 0`). | Some statements fund every day's fees as a separate $0 row; that is a fee debit, not a split deposit (WR Jul: 49 rows, 17 split days). |
| D21 | **Savings to date** sums the raw saving of every `analysed` statement of the same client and merchant that has one (`costs_more` negatives included; `no_current_fees`, `no_volume` and `incomplete` statements have none and are skipped). The API returns it only when the amount is positive and covers at least 2 statements, and the screen shows it only on an eligible statement's hero. | One statement's raw saving could be negative, and a negative saving must not be shown or derivable. |
| D22 | `costs_more` keeps `currentRate` (and `transactions`, `volume`) and removes every field the saving could be worked back from. | The processor's fees and rate are on the page anyway; the Rebelipay side is what must not leak a negative saving. |
| D23 | `no_volume` (nothing priced, priced volume or charge at or below zero, or amount submitted at or below zero) and `incomplete` (a card type with money on it but no gross, no count, or refunds without a refund count) keep `currentCost` and `currentRate` and null every Rebelipay figure; `byCardType` is `[]`. `incomplete` also nulls `transactions` and `volume`. | A partial sum would price as too low and inflate the saving, while the totals still reconcile (they use net). |
| D24 | **Absent is null, never zero**, everywhere a statement does not show something: daily `totals.fees` / `totals.processed` when no daily row has them; `splitFundingDays` when there is no Amounts Funded section; `kpis.transactions` when a card type with money has no count; `debitVolume` when it cannot be trusted (§5); a CSV's `disputes` and its daily disputes and adjustments; a CSV fee cell left blank. | "Missing is not zero" (§5): a $0.00 the statement never printed is a claim it never made. |
| D25 | A negative amount submitted fails the row (`AMOUNT_NEGATIVE`, "Could not read this statement: the amount submitted came out negative."). A $0 month is analysed and simply gets no Rebelipay comparison (`no_volume`). | A negative card volume is a misread (sales read as refunds, a slipped sign); zero is a real, if quiet, month. |
| D26 | In a CSV, a Type column whose values are only credit, debit or prepaid (optionally with "card") is the card's **funding type** and never marks a refund. "Credit" means a refund only in a column that also has sale or purchase rows. | Reading "Credit" as a refund turns every credit-card sale into one. |
| D27 | `client_id` and `location_id` are `integer`, and `content_sha256` is `char(64)`, not `text`. | They are what QuickPO's tables use (`008_purchase_orders.sql`, `013_po_content_hash.sql`), and the JWT carries the ids as numbers. |
| D28 | `card_statement_events` is **append-only**: `SELECT, INSERT` for `bottleai_writer` (both tables' sequences `USAGE, SELECT`). | The plan says both "copy `012_po_grants.sql`" and "S/I/U/D on both tables"; 012 makes the events table append-only, and nothing here updates or deletes an event. |
| D29 | **No `deleted` event.** Deleting a statement removes its events with it (`ON DELETE CASCADE`), so the delete is recorded in the server log (`[CS] statement deleted`, id, client, status) instead. | The plan asks for both the cascade and a `deleted` row on that same statement; a row that the delete removes (or that the foreign key refuses) records nothing. |
| D30 | The router is mounted with `verifyToken` only, without `attachPool`. | `attachPool` attaches the tenant-scoped POS (syncgo) pool, which nothing in this feature reads; every query runs on the analytics pool. |
| D31 | `POST /:id/reanalyse` with `reextract: true` answers **202 `{id, status: 'analysing'}`** and reads the file in the background, like an upload; only the default (analysis only, no model call) answers with the fresh detail. | A re-read takes as long as the first read (a minute or more), longer than a request should be held open. |
| D32 | The `MAESTRO REGISTRATION` catalogue entry matches `/MAESTRO REG(ISTRATION)?\b/i`. | The statements print "MAESTRO REG"; the plan's pattern finds nothing on them, while `statement.html` lists Bethany's "Maestro registration $0.28" as a watch line. |
| D33 | Reconciliation has an eighth check, `card_type_rows` (every card-type row with money has its gross and count, a refund count when it has refunds, and adds up), so `parse_confidence` is out of 8, not 6. | A row missing its count or gross reconciles on totals yet prices wrongly; this catches it before the comparison is shown (with D23's `incomplete`). |
| D34 | The detail screen lives in its own component, `CardStatementDetail.js` + `.css` (prefix `csd-`), with `RebelipaySavingsHero` inside it; the list (`CardStatementsScreen`) still switches to it by `openId`. | The detail is over 1,800 lines on its own; one file for both screens would be too large to review. Nothing about the flow changes. |
| D35 | A CSV's stored extraction keeps `0` for summary disputes and adjustments when the export has no such columns; the engine reads them as missing, so the screen shows "—", never "$0". | A transaction export says nothing about disputes; the engine's null is what reaches the owner (§3.3). |
| D36 | **One way to redo a statement: Reanalyse.** The header has Original, CSV, Reanalyse and Delete; no Refresh and no "Analyse again" menu. Reanalyse reads the stored original again from the start (the API's `reextract`): every printed total is checked again and the analysis rebuilt. While it runs the statement's status chip and the button say Analysing…, no figures show, and the page polls; when it lands the chip says Analysed (or Could not read) and a note under the button gives the result ("Reanalysed · 7 of 7 totals add up"). The API's analysis-only re-run stays but is not offered on screen. Each Reanalyse of a PDF is one model read. | Owner request: Refresh only reloaded what was already there, and three reload options were confusing. Every load already re-runs the analysis (D10), so the one action worth a button is a real re-read that verifies everything again. |
| D37 | **The Overview's finding cards show figures, not sentences.** Each card is its title, the impact figure, tiles, a chart or table, and at most one callout. The "What the statement shows / What it doesn't say" panes, the footnotes, the chart captions and the "From statement line" lists are gone from the cards, and each figure appears once per card: a tile that repeats the header's figure is left out. The one fact the figures cannot carry gets a single line: a trend built from uploads ("Built from your 2 uploaded statements for this store, May 2026 to Jun 2026.") and a layout with no customer counts. The API keeps `shows`, `hidden`, `footnote` and `sourceRefs`; the Fees, Daily and Notices tabs still list every statement line. | Owner request: the cards were about 1,000 words per statement, two thirds of it prose that said each figure two to four times ("$3,724.61" four times in Finding 01). Now about 470. The panes also kept printed facts apart from arithmetic on them; that cue now lives only where it changes the reading (the trend's source line). An unavailable card keeps its reason and its footnote. |
| D38 | **No Store column on the list.** Each store uploads its own statements, so every row named the same store. The first column is a "View" button, the only way into a statement (its accessible name and tooltip carry the store and the period); the list sorts newest period first (`sort=period`). A statement not read yet shows its file name in the Merchant # cell, the one place that still says which upload it is. The store filter stays, and shows only when a client has more than one store. | Owner request. |
| D39 | **Plain words, and an ⓘ on every figure.** The detail page names things the way an owner would (card sales, fees you paid, sent to your bank, average sale, fee rate, vs last month, earlier sales), one term per concept (the glossary in §8.4), and every figure, heading and chip that needs it has an ⓘ (`MetricInfo`) saying what it is and how it helps, in a sentence or two. Each finding has a topic line above its title ("FINDING 01 · DEBIT VS CREDIT FEES ⓘ"). The engine's finding text follows the same words (titles, impact words such as "vs a year ago", callouts, anomaly sentences, fee fixes, notice actions). A CSV upload is a "file" covering a "period" wherever the page knows the layout. Finding tiles are as wide as their words, text centred. | Owner request: "few titles are not understandable", e.g. "Month on month". The copy was drafted per page region, checked against the code, and made consistent in one pass. |
| D40 | **One donut ring: today's fees by card type.** The savings box's donut is a single ring of what was paid today, split by card type in the Card types colours, with the three totals in its middle (Paid today, With Rebelipay, You save) and a card type's own amounts when it is pointed at. The bars carry the comparison. | Owner request: the saving ring inside a thin card-type ring read as two charts and confused. Before that, the two-slice saving ring alone looked plain. |
| D41 | **The list's headings, short, each with an ⓘ.** Merchant ID, Card sales, Fees paid, Effective rate, Debit share, Save with Rebelipay, Findings and Log each carry an ⓘ saying what the column is (Effective rate: fees divided by card sales, cents per $1); Period and Status are plain already. The statement page uses the same four names (Merchant ID, Fees paid with "{pct} effective rate", Debit share). The headings and cells are 8px a side, each ⓘ follows its heading's last word, and "Save with / Rebelipay ⇅ ⓘ" breaks after "with", so the heading row is two lines at most. The shared ⓘ popover (`MetricInfo`, app-wide) is snug: 13.5px text, 8 to 11px padding, 264px wide. | Owner requests: "Eff. rate what is this?"; then "Merchant ID", "Fees paid", "Effective rate", "Debit share" in place of the longer plain names, the heading row without its spacing, and a popover that was "very big with small text". |
| D42 | **The daily chart names its months.** Under the day numbers, each month's name is centred under its days ("Apr" under one carried-over day, "May 2026" under the rest; "July 2026" on a one-month statement), and a dashed line marks where a new month starts. A name too wide for its days takes a shorter form ("Apr 2026", then "Apr"); where even that is too wide, the first month's name ends at the dashed line and the last month's starts there. The chart is 6px taller for the row, so the bars keep their height. The same chart is used in finding 04 and on Day by day. | Owner request: "there are only dates below so add something so that it differentiates between months". A statement that starts with a day from the month before read "30, 1, 2 ... 30". |
| D43 | **The Overview by priority.** Over the cards, one line: "5 of 6 checks flagged something" ("All 6 ..." would need finding 03 flagged, which it never is). With nothing flagged it says "Nothing to fix on this statement" (file) only when every check ran; otherwise "The 2 checks we could run found nothing to fix", or "We could not run any checks on this file". "We could not run 1 check on this statement." follows when some ran and some could not. The flagged checks come first, in full, each labelled by its level (D45). The rest follow under a "Lower priority" heading (shown only when both groups have cards), smaller and grey, the headline figure 18px in the secondary text colour: a check that ran with nothing to fix is labelled "Nothing to fix" and folded to its title and figure behind "Show details" (a button with `aria-expanded`, named for its check, "Show details for Customers and cards"; the details mount when opened and stay open across tabs, closed again on another statement); one with nothing past its title ("No junk fees on this statement") has no button; a check that could not run is labelled "Not checked" and shows its one-line reason in full. Every card keeps its number, so "Finding 03" is the same check on every statement. The list reads "5 of 6 flagged" ("None flagged" at none), and the Log's analysed rows read "Findings flagged: 5 of 6". "Checks" means only these six; the printed totals that agree are "totals": "7 of 7 totals add up" after a Reanalyse, "Totals: 7 of 7 add up" in the Log, "Totals that add up, 7 of 7" and "Findings flagged, 5 of 6" in the CSV export. The list's Findings ⓘ: "How many of the six checks on the statement flagged something: Urgent, Needs a look or Worth a look. Open the statement to see them, each with why." | Owner: "5 findings flagged but when opened it shows 6 findings, I didn't get this", then "differentiate the important findings and the one unimportant finding as not much priority required". The page always shows all six checks, and only the colour of the headline figure told a flagged one from the rest. |
| D44 | **The list's figures are kept in step with the page.** Opening a statement re-runs the engine (D10); when its figures differ from the ones filed with the row (card sales, fees, sent to your bank, number of sales, effective rate, debit share, the flagged count, the Rebelipay figures), or an older engine filed it, the read files the fresh ones with the fresh analysis and version, guarded by `status = 'analysed'`. A statement analysed, deleted, failed or turned duplicate on "Analyse again", or sent to be read again (the moment it starts: it is out of the history while it is read, whatever the read then finds), also re-files the same store's later statements, since their trends are built from the earlier ones (a statement just analysed re-files itself as well, in case an earlier one of its store landed while it was read); those runs go one at a time per store in the process, and one statement the engine cannot re-run does not stop the rest. When a rule changes a listed figure, `ANALYSIS_VERSION` is raised, and the list re-files the requesting client's rows an older engine filed before listing them (only that client's, as the lazy sweep does). Leaving a statement through the sidebar reloads the list, as Back does. Figures within half a unit of the column's last decimal count as the same, so a row is never rewritten on every open. `updated_at` is left alone: this re-files derived figures, it is not an upload or a re-read. Another client's rows are never touched (every statement carries the client predicate). After a rule change, a statement's list row catches up when it is opened, re-read, or an earlier statement of its store changes. | The list read "5 flagged" from the figures filed when the statement was read, while the page re-ran the engine; a rule change or an earlier month uploaded later would have made them disagree. |
| D45 | **Each flagged check says how much it matters, in words.** Its label is its level: "Urgent" (high, red), "Needs a look" (medium, pink), "Worth a look" (low, violet); the headline figure keeps the same colour. The cards stay in number order within the flagged group. A "Start with Urgent (2), then Needs a look (3)." line under the summary was tried and taken out at the owner's request: each card now says why it has its level (D47). | Owner: "\"Urgent\" (red), \"Needs a look\" (pink), \"Worth a look\" (violet)... mentioning this somewhere can help the user to understand what all he needs to focus on"; then "remove this [Start with ...] and let the user know why a task is urgent, needs a look, on what basis this is decided". Pink and violet are close in this palette, so the level could not rest on colour alone. |
| D46 | **Everything a card lists to check flags its check.** Finding 04 is flagged when any day is listed (a split deposit too, which says "check it reached your bank"): medium for a low sales day or fees with no sales, low otherwise. Finding 05 is flagged when any fee is tagged (one to ask about or keep watching too): medium for a penalty or a fee that could be cut, low otherwise. Finding 06 is flagged by a notice about a new way to get your statements too, at low ("A notice says the way you get your statements is changing"); only "other" notices, which say to read them once, leave it unflagged, and with the disputes line not read its title says "No urgent notices", never "no disputes". A finding 04 flagged for split deposits alone is titled "Some days' card sales were paid in more than one deposit", the busiest-days figure staying in its tile. So "Nothing to fix" never sits over "1 fee to check", a red split-deposit row or a notice that asks for a step. ANALYSIS_VERSION 2, then 3. On the test statements: Wine Republic Jul and Millstone Jul 4 to 5 flagged (split deposits), Millstone Jun 2 to 3 (a fee to ask about). | The review of D43: the label said "Nothing to fix" on a card titled "1 fee to check", and over a red "Split deposit" row whose ⓘ says to check the bank. |
| D47 | **Why, and against what.** (1) Each flagged check carries the engine's `why`, shown under its title after a lead for its level ("Why it's urgent:", "Why it needs a look:", "Why it's worth a look:"), e.g. "Debit cards brought in 54.68% of your card sales, and you paid 3.00% on them, the same as on credit cards. Debit usually costs less, so you pay too much on most of your sales, every month." Its ⓘ, "How we decide what is urgent", gives the rule: "We sort what we find by how much it can cost you and how soon you need to act. Urgent: it costs you money on most of your sales every month, or a change needs a step from you now. Needs a look: it may be costing you money, or needs checking soon. Worth a look: something to check when you have time; nothing looks wrong." `why` is null on an unflagged check. (2) `kpis.lastMonth`, from the same store's statement for the month right before (its filed figures, D44) when it is on file and comparable: a statement, not a CSV file, of 28 days or more, as this one must be (the legacy trend leaves short uploads out too): card sales, fees, sent to your bank and the average sale as a percent change, the effective rate and debit share as last month's values; card sales take finding 02's month-on-month change at its own rounding, so the page never gives two numbers for it, with `cardVolumeSource` "printed" (this statement prints it) or "uploads", which its ⓘ says. Null for a CSV (any span) or when nothing is known. The band shows "up 10.32% from last month" (green when good for the owner, red when not; the words carry it without the colour; fees take the effective rate's colour, since they rise with sales: red only when the rate went up), "3.01% effective rate, same as last month" (the same when both read the same to two places), "was 55% last month". The why sentences say only what is true for the case: "the same as" credit only when the rates print the same, "about the same as the 3.00% on credit cards" within the 0.05-point rule; "half or more" as the share reads to two places; earlier sales get a bookkeeping step, split deposits "check each deposit reached your bank"; a fee to cut points to the table's step, a fee we do not recognise is never called harmless; disputes give the count when rows were read, else the amount, with "check each one against your receipts". The level ⓘ reads "We label what we find by how much it can cost you and how soon you need to act. ..." (3) The biggest sales day against a usual day of its weekday (the median of the period's other days on it): "4.2 times a usual Saturday", or "about what a usual Saturday brings in" under 1.1 times. | Owner: "let the user know why a task is urgent, needs a look, on what basis is this decided, and also add vs day or vs month differences if required for any boxes, so the user can get a clear understanding". |
| D48 | **Finding 01 is a fact, never a flag.** It says how much of the card sales was debit ("Debit is 55% of your card sales", the share rounded to a whole percent; "What debit cards cost you" when the share is not known), with the debit card sales as its figure ("$124,144.13 in debit card sales"), severity `info`, `why` null, so it always sits under "Lower priority" as "Nothing to fix". Its tiles are the two fee rates side by side and the debit card fees, with no verdict and no alert colour; the debit share and the debit card sales are not repeated in tiles since the title and figure carry them. Its topic reads "Debit cards". The KPI band's Debit share note is always "$X on debit cards". `metrics.sameRate` stays, for the record. The key stays `debit_at_credit_rates` so stored rows and links keep working. ANALYSIS_VERSION 4: every statement reads one fewer flagged check where finding 01 was flagged (the four test stores' July statements, 5 to 4). | Owner feedback: drop the overcharge framing. Rebelipay charges one price for every card type, debit and credit alike, so telling the owner that debit at the credit rate is wrong argued against the offer on the same page. |
| D49 | **The year first, and the saving split as the owner would act on it.** (1) A penalty on the fee table (`tagFeeLine` → `penalty`, e.g. NON RECEIPT OF PCI VALIDATION, $29.95) stops once the store fixes its cause, with any processor, so it is no longer part of the switching saving: `savings = currentCost − penalties − rebelipayCost`; the penalty is `penaltyFix` (`penaltyFixAnnual`, ×12 when monthly, once when yearly; `penaltyFixLabel` "Fix the PCI penalty (free, about 20 minutes)" when every penalty line is the PCI one, else "Stop the penalty fees"); `totalFound = savings + penaltyFix` and `totalFoundAnnual`. With no penalty `penaltyFix*` are null and `totalFound*` equal `savings*`. The by-card-type account row leaves the penalty out, so the rows still add up to `savings`. (2) A year counts a once-a-year fee once: `savingsAnnual = (savings − yearly fees) × 12 + yearly fees` (Millstone Jul, a $159 annual compliance fee: $3,577.32, not $5,326.32). (3) The hero leads with the year: "Botella found you about **$5,460** a year in savings" over three lines, Switch to Rebelipay $5,100 a year · $425.03 on this statement, Fix the PCI penalty (free, about 20 minutes) $359 a year · $29.95, Total savings Botella found $5,460 a year · $454.98; with no penalty "With Rebelipay, you could save about **$3,577** a year" over "$443.86 on this statement ⓘ". The KPI tile reads "$5,100/yr" over "$425.03 on this statement (est.)", the list column "$2,199/yr" over "$183.25 this statement". The savings to date, the list's sort and the DB columns stay the switching saving. ANALYSIS_VERSION 4. | Owner: "we should highlight the yearly number vs the monthly number as that is more attractive", with the split "Switch to RebeliPay ~$425/mo, Fix PCI penalty (free, ~20 min) ~$30/mo, Total savings Botella found ~$455/mo"; asked whether a yearly fee should count 12 times, "Count them once". |

---

## 1. Files

| Layer | File | Notes |
|---|---|---|
| Migrations | `backend/database/analytics-migrations/023_card_statements.sql`, `024_card_statement_events.sql`, `025_card_statement_grants.sql` | §2. Applied locally 2026-10-07; checksummed, do not edit. |
| Rules | `backend/services/cardStatementRules.js` | versioned constants: Rebelipay offer, fee catalogue, notice actions, thresholds. Never serialised to the API (a non-enumerable `toJSON` turns an accidental `JSON.stringify` into a placeholder). |
| Pricing | `backend/services/cardStatementPricing.js` | pure: Rebelipay pricing (§6), savings to date |
| Engine | `backend/services/cardStatementAnalysis.js` | pure: `analyse()` (§5) |
| Extraction | `backend/services/cardStatementExtract.js` | PDF via Claude (§3), CSV via deterministic parser (§3.3) |
| Reconciliation | `backend/services/cardStatementReconcile.js` | pure: checks (§4), core-header test |
| Search | `backend/services/cardStatementSearch.js` | pure: the list's search box, words and periods to one parameterised SQL condition (§7) |
| Service | `backend/services/cardStatementService.js` | storage, lifecycle, persistence, list/detail, events, duplicates, CSV export, recovery |
| Routes | `backend/routes/card-statements.js` | §7; mounted in `backend/server.js` |
| Smoke script | `backend/scripts/cs-extract-sample.js` | `node scripts/cs-extract-sample.js <pdf|csv> [fixture.json]` prints the extraction, its reconciliation and its diff against a fixture (TIN shown as `"0000"`). Exit 0 read, 1 extraction failed, 2 usage. |
| Tests | `backend/tests/card-statement-analysis-verify.js`, `card-statement-rebelipay-verify.js`, `card-statement-reconcile-verify.js`, `card-statement-routes-verify.js`, `card-statement-search-verify.js`; runner `backend/tests/run-card-statement-tests.js`; fixtures in `backend/tests/fixtures/card-statements/` | §9 |
| Screen | `frontend/src/components/CardStatementsScreen.js` + `.css` | list, upload dialog, log modal, duplicate and upload notices |
| Detail | `frontend/src/components/CardStatementDetail.js` + `.css` | header, banners, Rebelipay hero, KPI band, findings, tabs |
| Registration | `frontend/src/components/Sidebar.js`, `frontend/src/App.js`, `frontend/src/pages/ChatPage.js`, `frontend/src/utils/features.js` | §8.1 |
| Wiring | `backend/server.js` (mount, boot sweep), `backend/package.json` (`"test"`), `backend/scripts/doctor.js` (checks both tables exist), `backend/.env.example`, `frontend/.env.example`, `.gitignore` and `backend/.dockerignore` (`backend/data/card-statements/`), `ANALYTICS-SCHEMA.md` §8 | |

---

## 2. Data model (`bottleai_analytics`)

### 2.1 `023_card_statements.sql`

```sql
CREATE TABLE IF NOT EXISTS card_statements (
  id                 bigserial PRIMARY KEY,
  client_id          integer     NOT NULL,          -- visibility scope (D1)
  location_id        integer     NOT NULL,          -- where the upload came from; audit only
  status             text        NOT NULL DEFAULT 'analysing'
                     CHECK (status IN ('analysing','analysed','failed','duplicate')),
  parse_error        text,                          -- owner-safe text only

  processor          text,
  merchant_number    text,
  merchant_name      text,
  period_start       date,
  period_end         date,
  layout_version     text,                          -- 'legacy_2026' | 'v2_2026' | 'csv' | 'unknown'
  amount_submitted   numeric(14,2),
  total_fees         numeric(14,2),                 -- positive
  amount_processed   numeric(14,2),
  transaction_count  integer,
  effective_rate     numeric(7,4),                  -- percent, e.g. 3.0154
  debit_share        numeric(7,4),                  -- percent
  findings_count     integer,
  rebelipay_cost     numeric(14,2),
  rebelipay_savings  numeric(14,2),                 -- raw: negative when Rebelipay costs more. Never returned negative by the API.
  rebelipay_savings_annual numeric(14,2),
  rebelipay_eligible boolean,

  extracted          jsonb,                         -- §3, snake_case
  analysis           jsonb,                         -- §5, camelCase, public-safe
  reconciliation     jsonb,                         -- §4
  parse_model        text,
  parse_confidence   numeric(5,4),
  parse_ms           integer,
  analysis_version   integer,

  file_name          text,
  file_mime          text,
  file_size          integer,
  file_path          text,                          -- relative POSIX path under CS_UPLOAD_DIR
  content_sha256     char(64),
  duplicate_of       bigint REFERENCES card_statements(id) ON DELETE CASCADE,

  uploaded_by        text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
-- list + paging
CREATE INDEX IF NOT EXISTS card_statements_client_created_idx ON card_statements (client_id, created_at DESC);
-- hash duplicate check
CREATE INDEX IF NOT EXISTS card_statements_client_hash_idx ON card_statements (client_id, content_sha256) WHERE status <> 'duplicate';
-- history, savings to date, store filter
CREATE INDEX IF NOT EXISTS card_statements_client_merchant_period_idx ON card_statements (client_id, merchant_number, period_end);
-- one analysed statement per merchant + period per client; a second one is an identity duplicate
CREATE UNIQUE INDEX IF NOT EXISTS card_statements_identity_uniq ON card_statements (client_id, merchant_number, period_end) WHERE status = 'analysed';
-- stale sweep
CREATE INDEX IF NOT EXISTS card_statements_analysing_idx ON card_statements (updated_at) WHERE status = 'analysing';
```

Follow the house migration style: banner with `DATABASE: bottleai_analytics` and a WHY section (why analytics, why
JSONB not child tables: sections are read whole and never edited line by line), `BEGIN; ... COMMIT;`,
`IF NOT EXISTS` everywhere, no `CREATE INDEX CONCURRENTLY`, `COMMENT ON` for intent, commented Verify and Rollback
sections at the end.

The hash lookup (`findByContent`) now also matches tombstones and follows them to their original (D8). The partial
hash index cannot serve the tombstone side of that query, which falls back to the per-client index; that is fine at
per-client row counts. A full `(client_id, content_sha256)` index would need a new migration `026`; none is written.

### 2.2 `024_card_statement_events.sql`

Mirror `010_po_events.sql`: `card_statement_events (id bigserial, statement_id bigint NOT NULL REFERENCES
card_statements(id) ON DELETE CASCADE, client_id integer NOT NULL, location_id integer, event text NOT NULL,
actor text, payload jsonb, created_at timestamptz NOT NULL DEFAULT now())`, indexes on `(statement_id, created_at)`
and `(client_id, created_at DESC)`. Append-only. Writing an event never fails its caller.

| Event | Payload |
|---|---|
| `uploaded` | `{ fileName, size, kind }` |
| `analysed` | `{ checksPassed, checksTotal, confidence, findings, ms }` |
| `reanalysed` | the `analysed` payload for a synchronous re-run; `{ reextract: true }` when the file is read again (its result then logs `analysed`) |
| `analysis_failed` | `{ message }` (the owner-safe text) |
| `duplicate` | same file: `{ reason: 'same_file', fileName }` on the original; same statement: `{ reason: 'same_statement', duplicateOf }` on the tombstone and `{ reason: 'same_statement', duplicateId, fileName }` on the original |
| `interrupted` | `{ staleMinutes }` |
| `rebelipay_interest` | `{ merchantNumber, merchantName, period: { start, end, label }, savings: { volume, currentCost, rebelipayCost, savings, savingsPct, savingsAnnual, totalFound, totalFoundAnnual, currentRate, rebelipayRate }, user }` (totals and all-in rates only) |

Deletion is logged with `logger` (the row and its events are gone).

### 2.3 `025_card_statement_grants.sql`

Mirror `012_po_grants.sql`. `card_statements`: SELECT, INSERT, UPDATE, DELETE. `card_statement_events`: SELECT,
INSERT only (append-only; cascade deletes run as the table owner). `USAGE, SELECT` on both `_id_seq` sequences.
Grants are invisible locally (the app role owns the database here) and fatal in production if missing.

---

## 3. Extraction

`cardStatementExtract.extract({ buffer, kind, fileName })` -> `{ extracted, model, ms }`. Errors carry `.code` and
`.publicMessage` (the only text an owner may see); the raw cause stays on `.cause` for the logs.

### 3.1 PDF

`cardStatementExtract.extractPdf({ buffer, fileName })` sends the PDF as a base64 `document` block **before** the
text prompt in one user message, via `anthropic.messages.stream({...}, { timeout, signal }).finalMessage()`, reads
only `type === 'text'` blocks, and parses with an `extractJson` copied from Quick-PO.

- Model: `process.env.CS_PARSE_MODEL || process.env.PO_PARSE_MODEL || 'claude-sonnet-5'` (plan §6.4: "defaults to the
  same model as PO_PARSE_MODEL"). `max_tokens`: `CS_PARSE_MAX_TOKENS` (default 32000). Streaming is mandatory
  (SDK 0.39 refuses non-streaming requests above ~21,333 max tokens).
- Do **not** send `temperature`, a forced `tool_choice`, or a `thinking` setting: newer models reject them, and the
  model must stay swappable through the env var. Thinking may run, so never read `content[0]`.
- Client: `new Anthropic({ apiKey, maxRetries: 1 })`. Deadline (D13): `CS_PARSE_TIMEOUT_MS` (default 240000) as both
  the SDK `timeout` and an `AbortSignal.timeout` on the whole body, retry included. `READ_DEADLINE_MS` =
  max(parse timeout, the 60 s CSV mapping timeout) is what the stale floor is computed from.
- Limits: 20 MB upload -> ~27 MB base64, under the 32 MB request limit; statements are 4-6 pages.

Failures (all owner-safe; raw text goes to logs only and `parse_error` never names the vendor or an env var):

| Code | When | Owner message |
|---|---|---|
| `EXTRACTION_TRUNCATED` | `stop_reason === 'max_tokens'`, always (D17) | This statement has more detail than one read can return. Reanalyse it, and contact support if it happens again. |
| `EXTRACTION_REFUSED` | `stop_reason === 'refusal'` | This file could not be processed. Check that it is a card processing statement. |
| `EXTRACTION_UNREADABLE` | no JSON in the reply, or a 400 about the document itself (encrypted, corrupt) | The file was opened but no statement figures could be read from it. Check that it is a card processing statement. |
| `EXTRACTION_UNAVAILABLE` | no API key, any other model error | The statement reader is temporarily unavailable. Reanalyse it in a few minutes. |
| `EXTRACTION_UNAVAILABLE` | the deadline fired | Reading this statement took too long and was stopped. Reanalyse it in a few minutes. |

**Post-processing (`normaliseExtracted`).** The model copies; the code does not trust the format. Numbers are coerced
(`"$1,234.56"`, `"(12.00)"`, `"12.00-"`), fees, disputes, refunds and chargebacks made positive, dates made ISO, card
types taken from the printed label (the model's type only when the label names no known brand), `network` taken from
the description (debit schemes and PIN networks such as MAESTRO, STAR, PULSE, NYCE, ACCEL, PAVD, SHAZAM, INTERLINK ->
`DEBIT`; account fees never take a network from the model), rate/base and count/unit price parsed back out of the
verbatim description (descriptions over 300 characters are not parsed; the model's values are used),
`is_prior_period` set from the date (D16), a "Month End Charge" row the model put in `daily` moved to
`month_end_charges`, total rows dropped, `reportable_sales` cut to `tin_last4` and the amounts (D9), and every key
outside the schema dropped. Extracted JSON is never logged at info.

### 3.2 Schema (`extracted`, snake_case). The prompt carries this schema and these rules.

```jsonc
{
  "processor": "Better Payments",              // from branding / customer-service block; null if unknown
  "layout_version": "v2_2026",                 // "legacy_2026" (Statement Period mm/dd/yy, SUMMARY block) | "v2_2026" (PERIOD: mm/dd/yyyy-mm/dd/yyyy, Account Summary equation) | "unknown"
  "merchant": { "number": "498387143882", "name": "WINE REPUBLIC" },
  "period":   { "start": "2026-07-01", "end": "2026-07-31" },
  "summary": {
    "amount_submitted": 194523.58,
    "paid_by_others": 0.00,                    // signed as printed; null when the layout has no such line (legacy)
    "disputes": 0.00,                          // POSITIVE amount deducted ("Chargebacks/Reversals -$26.36" -> 26.36)
    "adjustments": 0.00,                       // signed as printed
    "fees": 5865.65,                           // POSITIVE
    "amount_processed": 188657.93
  },
  "customers": { "new": 2650, "repeat": 1225, "avg_ticket": 28.11 },   // null when not printed (legacy)
  "sales_trend": [ { "month": "2025-07", "amount": 197745.60 } ],      // the printed 13-month bars, oldest first; [] when absent
  "printed_yoy_pct": -1.63,                    // null when not printed
  "printed_mom_pct": 4.11,                     // null when not printed
  "daily": [                                   // every dated "Summary by Day" row, printed order, INCLUDING prior-period rows;
    { "date": "2026-07-01", "submitted": 4128.77, "disputes": 0.00,   // NOT the "Month End Charge" row, NOT the Total row
      "adjustments": 0.00, "fees": 123.86, "processed": 4004.91, "is_prior_period": false }
  ],                                           // fees and disputes POSITIVE; adjustments signed; processed signed; is_prior_period from the date (D16)
  "month_end_charges": 29.95,                  // POSITIVE fees on the "Month End Charge" row; 0 if it shows 0; null if no such row
  "card_types": [                              // "Summary by Card Type" rows, printed order, no Total row
    { "type": "VISA", "label": "VISA", "avg_ticket": 27.82,
      "items": 5248, "gross": 146012.07,       // "Total Gross Sales You Submitted"
      "refund_items": 0, "refunds": 0.00,      // refunds POSITIVE
      "net_items": 5248, "net": 146012.07 }    // "Total Amount You Submitted"; net_items = items + refund_items as printed
  ],                                           // type: VISA | MASTERCARD | AMEX | DISCOVER | DEBIT | OTHER ("AMEX ACQ" -> AMEX; "Debit/Atm", "DEBIT CARD" -> DEBIT); label verbatim
  "fee_lines": [                               // every printed fee line, printed order, no subtotal/total rows
    { "category": "transaction",              // transaction | account | interchange | other
      "product": "Visa",                       // v2 "Product" column verbatim; legacy: the brand sub-heading (MASTERCARD/VISA/DISCOVER/DEBIT CARD/Other); null if none
      "network": "VISA",                       // from the DESCRIPTION: VISA | MASTERCARD | AMEX | DISCOVER | DEBIT | OTHER | null (account fees)
      "description": "VISA DEBIT SALES DISCOUNT 0.03 DISC RATE TIMES $119190.57",   // verbatim, single-spaced
      "is_debit": true,                        // description contains DEBIT, or network is DEBIT
      "rate": 0.03, "base_amount": 119190.57,  // from "<rate> DISC RATE TIMES $<base>"; else null
      "count": null, "unit_price": null,       // from "<n> TRANSACTIONS AT <price>"; else null
      "fee_type": "Service Charges",           // "Service Charges" | "Fees" | "IC/PF" | null, title-cased
      "amount": 3575.74 }                      // POSITIVE
  ],
  "chargebacks": [ { "date": "2026-05-18", "amount": 26.36, "reason": "Cardholder states transaction was not properly processed" } ],  // [] when none; no card digits, no reference numbers
  "funding": [                                 // "Amounts Funded" rows, printed order, no Total row; [] when the section is absent
    { "date_submitted": "2026-06-30", "submitted": 0.00, "fees": 29.95, "date_funded": "2026-07-02", "funded": -29.95 }
  ],
  "reportable_sales": { "tin_last4": "0000", "month_label": "June", "month_amount": 186843.89, "ytd_amount": 1001562.40, "ytd_year": 2026 },  // null when absent; "0000" stands in for the real digits in fixtures and docs (D9)
  "notices": [                                 // every notice / important-information paragraph, verbatim and trimmed
    { "text": "IMPORTANT NOTICE: Effective June 29, 2026, your Visa and Mastercard acquiring sponsorship ...",
      "kind": "acquirer_change",               // acquirer_change | ach_descriptor_change | delivery_change | fee_change | other
      "effective_date": "2026-06-29" }         // null unless a specific date is printed
  ]
}
```

Rules in the prompt: plain numbers (no `$`, no commas); fees, disputes, refunds and chargebacks positive;
adjustments, paid-by-others and funded amounts signed as printed; ISO dates (2-digit years are 20yy); descriptions
verbatim; rows dated before `period.start` get `is_prior_period: true` (e.g. `04/30/26` on a May statement,
`06/30/2026` on a July one; the code re-derives it anyway, D16); compute nothing that is not printed; null for anything
absent, never 0 for absent; notices may be printed as an image on the last page and must still be read. `kind`
guide: acquiring bank or sponsorship change -> `acquirer_change`; ACH company name / descriptor change ->
`ach_descriptor_change`; statement delivery method change -> `delivery_change`; a new or changed fee with a date ->
`fee_change`; anything else -> `other`. The prompt's own examples use made-up figures (TIN ending 1234,
$123,456.78, $234,567.89), never a real statement's.

### 3.3 CSV (transaction export)

`cardStatementExtract.parseCsv({ buffer, fileName })` is deterministic. One header row (optionally after preamble
lines), one row per transaction. Text is UTF-8, with a Latin-1 fallback and UTF-16LE (with BOM) accepted; the
delimiter is `,`, `;`, tab or `|`. The header is found among the first 30 records of the first 64 KB: exact alias
matches first, then a prefix pass for the required columns only (`amount usd`, `date utc`; never a card number column
for the card type). Columns are matched case-insensitively by alias:

| Field | Required | Aliases (examples) |
|---|---|---|
| date | yes | date, transaction date, txn date, trans date, settlement date, batch date, created, datetime, created at, transaction time |
| amount | yes | amount, sale amount, transaction amount, txn amount, total, gross, gross amount |
| card type | yes | card type, card brand, brand, network, card, payment method, scheme, card network |
| kind | no | type, transaction type, txn type, kind |
| status | no | status, result, transaction status (only approved / settled / captured / success / succeeded / complete / paid / ok / accepted / posted / processed / funded rows count when present) |
| fee | no | fee, fees, processing fee, discount, total fees |
| merchant number | no | merchant number, merchant #, merchant no, mid, merchant id |
| merchant name | no | merchant name, dba, dba name, store, location |

Row rules:

- **Refunds.** A negative amount is a refund. The kind column marks a refund when it says refund, return, reversal
  or chargeback. A kind column whose every value is credit, debit or prepaid (optionally "... card") or blank is the
  funding type and never marks a refund; "credit" alone is a refund only when the same column also has sale or
  purchase rows (D26). Rows whose kind says void, auth, declined, verification or cancel are skipped unless they also
  say refund or return (an "auth reversal" is skipped).
- Total and subtotal rows are skipped. A cell over 256 characters is read as empty, so its row is skipped before any
  parsing touches it; an amount over 64 characters, or over 32 once `$`, commas and spaces are removed, is not a
  number. Amounts accept `$1,234.56`, `(12.00)`, `-12.00`, `12.00-`; dates accept ISO, `MM/DD/YYYY`, `MM/DD/YY`, with
  or without a time.
- **Fees.** A blank fee cell is `null`, not $0 (D24); a fee column blank on every row leaves `summary.fees` null and
  the pricing reason becomes `no_current_fees`. When the sales' fees net negative the whole column is in the
  statement's minus convention and is flipped; a fee given back on a refund stays a credit.
- Card types normalise to the PDF set (visa; mastercard/mc/master card; amex/american express; discover;
  debit/atm/interac -> DEBIT; anything else OTHER).
- The merchant number comes from a column (most common value), else from the file name (the first run of 8-16 digits
  that is not a yyyymmdd date), else the row fails as Could not read. The merchant name is the column's most common
  value, if any.
- If the alias match fails and `ANTHROPIC_API_KEY` is set, the first 30 lines may be sent to the model **only to map
  columns** (a small JSON mapping, 60 s deadline, only header names really in the file are trusted); all rows are
  still parsed in code. If that call fails, the alias failure stands.

Failures: `CSV_COLUMNS` (names the missing columns: "Could not find the date and card type columns in this CSV. It
needs a date, an amount and a card type for every transaction."), `CSV_EMPTY` ("This CSV has no transaction rows to
analyse."), `CSV_NO_MERCHANT` ("Could not find a merchant number in this CSV. Add a merchant number column, or put
the merchant number in the file name.").

CSV `extracted` uses the same schema with `layout_version: "csv"`, `processor` null, `period` = first/last
transaction date, `summary.amount_submitted` = sales - refunds, `summary.fees` = sum of the fee column or `null`,
`amount_processed` = submitted - fees or `null`, `disputes` 0 and `adjustments` 0 (the engine reports both as unknown,
§5), `paid_by_others` null, `daily` grouped by date (`fees` and `processed` null without a fee column), `card_types`
grouped by type (`label` = type, `net_items` = sales + refunds), `fee_lines`, `chargebacks`, `funding`, `notices` `[]`,
`customers` and `reportable_sales` null, and two extra keys:
`"transactions": [{ "date", "amount", "card_type", "is_refund", "fee" }]` (amount positive) and
`"csv_source": { "columns": {...}, "rows_total", "rows_used", "rows_skipped" }`.

---

## 4. Reconciliation (`cardStatementReconcile.reconcile(extracted)`)

Deterministic; tolerance $0.05 unless stated. A check whose inputs are absent is `skipped` (`ok: null`) and not counted.

| name | label (owner-facing) | test |
|---|---|---|
| `daily_submitted_total` | Daily rows add up to the amount submitted | Σ daily.submitted (all rows, prior-period included) = summary.amount_submitted |
| `daily_fees_total` | Daily fees and month-end charges add up to total fees | Σ daily.fees + (month_end_charges or 0) = summary.fees |
| `card_types_total` | Card types add up to the amount submitted | Σ card_types.net = summary.amount_submitted |
| `fee_lines_total` | Fee lines add up to total fees | Σ fee_lines.amount = summary.fees |
| `summary_equation` | Submitted, less fees and disputes, plus adjustments, equals amount processed | submitted + (paid_by_others or 0) - disputes + adjustments - fees = amount_processed |
| `fee_line_rate_math` | Every rated fee line equals its rate times its base | for each line with rate and base: abs(rate x base - amount) <= max(0.05, 0.0001 x rate x base) (D11). expected = rated lines, actual = lines that agree; `detail` lists the failures |
| `fee_bases_match_card_types` | Fee-line volumes match card-type sales | per network with rated transaction lines: Σ base_amount = that network's card_types gross, or net. expected/actual count networks |
| `card_type_rows` | Every card type has its sales, refunds and counts | each card type row with money on it has `gross` and `items`, a `refund_items` when it has refunds, gross - refunds = net, and items + refund_items = net_items. expected/actual count rows; `detail` lists `{ index, type, problems }` |

Output: `{ checks: [{ name, label, expected, actual, ok, skipped, detail }], passed, total, confidence, ok }`;
`confidence = passed / total` (1 when total is 0) -> `parse_confidence`; `ok = passed === total`.
Any failed check still ends `analysed`; the detail view shows a warning banner listing the failed labels.
`card_type_rows` exists because `card_types_total` sums net only: a row read without its gross or count still adds
up, and pricing would treat the gap as zero (§6 `incomplete`).

`coreHeaderMissing(extracted)` returns the missing core fields among merchant number, statement period and amount
submitted; any missing -> `failed` with "Could not read this statement: no <fields> found." (code
`CORE_HEADER_MISSING`). A negative amount submitted fails next (D25, `AMOUNT_NEGATIVE`).

The 12 samples pass 8 of 8 (verified against the fixtures). A CSV counts 3 checks without a fee column and 5 with one.

---

## 5. Analysis engine (`cardStatementAnalysis.analyse`)

```js
const { analysis, header } = analyse(extracted, { history = [], rules = require('./cardStatementRules') } = {});
```

Pure: no I/O, no clock, no randomness. `history` = earlier `analysed` statements of the same client and merchant
number: `[{ periodStart, periodEnd, amountSubmitted }]` (entries whose `periodEnd >= extracted.period.end` are
ignored). `analysis` is public-safe (returned by the API as is); `header` holds the DB column values
(`processor, merchantNumber, merchantName, periodStart, periodEnd, layoutVersion, amountSubmitted, totalFees,
amountProcessed, transactionCount, effectiveRate, debitShare, findingsCount, rebelipayCost (raw), rebelipaySavings
(raw), rebelipaySavingsAnnual (raw), rebelipayEligible, analysisVersion`). The service writes a value too large for
its numeric column (an effective rate near 3,000% on a $1 month) as null; the jsonb keeps the real figure.

Percent values are percent numbers (3.0154 means 3.0154%) at full precision; the UI rounds. Money values are numbers
with 2 decimals, summed in integer cents. Missing sections are `null`, never zeros (D24), and are listed in `missing`.

```jsonc
{
  "version": 1,
  "layoutVersion": "v2_2026", "processor": "Better Payments",
  "merchant": { "number": "498387143882", "name": "WINE REPUBLIC" },
  "period": { "start": "2026-07-01", "end": "2026-07-31", "label": "Jul 2026" },
  "kpis": {
    "cardVolume": 194523.58,             // summary.amount_submitted
    "transactions": 6921,                // Σ card_types.items; null when a card type with money has no count, or there are no card types
    "processingFees": 5865.65, "effectiveRate": 3.0154,
    "debitVolume": 144094.24,            // see below
    "debitShare": 74.0755, "debitFeesPaid": 4322.86,
    "netDeposited": 188657.93,
    "avgTicket": 28.11, "avgTicketSource": "printed",   // or "computed" = submitted / transactions, or null
    "lastMonth": { "month": "2026-06", "cardVolumePct": 10.32, "cardVolumeSource": "printed", "processingFeesPct": 10.26, "netDepositedPct": 10.32,
                   "avgTicketPct": 3.03, "effectiveRate": 3.0148, "debitShare": 55.0553 },   // D47; null for a CSV or with nothing on file
    "rebelipayEligible": true, "rebelipaySavings": 213.20, "rebelipaySavingsAnnual": 2558.40   // null when not eligible
  },
  "rebelipay": { /* §6 public shape */ },
  "findings": [ /* six, fixed order 01..06, §5.1 */ ],
  "feeLines": [ { "index": 0, "category": "account", "product": "Miscellaneous", "network": null,
                  "description": "NON RECEIPT OF PCI VALIDATION 1 TRANSACTIONS AT 29.95", "isDebit": false,
                  "rate": null, "ratePct": null, "baseAmount": null, "count": 1, "unitPrice": 29.95,
                  "feeType": "Fees", "amount": 29.95, "tag": "penalty", "fix": "File PCI SAQ (free, ~20 min)" } ],
                                         // null when there are no fee lines (a CSV)
  "daily": { "rows": [ { "date": "2026-07-01", "dow": "Wed", "submitted": 4128.77, "disputes": 0, "adjustments": 0,
                         "fees": 123.86, "processed": 4004.91, "weekend": false, "priorPeriod": false, "anomalies": [] } ],
             "monthEndCharges": 29.95,
             "totals": { "submitted": 194523.58, "fees": 5865.65, "processed": 188657.93 } },
             // rows[].disputes / adjustments null on a CSV; totals.fees null when no row has fees and there is no
             // month-end charge; totals.processed null when no row has it; weekend = Fri to Sun;
             // rows[].anomalies = the anomaly types dated that day
  "cardMix": { "rows": [ { "type": "VISA", "label": "VISA", "avgTicket": 27.82, "items": 5248, "gross": 146012.07,
                           "refundItems": 0, "refunds": 0, "netItems": 5248, "net": 146012.07, "sharePct": 75.06 } ],
               "totals": { "items": 6921, "gross": 194523.58, "refundItems": 0, "refunds": 0, "netItems": 6921, "net": 194523.58 } },
  "customers": { "new": 2650, "repeat": 1225, "repeatSharePct": 31.6129, "avgTicket": 28.11 },        // null on legacy and CSV
  "salesTrend": { "source": "statement", "points": [ { "month": "2025-07", "amount": 197745.60 } ],
                  "yoyPct": -1.63, "momPct": 4.11, "peak": { "month": "2025-12", "amount": 198849.38 },
                  "trough": { "month": "2026-02", "amount": 138340.43 } },     // null when < 2 points
  "notices": [ { "text": "...", "kind": "acquirer_change", "effectiveDate": "2026-06-29", "action": "Confirm with your bank; ..." } ],
  "reportableSales": { "tinLast4": "0000", "monthLabel": "June", "monthAmount": 186843.89, "ytdAmount": 1001562.40, "ytdYear": 2026 },
  "disputes": { "count": 0, "amount": 0, "items": [] },  // items [{ date, amount, reason }]; amount = Σ chargebacks, else summary.disputes;
                                                         // null on a CSV with no chargebacks (not shown is not "none")
  "funding": { "rows": 49, "splitDays": 17 },            // null when no Amounts Funded section; only rows with sales count towards split days (D20)
  "missing": [],                                         // keys of feeLines, daily, cardMix, customers, salesTrend, reportableSales,
                                                         // disputes, funding that are null, e.g. ["customers", "funding"] on legacy
  "findingsCount": 3                                     // findings with flagged === true
}
```

**Debit volume** (D24): Σ `base_amount` of the rated debit fee lines when there are any. Otherwise the DEBIT
card-type net, but only when a DEBIT card-type row exists and no fee line is a debit line (a DEBIT row covers PIN
debit only, and would understate debit next to debit fee lines it could not rate). Otherwise null, and so is
`debitShare`. `debitFeesPaid` = Σ fees on debit lines when there are fee lines. A CSV with a fee column takes the
debit and credit rates from its transactions (debit = card type DEBIT).

### 5.1 Findings (fixed order; `number` is the label "Finding 01" .. "Finding 06")

Each: `{ key, number, title, severity: 'high'|'medium'|'low'|'info', flagged, available, unavailableReason,
impactLabel, why, isEstimate, shows, hidden, metrics, chart, table, callout, footnote, sourceRefs }` (`why`: a
flagged check's reason for its level, D47; null otherwise). `shows` and
`hidden` are short template sentences built from statement facts (no model text, no benchmarks); a CSV is worded as
"the file" and "the period", never "the statement" or "the month". An unavailable finding has `available: false`, an
`unavailableReason`, its `metrics` with nulls, and no chart, table or callout.

Shapes emitted:

- `chart`: `{ type: 'debitCredit', bars: [{ key: 'debit'|'credit', label, volume, fees, ratePct }] }` (01);
  `{ type: 'trend', points: [{ month, amount }], peak, trough }` (02); `{ type: 'cardMix', rows: [{ type, label, net,
  sharePct }] }` (03, null with no card types); `{ type: 'daily', rows: [{ date, dow, amount, friToSun, priorPeriod,
  anomaly }] }` (04); null otherwise.
- `table`: `{ type: 'math', cells: [{ label, value, format: 'money'|'pct' }] }` (01);
  `{ type: 'grid', columns: [{ key, label, format: 'text'|'tag'|'money'|'date' }], rows: [...] }` (05 junk items, 06
  disputes); null otherwise.
- `callout`: `{ title, text }`: "Bigger spenders" (03, "Amex customers spend more per sale than your Visa customers.": the
  tiles carry the two averages and the gap), "What this can mean" (04, after a low sales day); null otherwise. Split deposits are an anomaly row, so no callout
  repeats them.
- `sourceRefs`: paths into `extracted`: `fee_lines[i]` (01 rated debit and credit lines, 05 items), `sales_trend` or
  `summary.amount_submitted` (02), `customers` and `card_types[i]` (03), `daily[i]` for flagged anomaly days and the
  biggest day (04), `notices[i]`, `reportable_sales`, `chargebacks[i]` (06).

| # | key | metrics | flagged when |
|---|---|---|---|
| 01 | `debit_at_credit_rates` | `debitVolume, debitShare, debitFeesPaid, debitRatePct, creditVolume, creditFeesPaid, creditRatePct, sameRate` (rates = fees / base of rated lines; `sameRate` within 0.05 points). Table = math row: Debit volume / Rate charged / You paid on debit / Share of volume. Unavailable when no debit rate can be computed: "No debit card sales on this statement", "This statement does not show the rate charged on debit cards", or on a CSV "No debit card sales in this file", "This file does not show which cards were debit", "This file does not show the rate charged on debit cards". Title "Debit is {share}% of your card sales" ("What debit cards cost you" when the share is unknown); impact "$X in debit card sales". Severity `info`, `why` null (D48). | never (D48) |
| 02 | `sales_trend` | `source ('statement'|'history'), points, yoyPct, momPct, peak, trough, peakToTroughPct`. Printed YoY/MoM win over computed. Legacy: series from `history` + this statement; fewer than 2 points -> `available:false`, "A trend needs at least two months of card sales" (legacy adds a footnote to upload earlier statements or files). | yoyPct < 0 |
| 03 | `customer_scorecard` | `newCustomers, repeatCustomers, repeatSharePct, avgTicket, avgTicketSource, amexAvgTicket, visaAvgTicket, amexPremiumPct, effectiveRate, cardMix[{type,label,net,sharePct}]`. Legacy and CSV: customer metrics null, card mix and Amex premium kept. Callout "Bigger spenders" when premium >= 20%. Unavailable with neither customers nor card types. | never (severity info) |
| 04 | `daily_patterns` | `friSunSharePct, biggestDay{date,amount,sharePct,usualAmount,timesUsual (D47)}, daysFor60Pct, daysFor60SharePct (what those busiest days really brought in, 60% or a little more; the title states it, never a flat "60%"), daysInPeriod, anomalies[...], splitFundingDays` (null when the statement has no Amounts Funded section, D24). In-period rows only for shares. Anomalies, each `{ type, date, amount, detail, note }` (`detail` a sentence on its own; `note` the rest of it after the date and amount, for a list that shows those: "in fees on a day with no card sales."): (a) `low_batch` (+ `nextDate, nextAmount`): day < `rules.lowBatchRatio` x median of the same weekday's other in-period days AND next day > `rules.spikeRatio` (1.5) x median of its weekday; (b) `zero_with_fees`: $0 submitted, fees > 0; (c) `prior_period`: rows dated before the period; (d) `split_funding` (`date: null`, `amount` = the late part, + `dates`): one entry summarising dates whose sales were funded on two dates (D20). A day whose sales were not read is never a low or $0 day, and is left out of the weekday medians. When flagged, the impact counts every listed anomaly, split deposits too ("4 items to check"). Unavailable with no in-period daily rows. Severity medium for (a) or (b), low for (c) or (d) alone. "of the month" becomes "of the period" for a CSV or a span under 28 days. | any listed anomaly, (d) too (D46) |
| 05 | `junk_fees` | `items[{line, tag, monthly, annualised, period, fix, sourceRef}], totalAnnualised`. Match `rules.feeCatalogue` against fee descriptions (first match wins); annualise x12 (annual items as-is); unmatched account fees -> tag `review`. `isEstimate` only when there are items (annualised assumes each fee repeats; a card with no junk fees, or none to read, has no estimate to mark). Unavailable with no fee table: "Junk fees not checked", "This statement does not list fees by name" (a CSV: "This file..."). | any tagged fee: medium for a penalty or negotiable item, low for review or watch only (D46) |
| 06 | `fine_print` | `notices[{text,kind,effectiveDate,action}]` (action from `rules.noticeActions`), `reportableSales`, `disputes{count,amount,items}`, `zeroDisputes` (null when disputes are not shown, including a statement whose disputes line was not read and that has no chargeback rows: unknown, never "no disputes"). Unavailable on a file with no notices, no 1099-K block and no dispute details: "This file has no notices or dispute details". Severity high for acquirer or ACH changes. | any notice of kind acquirer_change, ach_descriptor_change (high), fee_change or any dispute (medium), or delivery_change (low, D46) |

### 5.2 `cardStatementRules.js` (v1)

```js
module.exports = {
  version: 1,
  lowBatchRatio: 0.10,
  spikeRatio: 1.5,
  rebelipay: {
    name: 'Rebelipay',
    pctRate: 0.0255,          // used ONLY together with perTxnFee as one per-transaction price
    perTxnFee: 0.10,
    appliesTo: 'all_card_types',
    monthlyFees: 0,           // Rebelipay account/PCI/statement fees per month (none today; configurable)
    refundsReturnFee: true,   // D5
    roundPerTransaction: true,
  },
  feeCatalogue: [             // first match wins
    { match: /NON RECEIPT OF PCI VALIDATION/i, tag: 'penalty',    period: 'monthly', fix: 'File PCI SAQ (free, ~20 min)' },
    { match: /ANNUAL COMPLIANCE/i,             tag: 'negotiable', period: 'annual',  fix: 'Request waiver / reprice' },
    { match: /MAESTRO REG(ISTRATION)?\b/i,    tag: 'watch',      period: 'monthly', fix: 'Monitor' },   // printed as "MAESTRO REG"
    { match: /PAPER STATEMENT|STATEMENT FEE/i, tag: 'negotiable', period: 'monthly', fix: 'Switch to e-statements' },
    { match: /MAILED (DISPUTE|CHARGEBACK) NOTIF/i, tag: 'negotiable', period: 'monthly', fix: 'Disable mailed notifications in CCC' },
  ],
  noticeActions: {
    acquirer_change:       'Confirm with your bank; update any deposit-matching rules.',
    ach_descriptor_change: 'Tell your bank and bookkeeper the new ACH descriptor so deposits are not held or mis-categorised.',
    delivery_change:       'Make sure someone has access to the new statement portal.',
    fee_change:            'Review the new fee before it takes effect.',
    other:                 'Read it once; no action is usually needed.',
  },
};
```

---

## 6. Rebelipay pricing (`cardStatementPricing.js`)

All arithmetic is integer (BigInt). Money in cents; the percentage as parts per million (`Math.round(pctRate * 1e6)`),
the per-transaction fee in cents. Exact charges are kept in units of 1e-6 cent and rounded half up only where stated.

- **PDF** (`pricingBasis: 'per_card_type_from_pdf'`): for each card type, exact = `gross_cents x ppm + items x fee_cents x 1e6`;
  refunds credited (D5): minus `refunds_cents x ppm + refund_items x fee_cents x 1e6`. Statement total = round_half_up(Σ exact)
  + `monthlyFees`. Per-card-type `rebelipayCost` = largest-remainder allocation of the total so the rows add up.
- **CSV** (`pricingBasis: 'per_transaction_from_csv'`): each sale row = round_half_up(exact); each refund row's
  charge is credited the same way when `refundsReturnFee`; sum, plus `monthlyFees`. Refund rows add no transactions
  and no volume. With `roundPerTransaction: false` a CSV is priced like a PDF.
- `currentCost` = `summary.fees` (everything the processor charged, penalties included).
- `savings = currentCost - penalties - rebelipayCost` (D49: penalties are the fee lines `tagFeeLine` tags `penalty`;
  the store stops them itself, with any processor); `currentRate = currentCost / amount_submitted x 100`,
  `rebelipayRate = rebelipayCost / amount_submitted x 100`, `savingsPct = savings / currentCost x 100`,
  `savingsAnnual = (savings - yearly fees) x 12 + yearly fees` (a fee line whose period is annual counts once).
- `penaltyFix` = the penalties (null when none), `penaltyFixAnnual` (a monthly one x 12, a yearly one once),
  `penaltyFixLabel` ("Fix the PCI penalty (free, about 20 minutes)" when every penalty line is the PCI one, else
  "Stop the penalty fees"); `totalFound = savings + penaltyFix`, `totalFoundAnnual = savingsAnnual + penaltyFixAnnual`.
- **Reason**, first that applies; `eligible = reason === null`:
  1. `no_volume`: nothing priced (no card types, or a CSV with no sales rows), priced volume <= 0, a negative
     charge, or amount submitted <= 0 (D23, D25).
  2. `incomplete`: a card type with money on it has no gross or no count, or has refunds but no refund count while
     refunds are credited (D23; the reconcile check `card_type_rows` fails on the same rows).
  3. `no_current_fees`: `summary.fees` is null (a CSV without a fee column, or with one left blank).
  4. `costs_more`: savings <= 0 or savingsAnnual <= 0 (a saving of exactly $0.00 is not eligible either).
- `byCardType` (eligible only): per card type `{ type, label, transactions (items), volume (gross), currentCost,
  rebelipayCost, savings }` where `currentCost` = Σ fee lines whose `network` is that type (a CSV: Σ the fee column);
  plus a final row `{ type: 'ACCOUNT_OTHER', label: 'Account & other fees', transactions: null, volume: null,
  currentCost: <residual so rows sum to currentCost>, rebelipayCost: monthlyFees, savings: residual - penalties - monthlyFees }`,
  so the `savings` column adds up to `savings` (D49). A single card type's
  `savings` can be negative on an eligible statement (Millstone Jul DEBIT: -$0.16); the screen never styles it as a
  saving.
- `savingsToDate(rows)` over every `analysed` statement of the same client and merchant (raw savings, negatives
  included, so the total is honest; statements with no saving figure skipped): `{ amount, statements, from: 'YYYY-MM',
  to: 'YYYY-MM' }`; the API returns it, and the UI shows it, only when `amount > 0` and `statements >= 2` (D21).

**Public shape** (`analysis.rebelipay`):

```jsonc
{
  "eligible": true, "reason": null,             // reason when not eligible: "no_volume" | "incomplete" | "no_current_fees" | "costs_more"
  "currentProcessor": "Better Payments",
  "transactions": 6921, "volume": 194523.58,
  "currentCost": 5865.65, "rebelipayCost": 5652.45,
  "savings": 183.25, "savingsPct": 3.1241, "savingsAnnual": 2199.00,   // switching only (D49)
  "penaltyFix": 29.95, "penaltyFixAnnual": 359.40,                       // null without a penalty
  "penaltyFixLabel": "Fix the PCI penalty (free, about 20 minutes)",
  "totalFound": 213.20, "totalFoundAnnual": 2558.40,                     // = savings* without a penalty
  "currentRate": 3.0154, "rebelipayRate": 2.9058,
  "byCardType": [ { "type": "VISA", "label": "VISA", "transactions": 5248, "volume": 146012.07,
                    "currentCost": 4380.39, "rebelipayCost": 4248.11, "savings": 132.28 } ],
  "pricingBasis": "per_card_type_from_pdf",
  "refundsCredited": true
}
```

| reason | kept | null / removed |
|---|---|---|
| `costs_more` | `eligible, reason, currentProcessor, transactions, volume, currentRate, pricingBasis, refundsCredited` | `currentCost`, `rebelipayCost`, `savings`, `savingsPct`, `savingsAnnual`, `rebelipayRate`, `byCardType`, `totalFound`, `totalFoundAnnual` are **omitted** (no negative saving can be shown or derived) |
| `no_current_fees` | `rebelipayCost`, `rebelipayRate`, `transactions`, `volume` | `currentCost`, `currentRate`, `savings*` null; `byCardType` `[]` |
| `no_volume` | `currentCost`, `currentRate` (and `transactions`, `volume` when something was priced) | `rebelipayCost`, `rebelipayRate`, `savings*` null; `byCardType` `[]` |
| `incomplete` | `currentCost`, `currentRate` | `transactions`, `volume`, `rebelipayCost`, `rebelipayRate`, `savings*` null; `byCardType` `[]` |

The raw figures for the DB columns (`header.rebelipayCost`, `rebelipaySavings`, `rebelipaySavingsAnnual`) are
unredacted: the saving may be negative (`costs_more`), and all three are null for `no_volume` and `incomplete`.

**Never** add a field (anywhere in the engine output, API, CSV or UI) that holds the percentage part, the
per-transaction part, `items x fee`, `gross x pct`, the refund credit on its own, or the offer's rate/fee values.
`cardStatementRules` is never serialised. Tests enforce this (§9). Any two totals still let someone solve for the
price (§10.4); the rule is about never displaying the components.

Worked numbers (PDF basis), from the plan. With `refundsReturnFee: false` all reproduce the plan exactly; the
default (refunds credited) changes only the stores with refunds:

| Store | Month | Txns | Card volume (gross) | Paid today | With Rebelipay (refunds off) | You save (refunds off) | With Rebelipay (default) | You save (default) |
|---|---|---|---|---|---|---|---|---|
| Wine Republic | May | 7,200 | 187,377.59 | 5,651.28 | 5,498.13 | 153.15 | 5,498.13 | 153.15 |
| Wine Republic | Jun | 6,965 | 186,843.89 | 5,635.25 | 5,461.02 | 174.23 | 5,461.02 | 174.23 |
| Wine Republic | Jul | 6,921 | 194,523.58 | 5,865.65 | 5,652.45 | 213.20 | 5,652.45 | 213.20 |
| Spotswood | Jul | 5,693 | 189,030.63 | 5,670.96 | 5,389.58 | 281.38 | 5,383.99 | 286.97 |
| Bethany | Jul | 5,970 | 227,057.21 | 6,841.94 | 6,386.96 | 454.98 | 6,386.96 | 454.98 |
| Millstone | Jul | 4,420 | 161,077.37 | 4,991.37 | 4,549.47 | 441.90 | 4,547.51 | 443.86 |

"You save" in this table is the plan's whole gap, now `totalFound` (D49). Wine Republic (every month) and Bethany
(every month) carry a $29.95 PCI penalty, so their switching `savings` is the gap less $29.95 (WR Jul $183.25, Bethany
Jul $425.03), and Millstone Jul's year counts its $159 annual fee once ($3,577.32).

All 12 samples: $65,883.27 paid. Refunds off: $62,287.65 with Rebelipay, $3,595.62 found, $3,415.92 of it by
switching and $179.70 in PCI penalties. WR Jul `savingsToDate` with May and Jun: $450.73 across 3 statements (the
switching saving; Wine Republic has no refunds, so both settings agree).

---

## 7. API: `/api/card-statements` (`verifyToken`, no `attachPool`)

Mounted in `server.js` after purchase-orders as one literal line (the route guard parses it). Analytics pool only.
Tenant = `req.user.client_id` from the JWT, never from the body or query (D1). Errors are
`{ error: { code, message } }` with owner-safe messages; never 401 for a document problem (401 comes only from
`verifyToken`). Every async handler catches; `42P01` -> `503 MIGRATION_MISSING` ("The card statement tables are
missing from the analytics database on this machine. Run: npm run migrate --prefix backend"). Ids are `/:id(\\d+)`;
any id not in the caller's client -> `404 NOT_FOUND` ("That statement was not found."), exactly like one that does
not exist.

| Method | Path | Behaviour |
|---|---|---|
| POST | `/upload` | multipart field `file`; multer memory storage, 20 MB, 1 file, `defParamCharset: 'utf8'` (D18), invoked inside the handler. Accepts PDF (`%PDF-` magic bytes in the first 1 KB) and CSV (`.csv` name or a text-ish mimetype, text content with a delimiter on one of the first lines; browsers may send `text/csv`, `application/vnd.ms-excel`, `text/plain` or empty). sha256; same hash in a row of this client (a tombstone resolves to its original, D8) -> `200 { duplicate: true, id, reason: 'same_file', message }` and a `duplicate` event on that row, no new row. Else store file, insert `analysing`, log `uploaded`, re-check for a concurrent upload of the same file (the later row retires itself and answers the same 200), reply `202 { id, status: 'analysing' }`, then `analyseInBackground(id)`. A failed duplicate check never stops an upload. |
| (internal) | `analyseInBackground` | extract (PDF or CSV) -> core header check -> negative amount check -> reconcile -> load history -> `analyse()` -> save header columns + jsonb as `analysed`, guarded by the expected status (a row swept, deleted or re-run meanwhile keeps whatever happened first and this result is dropped). A unique-index violation means an identity duplicate: mark `duplicate`, set `duplicate_of`, delete its file, log `duplicate` on both. Never throws; on error `failed` + owner-safe `parse_error` + `analysis_failed` event, keeping any extraction so the analysis can re-run without another read (`/reanalyse`). Raw errors to logs only; never log `extracted` at info. |
| GET | `/` | `limit` (default 25, max 200), `offset`, `q`, `status` (`analysed`/`analysing`/`failed`), `store` (merchant #), `sort` (see below). Never returns `duplicate` rows. -> `{ data: [item], total, stores: [{ merchantNumber, merchantName, count }] }` (`stores` is unfiltered, named after each merchant's latest statement). Sweeps this client's stale `analysing` rows first (D13). |
| GET | `/:id` | `{ ...item, parseModel, parseMs, analysisVersion, reconciliation, analysis, savingsToDate, rebelipayCtaUrl }`. `analysis` re-run at read time (D10; the stored one is served if the re-run throws); `null` unless `analysed`. When the re-run moves the list figures, they are re-filed on the row and the item fields carry the fresh ones (D44). `savingsToDate` is `null` unless its amount is positive and it covers at least 2 statements (D21). A `duplicate` row answers 200 with `status: 'duplicate'` and `duplicateOf`. Sweeps stale rows first. |
| GET | `/:id/log` | `{ data: [{ id, event, actor, payload, createdAt }] }`, oldest first (at most 500). |
| POST | `/:id/reanalyse` | body `{ reextract?: boolean }`. `409 BUSY` while analysing. `409 DUPLICATE` on a tombstone ("This upload is a copy of a statement already on your list. Open that one instead."). Default: re-run reconcile + analyse on stored `extracted` synchronously, log `reanalysed`, return the fresh detail; an owner-facing outcome (core header, negative amount, identity duplicate) becomes the row's state, while an unexpected engine error leaves the row as it was and answers `500 REANALYSE_FAILED`. `reextract: true`, or no stored `extracted`: `409 FILE_MISSING` when the original is gone, else set `analysing`, log `reanalysed`, reply `202 { id, status: 'analysing' }`, re-read the stored file in the background. |
| GET | `/:id/file` | original bytes; `Content-Type` from the validated type; `inline` unless `?download=1`; RFC 5987 `filename*=` with an ASCII fallback; `X-Content-Type-Options: nosniff`. `404 FILE_MISSING` when the stored file is gone (tombstones have none). |
| GET | `/:id/csv` | `409 NOT_ANALYSED` unless analysed. `text/csv; charset=utf-8` with BOM; sections Summary, Rebelipay comparison (totals and all-in rates only, eligible statements only; D49: You save by switching, its percent and its year, the penalty fix and its year under its own label when there is one, and Total savings Botella found and its year), Card types, Fee lines, Daily. Money keeps two decimals; text a spreadsheet would run as a formula is prefixed with `'`. File name `card-statement-<merchant>-<YYYY-MM>.csv`. |
| DELETE | `/:id` | deletes the row (events and duplicate tombstones cascade) and every file they held. `200 { ok: true }`. |
| POST | `/:id/rebelipay-interest` | analysed + eligible only (else `409 NOT_ELIGIBLE`, "Rebelipay savings are not available for this statement."). Logs `rebelipay_interest` with the §2.2 payload; POSTs `{ event: 'rebelipay_interest', statementId, ...payload }` to `REBELIPAY_LEAD_WEBHOOK` when it is an http(s) URL (5 s timeout, failure logged without the payload, never fails the request). `200 { ok: true, ctaUrl }`. |

**Search (`q`)**, `cardStatementSearch.searchClause`: the query is split into words (at most 8, 200 characters) and
**every** word must match. A word matches when the store name, merchant number or file name contains it (LIKE
wildcards escaped), or, when it reads as a period, when the statement's period covers it: a month name (`june`,
`Jul`), a year (`2026`), a month and year (`jun 2026`, `06/2026`, `2026-06`, `jun26`) or a day (`06/30/2026`,
`2026-06-30`, `June 30 2026`; US order first, a first number over 12 is a day). Multi-word dates are read as one
period. Rows with no period yet match on text only.

**Sort** (whitelisted; anything else is the default): `store` (default: unnamed rows first so a fresh upload is on
page 1, then store A to Z, newest period first within a store), `store_desc`, `period` (`period_end DESC NULLS
FIRST`, then store), `period_asc`, `savings` / `savings_asc` (only savings the API would show; the rest sort last),
`created`.

**Error codes:**

| Status | Code | Where |
|---|---|---|
| 400 | `NO_FILE` | upload: no file, more than one file ("Upload one statement at a time."), or a multipart body that did not arrive complete |
| 400 | `UNSUPPORTED_TYPE` | upload: neither a PDF nor a CSV by content |
| 400 | `EMPTY_FILE` | upload: zero bytes |
| 413 | `FILE_TOO_LARGE` | upload: over 20 MB |
| 404 | `NOT_FOUND` | any `/:id` route: not this client's, or does not exist |
| 404 | `FILE_MISSING` | `/file`: the original is no longer on the server |
| 409 | `BUSY` | reanalyse while analysing (or a second re-read racing the first) |
| 409 | `DUPLICATE` | reanalyse on a tombstone |
| 409 | `FILE_MISSING` | reanalyse with `reextract` (or nothing stored) when the original is gone |
| 409 | `NOT_ANALYSED` | `/csv` on a statement that is not analysed |
| 409 | `NOT_ELIGIBLE` | rebelipay-interest on a statement that is not analysed and eligible |
| 503 | `MIGRATION_MISSING` | any route, when the tables are missing (42P01) |
| 500 | `UPLOAD_FAILED`, `LIST_FAILED`, `DETAIL_FAILED`, `LOG_FAILED`, `REANALYSE_FAILED`, `FILE_FAILED`, `CSV_FAILED`, `DELETE_FAILED`, `INTEREST_FAILED` | anything else, logged in full, answered with a generic owner message |

**Row failures** (`status: 'failed'`, `parse_error` shown as is): the §3.1 and §3.3 extraction messages;
`CORE_HEADER_MISSING` ("Could not read this statement: no merchant number, statement period or amount submitted
found.", naming only what is missing); `AMOUNT_NEGATIVE` (D25); `FILE_MISSING` on a background re-read ("The original
file is no longer on the server, so it cannot be read again. Upload it again."); the stale sweep's "Interrupted by a
server restart. Reanalyse it to read it again."; anything else "This statement could not be read. Reanalyse it, or upload
it again."

**List item** (camelCase, ids as strings): `id, status, fileName, fileMime, fileSize, uploadedBy, createdAt,
updatedAt, processor, merchantNumber, merchantName, periodStart, periodEnd, layoutVersion, amountSubmitted,
totalFees, amountProcessed, transactionCount, effectiveRate, debitShare, findingsCount, rebelipayEligible,
rebelipaySavings, rebelipaySavingsAnnual (both null unless analysed, eligible and positive), parseError,
parseConfidence, reconciliationOk, duplicateOf`. Dates as `YYYY-MM-DD` strings (do not rely on the global pg type
parser), numerics as numbers or null. `parseModel` appears in the detail only, mirroring Quick-PO; the screen never
shows it.

Config (`backend/.env.example`, all optional): `CS_PARSE_MODEL`, `CS_PARSE_MAX_TOKENS=32000`,
`CS_PARSE_TIMEOUT_MS=240000`, `CS_UPLOAD_DIR` (default `data/card-statements`, resolved against `backend/`, never under
`data/imagegen`), `CS_STALE_MINUTES=10` (floored, D13), `REBELIPAY_CTA_URL` (default `https://rebelipay.com`; http(s)
only, anything else is treated as unset), `REBELIPAY_LEAD_WEBHOOK`. `backend/data/card-statements/` is in
`.gitignore` and `backend/.dockerignore`. Files are stored at
`<CS_UPLOAD_DIR>/<clientId>/<timestamp>-<randomHex>.<pdf|csv>` (extension from the validated type, never the client's
file name), read back through a traversal guard that compares against the root plus `path.sep`.

---

## 8. Screens

### 8.1 Registration
- `utils/features.js`: `SHOW_CARD_STATEMENTS` and its slug in `HIDDEN_VIEWS`. On for QA and staging builds
  (`REACT_APP_ENV=qa|staging`) and local dev, off for a production build until rollout.
  `REACT_APP_SHOW_CARD_STATEMENTS=true` (or `1`) forces it on, `false` (or `0`) forces it off, anything else follows the
  build; documented in `frontend/.env.example`. It hides the screen only; the API answers any signed-in session.
- `components/Sidebar.js`: `{ key: 'card-statements', label: 'Card Statement Analysis', icon: CreditCard, show: SHOW_CARD_STATEMENTS }`,
  directly above Purchase Orders (Purchase Orders stays directly above Ask Botella).
- `App.js` `APP_VIEW_PATHS`: `'/card-statements'`. `pages/ChatPage.js`: import, `VALID_VIEWS`, `VIEW_TO_NAV`, the
  `goNav` case, and `{activeView === 'card-statements' && <CardStatementsScreen authToken={authToken} apiUrl={ENV_API_ORIGIN} onNavigate={goNav} />}`.
- `botella-renav`: clicking the sidebar item again closes an open detail.

### 8.2 List (`CardStatementsScreen`, prefix `cs-`)
Title "Card Statement Analysis", subtitle "Upload credit/debit card statements to see what you paid, where money
leaks, and what you would have SAVED." ("saved" in bold capitals, by CSS, in the green the savings column uses),
Refresh, **Upload statement**
(primary). Search (300 ms debounce; store, merchant #,
file name or period, §7), status filter (All / Analysed / Analysing / Could not read), store filter (from `stores`),
paging 10/25/50/100 with `{data,total}`. The toolbar is one row: the search, then Status and Store right beside it,
then the "1-10 of 12" count, Rows and the pager at the far end. The search takes up to half the toolbar and gives way
first when space is short, down to 120 px (a long store name picked in Store narrows the search, it does not wrap the
row); only below that do the controls drop under it. With the sidebar open, one row holds from about 1215 px wide
(a container query on the toolbar), from about 1235 px with the longest store (BETHANY WINES & LIQUORS) picked, and
from about 1310 px with that store and "Could not read" both picked; narrower, the search takes its own row with
Status and Store, then the pager, underneath; on a phone the controls wrap again, and Status is only as wide as "All"
so Store gets the rest of its row. Every label ("Status:", "Store:", "Rows:") and the count share one
text style, every value (the three dropdowns and the page number) another, and each dropdown is as wide as what it
shows (`field-sizing: content`, capped at 220 px, which still fits a whole store name). The Store dropdown (shown only when a
client has more than one store) names each store by name alone ("BETHANY WINES & LIQUORS"); only stores that share a name (case and
any run of spaces aside) add " · <merchant #>", and a store with no name yet shows its merchant #. The closed
dropdown's tooltip carries the picked label whole, since a long one is cut at the cap. Default order: newest period
first (`sort=period`, §7; the API's own default is still `store`). Polls `GET /` every 3 s only while a row is `analysing` or a watched
statement is unaccounted for, and not while a detail is open. Every list request takes a sequence number and an
answer older than the latest request is dropped, so rows, total, stores and the spinner always belong to the current
search, filter and page.

Paging, sorting and searching never move the page: the rows on screen stay (dimmed after 150 ms) until the next ones
arrive, and only the very first load shows a "Loading" row; Refresh and Upload sit on a row of their own under the
subtitle, at the left, so their place never depends on the page width; the page's scrollbar gutter is reserved (`scrollbar-gutter: stable`), so
a long page 1 and a short page 2 are the same width; the pager's count and page number have fixed widths; Refresh is
never disabled. Measured in Edge at 1440 px and 390 px, light and dark, with classic scrollbars and a 600 ms API
delay: 0 px of movement in the header buttons, the pager and the table across a page change.

**Refresh** reloads the current view (search, filters, sort and page kept) with `cache: 'no-store'`. The list answers
in milliseconds, faster than a spinner or a dim can be seen, so a press is made visible: the icon turns, the rows dim
at once (they stay clickable: what is under the dim is already the fresh list), and then a green "✓ Updated just
now" chip shows for 2.6 s, announced through a `role="status"` region. The icon always stops on a whole turn counted
from when it started turning: a lone press gets one full turn (900 ms, or the next whole turn after a slower answer),
and a press into a turn already going (a double click) gets at least half a turn more, so it never stops part-way
round. The chip shows only if the press's answer is still the one on screen when the turn ends: a search, filter,
page, poll or error since then means no chip. A newer list request cancels the one in flight (`AbortController`), so
a slow, overtaken request cannot hold the press open. The chip is out of the flow, so nothing moves: it sits beside
the buttons, or under Refresh where there is no room beside them (measured, since the room depends on the sidebar
as well as the window: a phone, or about 769-782 px with the sidebar open), 22 px tall so it stays clear of the
search box and of a notice's text. A request that never reaches the server says "Could not reach the server. Check
your connection and try again." instead of the browser's "Failed to fetch". Under `prefers-reduced-motion` the icon
does not turn and nothing fades; a press holds the dim 450 ms, then the chip shows.

The "Loading your statements…" and "No statements match that search." rows span the whole 1262 px table, so on a
screen where the table scrolls sideways the note is held in the visible part of it, centred there, however far the
table is scrolled (a sticky inner block sized with container units).

Every heading is centred over its column and everything under it is centred too (numbers, badges, chips and
buttons). There is no Store column (D38): each store uploads its own statements, so every row named the same store. A sort
heading that wraps ("Save with / Rebelipay ⇅") keeps its arrow after the last word, centred with it. Other
`.ref-table` screens keep text left and numbers right.

| Column | Content |
|---|---|
| (View) | a "View" button, the only way into a statement (the row itself does nothing): a soft violet pill sized to its words, in a 112px column (squeezed into 92px, "View" ran into its own edge); disabled while analysing. Its accessible name and tooltip carry the store and period ("View BETHANY WINES & LIQUORS, Jul 2026"). The heading is empty on screen, "View" to a screen reader |
| Merchant ID ⓘ | `merchantNumber`; a statement not read yet (analysing, or could not be read) has none, so "File: {file name}" stands in, muted, whole in the tooltip |
| Period | `Jul 2026` from `periodEnd`; sortable newest / oldest first |
| Card sales ⓘ | `$194,524` |
| Fees paid ⓘ | `$5,866` |
| Effective rate ⓘ | `3.02%`: fees divided by card sales |
| Debit share ⓘ | `74%` |
| Save with Rebelipay ⓘ | the year first (D49): `$2,199/yr` in the positive colour, `$183.25 this statement` beneath (a CSV: `per 12 periods` / `this file`); `—` when not eligible; sortable (most saved, least saved, then back to the default) |
| Findings ⓘ | "3 of 6 flagged" badge, "None flagged" at none (D43) |
| Status | Analysing… (spinner) / Analysed / Could not read |
| Log ⓘ | opens the event log modal |
| Actions | Delete with `useDialog().confirm` |

Empty state: "Upload a card processing statement (PDF or CSV) to see what it isn't telling you." with an Upload
button.

**Notices** (dismissible, above the list):
- A statement the screen uploaded is **watched**. When it disappears from the list and `GET /:id` says `duplicate`:
  "<file> is the same statement as <store> · <period> and was not added again." with a View link to the original.
- When the upload dialog was closed while a batch was still going, each file that did not go in gets its own notice:
  "<file> is already on your list and was not added again." (View link to the original), "<file> could not be
  added. <reason>" (failure style), and "<n> more files were not sent. Only the first 20 files of a batch are taken;
  upload the rest now."
- Watched statements and undismissed notices are kept in `sessionStorage`, per client, so they survive changing
  views and reloading the tab (not a new tab or another device). A dismissed notice does not come back; storage that
  is missing or throws is ignored.

**Log modal**: one line per event with a curated set of details, never the raw payload: Uploaded (file type, size),
Analysed / Analysed again (time taken, totals that add up such as "8 of 8 add up", findings flagged "5 of 6"), Could not read (reason), Duplicate (why, file,
statement kept), Interrupted (minutes waited), Asked about Rebelipay (merchant, period, card volume, current fees,
current rate, you save, per year). Nothing shows the Rebelipay cost or rate, the savings percentage, or raw keys.

### 8.3 Upload dialog
Drag-and-drop or picker (`accept=".pdf,.csv,application/pdf,text/csv"`, multiple, up to 20 a batch, 20 MB each; files
past 20 are not sent and the dialog says so). A client-side check turns away other types, empty and oversized files
before sending (the server checks again by content). Files go one at a time to `POST /upload` (FormData field `file`,
no JSON content type). Per-file states: waiting / uploading / queued (202) / duplicate (200) / failed (message from
`errorText`). A batch that sends anything first resets the list to its default view (no search, no filters, default
sort, page 1) so the new "Analysing…" rows are visible. The dialog **closes only when every file was accepted**;
otherwise it stays open listing the failed, duplicate and over-limit files. It can be closed mid-batch ("You can close
this. Files already sent keep analysing and the rest keep uploading. We will tell you if any could not be added."):
the batch carries on, reopening shows it, and what did not go in becomes notices (§8.2). Tab is trapped inside the
dialog and focus returns to the button that opened it (the log modal does the same); Escape closes.

### 8.4 Detail (`CardStatementDetail`)
- Header: store, merchant #, period, processor, layout tag (Legacy / New / CSV). Actions: Original (`DocumentViewer`
  blob fetch with the auth header; CSV originals download), CSV, **Reanalyse**, Delete, Back, and a status chip
  beside the merchant # (Analysed / Analysing… / Could not read, as on the list). Reanalyse (D36) reads the original
  again, checks every total and rebuilds the analysis: the chip and the button say Analysing… and no figures show
  while it runs (the page polls every 3 s), then "✓ Reanalysed · 7 of 7 totals add up" shows under the button for 6 s.
  Every load takes a sequence number and a newer one cancels the one in flight, so a poll can never land an older
  answer last. The note is centred under the button and nudged back inside the page where that would spill over an
  edge (the button starts or ends a wrapped row of buttons on a phone).
- Banners: Could not read (`parseError`, pointing to Reanalyse), reconciliation warning (failed check labels,
  pointing to Reanalyse), duplicate ("Same statement as #id" + link). Delete asks first: "Delete this statement?",
  naming it, with Keep (focused) and Delete.
- **Rebelipay savings hero** (above the KPI band; on narrow screens it moves to the top of the Overview tab instead).
  Every mark in the app's primary (violet, `--ac`, via `--rp-accent`): eyebrow, Estimate tag, what Rebelipay would
  charge and the saving in the bars and the donut (the saving at full strength, the highlight), the "You save" pill,
  button and link. The saving's figures, and only those, are the app's positive green (`--gr`, via `--rp-save`), as
  savings figures are everywhere else in the app: the headline amount, the pill's text, the donut's readout (a green
  bar segment and slice were tried and put back to violet at the owner's request). Only the "Paid today" bar is a
  neutral grey, as the baseline. No rate chip (the all-in rates stay in the CSV). Copy (D49, the year first): with a penalty, "Botella found you
  about **$5,460** a year in savings" over three lines (Switch to Rebelipay / Fix the PCI penalty (free, about 20
  minutes) / Total savings Botella found, each with its year in bold green and "$X on this statement" beside it, a
  swatch on the first two and an ⓘ on each; pointing at a line lights its bar segment and donut readout); with none,
  "With Rebelipay, you could save about **$3,577** a year" over "$443.86 on this statement ⓘ". Before D49 the copy
  was "With Rebelipay, you'd have saved **$213.20** on this statement" (the amount green and 1.3em, a clear step up from the sentence, which wraps the
  headline in the 60% column at 1536px and below; counts up from $0, never below it; no animation under
  `prefers-reduced-motion`);
  sub-line "About $2,558 a year at this pace · you'd have saved $540.58 across 3 of your uploads for this store ⓘ" (a CSV:
  "over 12 periods like this one"; the second part only
  when `savingsToDate` qualifies); two broad pill bars (22px) on one scale: "Paid today" $5,865.65 (the processor is
  in the page header, and in the bars' screen-reader label; "Paid to Better Payments" read as a sentence), and "With
  Rebelipay" $5,652.45, the same length split into what Rebelipay would charge (the primary faded 45% into the card,
  with a swatch by its label) and the saving (the primary at full strength, the highlight); under it a pill, its text
  green, "You save $213.20 · 3.6% of your fees" with a piggy bank, its pointer under the middle of the saving. With a
  penalty (D49) the bar has a third segment after the saving, the fix, in the app's green (`--rp-fix`; a darker violet
  failed the validator's normal-vision floor against the saving, 11 < 15), and the pill reads "You save $454.98 in all ·
  6.6% of your fees"; the donut's two-slice form gets a fix slice, and "How we calculated this" and the card-type
  table each say why the penalty is on a line of its own. The pill speaks for the part pointed at ("Switching saves
  $425.03 · 6.2% of your fees", "The PCI fix saves $29.95 · 0.4% of your fees", the total on the pill itself or the Total
  line), its words cross-fading in a box as wide as the longest so it never changes size, and its pointer gliding to that
  part. Leaving one part clears the highlight only after 160 ms, so moving from a label to its bar or the bar to the
  pill goes straight to the next highlight instead of blinking back to normal on the way; the donut's middle fades its
  words in when they change. Beside them one donut
  ring, so there is one thing to read (D40): what was paid today, split by card type (`rebelipay.byCardType`, whose
  rows, "Account and other fees" included, add up to the paid-today total), biggest first and account fees last, in
  the Card types tab's network colours (account fees grey), as wide as its column up to 300px beside the bars (280px
  under them), the ring 21% of the radius. Its middle gives the three totals: "Paid today / $5,865.65 / With
  Rebelipay $5,652.45 / You save $213.20" (the saving's figure green). A key under it, "Paid today, by card type",
  names the card types (Visa, Mastercard, Amex, Discover, PIN debit, Other fees: the DEBIT card-type row is PIN debit
  only, so it is never called plain "Debit", which Finding 01 uses for all debit cards); no hint under it (one was
  tried and taken out at the owner's request). Pointing at a card type (its slice or its key) reads it out: "Visa / $5,006.71 /
  73% of your fees / With Rebelipay $4,700.62 / You save $306.09" (the saving line only when that card type has one:
  a card type can cost a few cents more on its own, never shown as a saving), fades the other card types and lights
  the "Paid today" bar. Pointing at "With Rebelipay" reads "$5,652.45 / With Rebelipay · $213.20 less than you paid"
  (the difference, not Rebelipay's share of today: "96.4%" told the reader nothing), and at the saving "$213.20 /
  You save · 3.6% of your fees". "Paid today" and "With Rebelipay" each have an ⓘ. A two-ring version (the saving
  ring inside a thin card-type ring) was tried first and replaced: two rings read as two charts. With fewer than two
  card types the ring is the second bar as a share instead (what Rebelipay would charge and what you save) and its
  middle asks for a hover. Hovering a bar, its words or the pill lights that part of the bars (its words on a soft
  highlight, its bar segment) and fades the rest; a hover never redraws the donut;
  "See by card type" expander (Card type / Number of sales / Sales before refunds / Paid today / With Rebelipay / You
  save, each heading with its ⓘ, card types by name, totals row;
  a card type's "You save" is in the primary colour only when it is above zero, otherwise it is muted, and the Total
  row is in it too); primary **Explore Rebelipay** (opens `rebelipayCtaUrl` in a new tab synchronously
  with `noopener`, then fire-and-forget `POST /rebelipay-interest`); "How we calculated this" disclosure: "We priced
  every card sale on this statement at Rebelipay's one price for all card types. Then we compared that with everything
  your processor charged you, including account fees and penalties. It assumes Rebelipay charges no account fees,
  penalties or other fees on top of that one price." (a CSV: "...in this file... with the fees listed in the file."),
  plus "Refunded sales get their Rebelipay fee back." when `refundsCredited`, and "This is an estimate based on this
  statement (file), not a guarantee." No price figures (D7). On a CSV the by-card-type table leaves out an empty
  "Account and other fees" row (a file cannot show account fees).
  Layout: the hero splits 60/40 with a 40px gap. Everything but the donut runs down the left 60%, top to bottom
  (eyebrow, headline, sub-line, the bars filling their width, the buttons, "How we calculated this"); the donut
  (rounded ends, no frame, up to 320px) sits in the right 40%, centred both ways in the hero's whole height, so the
  space beside the eyebrow and headline is its too. The headline wraps where the 60% is narrower than it (1440px and
  below). Where the hero is under 760px wide (a container query), the donut goes under the bars. "How we calculated
  this" is a toggle button (`aria-expanded`, the old disclosure triangle) that stays under the buttons; its text and
  the card-type table open in rows of their own, full width, under the donut. As a `<details>`, the text opened inside
  the rows the donut is centred in and the donut slid down; now nothing that opens lands there, so it never moves.
  Not eligible: `costs_more`, a quiet card "Your current fees already match or beat our Rebelipay estimate for this
  statement" (file), no button, no numbers. `no_current_fees`: a quiet card stating the estimated Rebelipay total, never
  its rate (on a large-ticket file the rate rounds to Rebelipay's price, D7), and that the file does not show what the
  processor charged. `no_volume`: "We found no card sales we could compare on this statement (in this file), so there is
  no Rebelipay estimate." `incomplete`: "We could not read every card type on this statement in full, so there is no
  Rebelipay estimate. Press Reanalyse at the top to try again." (KPI note "Some card types not fully read"). Only
  `costs_more` ever says your fees match or beat the estimate; an unknown reason gets a neutral "There is no Rebelipay
  comparison for this statement."
- KPI band (six tiles, each with an ⓘ saying what it is and how it helps, D39; under five of them, how the figure moved
  from last month when that statement is on file, D47): Card sales (+ "{n} sales"), Fees
  paid (+ "{pct} effective rate", D41), Debit share (+ "$X on debit cards", D48), Save with Rebelipay (the year
  first, D49: "$5,100/yr" + "$425.03 on this statement (est.)"; on a CSV "$X" + "over 12 periods like this one ·
  $Y in this file"; "—" when not eligible, with "Your fees are not in this file" for `no_current_fees` and
  "Some card types not fully read" for `incomplete`), Sent to your bank (a CSV: Left after fees), Average sale (+ "from
  your statement" or "card sales ÷ number of sales"). Any unknown figure shows "—". Six tiles a row from 1600 px, three below that (with the
  sidebar open a sixth of the band was too narrow: "$188,657.93" wrapped onto two lines at 1366-1440 px). A figure
  never wraps; where a tile is still narrower than its figure needs, the figure shrinks with the tile (`16cqi`, from
  about 1600 to 1640 px only for an eleven-character figure).
- Tabs: **Overview** (by priority, D43, D45 and D47: "5 of 6 checks flagged something" over the cards, the flagged
  checks first in full, labelled Urgent, Needs a look or Worth a look, each with its "Why it’s urgent: ..." line;
  the rest under "Lower priority", smaller and grey: "Nothing to fix" folded behind "Show details", "Not checked"
  with its reason in full; finding cards in number order within each group, figures rather than sentences,
  D37: a topic line, "FINDING 01 · DEBIT
  VS CREDIT FEES ⓘ" (the ⓘ says what the check looks at and why it matters; topics: Debit vs credit fees, Card sales
  over time, Customers and cards, Card sales by day, Junk fees, Fine print), the title, the impact as a figure at 24px
  in the severity colour (high red, medium `--am`, low violet; a lower-priority card's at 18px in the secondary text colour) with its words small after it
  ("$3,724.61 in debit card fees", "−4.97% vs a year ago"; a label with no figure, "Action needed", takes the colour
  itself), then tiles, a chart or table, and the callout. Each tile is as wide as its words, its text centred, with an
  ⓘ. Each figure once per card, so no tile repeats the header's: 01 Debit card fee rate (red when flagged) and Credit
  card fee rate side by side, Debit card sales, and Debit card fees or Sales paid by debit (whichever the header does
  not show), bars labelled with their sales and no legend; 02 the change the header does not show ("vs last month"
  when it shows "vs a year ago"), best and slowest month from three months up, the chart's dots "Best" and
  "Slowest", its months in full ("Jul 2026", since "Jul 26" read as a date); 03 New and Repeat customers, Average
  sale and "Amex vs Visa sale" (+ "Amex $50.32, Visa $37.51"; the repeat share is in the header, the all-in fee rate
  in the KPI band); 04 Sales Friday to Sunday and "60% of sales on" only when the header and title do not already say
  them, Biggest sales day (+ "of the month's card sales", "of the period's" on a CSV or a short span), every anomaly
  as chip (Low sales day, Fees, no sales, Earlier sales, Split deposit, each with its ⓘ), date, amount in red and the
  engine's `note`; 05 the fee table (Fee as printed, Flag, This month, A year (est.), What to do, the ⓘ on the
  first, second and fourth), "(once a year)" on an annual fee, one Total row for both columns from two fees up, and an
  ⓘ on the Estimate label; 06 the notices (kind chips with an ⓘ) with their actions, 1099-K sales so far (+ "Through
  June 2026, tax ID ending 0000") and Disputes and chargebacks. One quiet line only where the figures cannot say it: a
  trend built from uploads ("Built from 2 months of your uploads for this store, May 2026 to Jun 2026."), a layout
  with no customer counts. On a card narrower than 540px a fee or dispute table stacks each row into "label  value"
  lines (`data-label`, with explicit table roles), so nothing scrolls out of sight on a phone. An unavailable finding
  shows its reason and its footnote, e.g. an older layout's trend: "This kind of statement does not list your past
  months of sales. Upload earlier statements or files for this store to see a trend."). No importance rating: an
  "N/10" per finding was tried and taken out at the owner's request.
  **Fees** ("All your fees": Fee as printed, Fee type, Flag, Debit card, Fee rate, Charged on, You paid, What to do;
  ⓘ on each heading that needs one), **Day by day** (recharts bar chart, Friday to Sunday darker, unusual days in the
  alert colour, each month named under its days with a dashed line where a new month starts (D42), plus the table:
  Date, Day, Card sales, Disputes, Adjustments, Fees, Sent to your bank (a CSV: Left
  after fees), Notes, and a Month-end fees row; a CSV's disputes and adjustments show "—"), **Card types** ("Sales by
  card type": Card type, Average sale, Number of sales, Sales before refunds, Number of refunds, Refunds, Total count,
  Sales after refunds, Percent of card sales; money columns sized for a bold six-figure total, so no figure is cut at
  laptop widths and the table scrolls in its card instead), **Notices and disputes** (verbatim notices with "From
  {date}" and what to do, 1099-K sales, disputes; an amount taken back with no count says so, never "no disputes").
  Card types read Visa, Mastercard, Amex, Discover and PIN debit everywhere, never the statement's capitals. Any
  `null` section shows "Not on this statement".
- Glossary (D39), one term per concept: card sales (after refunds, before fees; never volume or submitted); sales
  before refunds and sales after refunds where both show; number of sales; fees you paid (the savings box keeps "Paid
  today"); "{pct} of your card sales" (never effective rate); fee rate (debit card fee rate, credit card fee rate);
  charged on (never base); sent to your bank (a CSV: left after fees; never net deposited or processed); average sale
  (never ticket); sales paid by debit; earlier sales (never prior period); low sales day; split deposit; flag and its
  chips Penalty, Could be cut, Keep watching, Ask about it; fee as printed; fee type (Card network, never
  interchange); what to do (never fix); processing bank (never acquirer); deposit name (never ACH descriptor); 1099-K
  sales; vs last month, vs a year ago (never MoM, YoY); estimate, (est.).
- Footer disclaimer: "Savings figures are estimates based on this statement (a CSV: this file) and are not guaranteed.
  They are not tax, legal, or accounting advice."
- The Rebelipay hero (and its not-eligible cards) is drawn from two app tokens: the `--rp-*` tokens in
  `CardStatementDetail.css`, scoped to `.csd-hero`, are made from `--ac` (dark `#B79CFF`, light `#6D28D9`) for every
  mark, and `--gr` (dark `#2FBF97`, light `#15795C`) for the saving's figures, tints from `color-mix`, and the button
  is the app's primary button (`--on-fill` text, a brightness step on hover), so the section follows the theme with
  the rest of the app. Only the "Paid today" bar is a neutral grey (`--mu`). The faded "With Rebelipay" colour clears
  the data-viz validator's 2:1 floor (2.6:1 dark, 2.3:1 light) and carries a visible label. Every text pair clears
  WCAG AA in both themes: the pill's green text 4.64:1 on the lightest violet tint (`--rp-soft`) in light (on the 14%
  chip tint it was 4.25:1), the green headline amount 5.36:1; the pill's hover state lights an edge and a ring rather
  than darkening its fill, so it stays above 4.5:1.
- App tokens and `ref-*` classes only everywhere else (no copy of the report's palette); recharts via `useChartTheme()`; light and
  dark themes; mobile width; tooltips on charts.

---

## 9. Testing

Standalone scripts (repo convention): `check()` helper printing `ok` / `FAIL` per check, non-zero exit on failure,
no framework, no DB, no network, no model, no `.env`.

- `backend/tests/fixtures/card-statements/<merchant>_<yyyymm>.extracted.json`: the 12 samples, hand-verified
  against the PDFs, schema §3.2, TIN `"0000"`. Plus `csv-three-rows.csv` ($10.00, $25.55, $100.00, no fee column).
  Every other case (not eligible, CSV edge cases, incomplete card types, corrupted copies) is built in-test from these.

| Suite | Checks | What it pins |
|---|---|---|
| `card-statement-analysis-verify.js` | 306 | the engine on the fixtures: six findings in order on every statement; July KPIs against `statement.html` (card volume, debit volume/share, effective rate, repeat share, Amex premium, printed YoY, average ticket); junk fees; Bethany Jul 3 low batch and Jul 4 spike, zero day, prior period; legacy notices and null customers, WR May chargeback $26.36; null sections listed in `missing`; determinism, no dashes, no vendor names; CSV without fees; hostile CSV cells, funding Type columns, blank and negative-convention fees; incomplete card types never priced as zero; a stream that never finishes is stopped at its deadline with the owner-safe message |
| `card-statement-rebelipay-verify.js` | 134 | §6 worked table to the cent with `refundsReturnFee:false`; all 12 samples ($3,595.62); refund credit on (the default), computed independently in integer cents; by-card-type rows sum to totals; `savingsToDate` $540.58; not eligible (`costs_more`, $0.00 saving, `no_volume`); CSV fixture = $3.76 and `no_current_fees`; a deep scan proving no output contains a component field or value |
| `card-statement-reconcile-verify.js` | 186 | every fixture passes 8 of 8 in contract order; each deliberately corrupted copy fails exactly its own check; the $0.05 tolerance and the D11 rate floor; skipped checks; `card_type_rows` on rows read without sales or counts; fixtures carry nothing identifying (TIN `"0000"`); core-header failure |
| `card-statement-routes-verify.js` | 148 | the real router over HTTP against a fake pool: every SQL statement carries the client predicate except the boot sweep; cross-client 404 on every endpoint; upload validation (400/413); hash duplicate (including a tombstone's bytes, and per client only); identity duplicate; history and savings to date; search by text and period, every sort order, paging and the store filter together; file and CSV export; `NOT_ELIGIBLE`, `BUSY`, `DUPLICATE`, `NOT_ANALYSED`; owner-safe failures and `AMOUNT_NEGATIVE`; CSV upload end to end; stuck-row recovery, lazily and at boot, and the `CS_STALE_MINUTES` floor; the list kept in step with the page (D44: a later statement re-filed when an earlier one arrives, is read again, fails or is deleted, a stale count re-filed on open, an older engine's rows re-filed by their own client's list only, nothing re-filed twice); delete; `503 MIGRATION_MISSING`; no price components in any payload, log entry, webhook body or CSV export |
| `card-statement-search-verify.js` | 61 | every supported period spelling and the impossible ones; multi-word periods read as one; one parameterised condition with escaped wildcards; the meaning against the 12 samples ("june", "wine june", "06/30/2026") |

Totals above are from `npm test` on 2026-10-07: **5 of 5 suites, 835 checks, 0 failures**.

How to run (from `backend/`):

- `npm test` runs `tests/run-card-statement-tests.js`, which finds every `tests/card-statement-*-verify.js`, runs
  each in its own Node process, prints PASS/FAIL per suite and exits non-zero if any failed.
- One suite: `node tests/card-statement-routes-verify.js` (`CS_TEST_VERBOSE=1` shows the service's logs).
- `npm run check-routes` (every API call reaches a route, every link a page).
- Manual extraction against a real PDF (costs a model call; keep PDFs outside the repo and the output out of
  tickets): `node scripts/cs-extract-sample.js <pdf> tests/fixtures/card-statements/<fixture>.json`.

CI (`.gitlab-ci.yml`, merge requests): `test-backend` runs `npm ci` and `npm test --if-present` in `backend/`, so all
five suites run on every merge request; `build-frontend-check` runs `npm run build` in `frontend/`. The frontend has
no unit tests in CI; the checks it was verified with are listed in §10.1.

---

## 10. Status

Built on branch `feat/card-statement-analysis`. Migrations 023-025 are applied to the local analytics database
(2026-10-07).

### 10.1 Verified

| Check | Result |
|---|---|
| Backend suites (`npm test`) | PASS: 5 of 5, 835 checks (analysis 306, rebelipay 134, reconcile 186, routes 148, search 61) |
| `npm run check-routes` (backend) | PASS: every API call reaches a route, and every link reaches a page |
| Live run: the 12 sample PDFs uploaded through the real route and read by the model | PASS: 12 of 12 `analysed`, every one 7 of 7 reconciliation checks (the run predates the 8th check, `card_type_rows`, which the fixtures now pass 8 of 8); the extractions matched the hand-verified fixtures |
| July KPIs against `statement.html` | PASS for all four stores: card volume $194,524 / $188,823 / $227,057 / $161,008, debit share 74.1% / 52.0% / 54.7% / 51.1%, effective rate 3.02% / 3.00% / 3.01% / 3.10%, repeat share 31.6% / 26.0% / 23.8% / 26.9%, Amex premium +29% / +27% / +34% / +40%, YoY -1.63% / +3.79% / -4.97% / -0.82%, average ticket $28.11 / $33.15 / $38.03 / $36.41 (WR / SP / BE / MI) |
| Rebelipay against the plan's table, refunds off | PASS: every row of §6 to the cent; 12-sample total $65,883.27 paid, $62,287.65 with Rebelipay, keep $3,595.62 |
| Rebelipay with refunds credited (the default) | Spotswood Jul keep $286.97, Millstone Jul $443.86, the rest unchanged; 12-sample total $62,237.46 with Rebelipay, keep $3,645.81 |
| Cross-client access | PASS: 404 on every endpoint (routes suite) |
| Frontend: `eslint --max-warnings=0` on both components, `check-hook-order`, `check-env`, `check-routes` | PASS |
| Frontend render harnesses (jsdom, kept outside the repo) | PASS: detail 3,263 checks over 33 payloads, list 236 checks |

### 10.2 Manual end-to-end checklist

Run on a QA or staging build (or `npm start`), signed in as a test client, with the 12 sample PDFs and
`statement.html` to hand.

| # | Step | Expected |
|---|---|---|
| 1 | Upload all 12 PDFs in one batch | The dialog shows 12 "queued" and closes; the list resets to its default view and shows 12 "Analysing…" rows that settle without a refresh |
| 2 | Wait for the reads | 12 analysed rows, 4 stores x May/Jun/Jul, no "Could not read"; the Save with Rebelipay column shows a saving on every row |
| 3 | Upload one of the same PDFs again | Its row in the dialog says the file is already on your list; no new row; the original's log shows a `duplicate` event |
| 4 | Upload a modified copy of one statement (same statement, different bytes, e.g. re-saved or re-printed to PDF) | It appears as "Analysing…", is read, then disappears; the notice "<file> is the same statement as <store> · <period> and was not added again." links to the original; both logs show `duplicate` |
| 5 | Open Wine Republic Jul 2026 and compare with `statement.html` | KPI band, findings 01 to 06, junk fees, Amex tell and trend match the report; hero "you'd have saved $213.20", "$540.58 across your 3 uploaded statements for this store"; no price figure anywhere |
| 6 | CSV | `card-statement-498387143882-2026-07.csv` downloads and opens in a spreadsheet with Summary, Rebelipay comparison (totals and all-in rates only), Card types, Fee lines, Daily |
| 7 | Original | The PDF opens in the viewer and matches the upload |
| 8 | Reanalyse | The chip and button say "Analysing…" for a minute or two, figures hidden; then "Analysed" and "Reanalysed · N of N totals add up"; the log shows "Analysed again" (read the file again) and "Analysed" |
| 9 | On a statement that could not be read, Reanalyse | "Analysing…" for a minute or two, then the figures; the log shows "Analysed again" (read the file again) and "Analysed" |
| 10 | Explore Rebelipay | `REBELIPAY_CTA_URL` opens in a new tab; the log shows "Asked about Rebelipay" with merchant, period, card volume, current fees and rate, you save and per year; the webhook receives the lead when one is set |
| 11 | Delete a statement | The confirm names it; the row, its log and the stored file are gone |
| 12 | Restart the backend during a read, then wait `CS_STALE_MINUTES` | The row becomes "Could not read" with "Interrupted by a server restart. Reanalyse it to read it again."; the log shows "Interrupted"; Reanalyse reads it normally |

### 10.3 Deployment notes

- **Apply 023-025 before the backend image ships.** `MIGRATE_ON_BOOT` defaults off when `NODE_ENV=production`, and
  without the tables every route answers `503 MIGRATION_MISSING`. Run `npm run migrate --prefix backend` with
  `ANALYTICS_MIGRATE_DSN` set to an owner connection (the app role cannot create tables in production). 025's grants
  are what the app role needs; they are invisible locally and fatal if missing.
- **Originals persist on the backend data volume.** `CS_UPLOAD_DIR` defaults to `data/card-statements` under
  `backend/`, which is `/app/data/card-statements` in the container, on the `backend_data` volume in
  `deploy/docker-compose.prod.yml`. That file's comment on the volume still mentions only imagegen output.
- **Optional env**: `REBELIPAY_CTA_URL`, `REBELIPAY_LEAD_WEBHOOK`, `CS_PARSE_MODEL`, `CS_PARSE_TIMEOUT_MS`,
  `CS_STALE_MINUTES` (§7). The refund setting is `rules.rebelipay.refundsReturnFee` in `cardStatementRules.js`, not
  an env var.
- **Showing the screen in production** needs `REACT_APP_SHOW_CARD_STATEMENTS=true` at build time (CRA bakes it in).
  `frontend/Dockerfile` takes it as a build arg (empty by default, which follows `REACT_APP_ENV`), and the
  `build-frontend` CI job passes the GitLab CI/CD variable `SHOW_CARD_STATEMENTS` into it. To roll out, set
  `SHOW_CARD_STATEMENTS=true` and rebuild `main`; to pull it back, set `false` (or delete the variable) and rebuild.
  QA and staging builds show it already.

### 10.4 Known limits

- Reads run **in process**, in the background of the request that uploaded the file: no queue, no concurrency cap,
  and a restart loses the read (the stale sweep then fails the row). The upload dialog sends one file at a time, but
  several owners or tabs can start many reads at once; about 24 concurrent extractions ran fine in testing.
- No per-client upload cap: an account can upload as many statements as it likes, and each PDF costs a model read.
- Notice text spacing varies between reads, depending on whether the model read the PDF's text layer or the page
  image (the last page is often an image). The fixtures use the spaced form; compare notices ignoring whitespace.
- Only Better Payments layouts (`legacy_2026`, `v2_2026`) have been tested. Another processor's statement takes the
  same path and is reconciled, but has not been seen.
- European decimal commas in a CSV are not supported: in a `;`-separated export, `12,50` reads as 1250 (the comma is
  taken as a thousands separator) rather than being rejected.
- A per-card-type Rebelipay row can be negative on an eligible statement (Millstone Jul DEBIT: -$0.16). It is honest
  arithmetic and is shown muted, never as a saving.
- The Rebelipay price is derivable from any two totals (for example two statements' card volume, transactions and
  Rebelipay cost). The rule is that its components are never displayed, not that they cannot be worked out.
- `parseModel` is in the detail payload, mirroring Quick-PO; the screen never shows it.
- A duplicate found while the owner is away is explained only in the same browser tab (sessionStorage). A new tab or
  another device sees the statement simply not listed.
