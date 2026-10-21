# Quick PO - invoice and purchase-order capture

Upload a supplier invoice or purchase order, Botella reads it, and the lines
come back checked against the store's own catalogue so the owner can see what
was delivered and which of it Botella does not recognise.

Ported from the QuickPO .NET/Next.js reference project, adapted to Botella's
Node + React + Postgres stack. This document records what was built, what was
verified against live data, and what was deliberately not built.

---

## 1. The reference flow, and where this differs

QuickPO's pipeline:

1. `POST /invoices/upload` takes one or more files.
2. `InvoiceParserService` runs a **cascade**: three PDF text extractors
   (PdfPig reading-order, PdfPig positional, DocNet), each feeding a text
   prompt to Claude, accepting the first result above a 0.65 confidence floor.
   Images, and PDFs where every extractor failed, fall through to a **vision**
   call on rendered page PNGs.
3. The parse returns `{ invoices: [...] }` - one document can hold several
   distinct invoices.
4. Rows persist as `TblInvoice` + `TblInvoiceItem`; a vendor is resolved or
   created.
5. Each line gets `isMapped` by looking up the POS product. The invoice gets
   `readyToPush` = vendor mapped AND at least one line AND zero unmapped.
6. Unmapped lines are resolved in the UI by **searching** for an existing
   product or **creating** one in the POS, which auto-maps the line.
7. `GET /{id}/file` and `GET /{id}/csv` for the original and the parsed lines.
8. `POST /{id}/push` writes a stock receipt into the POS.

### Three places this implementation departs, and why

**No extractor cascade.** Anthropic's API accepts a PDF as a first-class
`document` block and does its own text-layer extraction, falling back to the
rendered pixels when there is no text layer. The cascade exists in QuickPO
because it was written against an API that could not take a PDF directly;
reproducing it here would add three dependencies and a confidence heuristic to
arrive at the same place.

It also closes a hole. QuickPO sends images straight to vision *precisely
because* a text extractor cannot see the pen corrections a receiver writes on a
delivery - but a scanned-and-re-saved PDF still has a text layer, so it takes
the text route and those corrections are silently lost. Sending the document
itself means the model sees the page either way.

**One document, one invoice.** QuickPO models `invoices: []` per upload.
A store owner uploads one supplier document at a time; multi-invoice PDFs are a
distributor-batch case this product does not have, and modelling for it now
would mean a list that reports "3 invoices" for one upload with no way to have
asked for that.

**No push to POS.** See section 6 - this is the significant gap, and it is a
platform limitation rather than an omission.

---

## 2. What was built

### Database (analytics DB)

| Migration | Table | Purpose |
|---|---|---|
| `008_purchase_orders.sql` | `purchase_orders` | One row per uploaded document: header fields, totals, the stored file, parse diagnostics. |
| `008_purchase_orders.sql` | `purchase_order_items` | One row per parsed line, plus an explicit `matched_sku` when a human links or creates. |
| `009_po_manual_products.sql` | `po_manual_products` | Products the owner adds from a line. See section 4. |

Rows live in the **analytics** DB, not `syncgo`. `syncgo` is the POS mirror,
written by the sync; putting documents we read off a PDF in there would blur
"what the register says" against "what we read". Same reasoning that put
recommendations there.

**Matching is resolved at read time, not frozen at parse time.** The only thing
persisted is an explicit human link. The automatic match re-runs on every read,
so a product added an hour after the upload makes its line match without
re-parsing.

### Backend

- `services/purchaseOrderService.js` - parse, store, persist, match.
- `routes/purchase-orders.js` - mounted at `/api/purchase-orders` behind
  `verifyToken` + `attachPool`.

| Method | Path | Does |
|---|---|---|
| POST | `/upload` | Store the file, parse it, persist, return the detail |
| GET | `/` | List the store's documents |
| GET | `/:id` | Detail with lines and live match status |
| PATCH | `/:id/items/:itemId` | Correct a parsed field |
| POST | `/:id/items/:itemId/link` | Point a line at an existing product |
| DELETE | `/:id/items/:itemId/link` | Undo that |
| POST | `/:id/items/:itemId/create-product` | Add the product and link in one step |
| GET | `/products/search?q=` | The picker; covers POS catalogue and overlay |
| GET | `/:id/file` | View inline, or `?download=1` to save |
| GET | `/:id/csv` | Parsed lines with match status, UTF-8 BOM for Excel |
| DELETE | `/:id` | Delete the document and its file |

Uploads: PDF, PNG, JPEG, WebP, up to 20MB, one file per request. Files are
stored under `backend/data/purchase-orders/<client>-<location>/` with a random
name; the original name is kept in the row for display.

The parse runs **inline**, not on a queue: it takes about ten seconds and the
owner is watching the upload. A queue would mean a job table, a poller and a
progress UI to hide latency they are already waiting through. The row is
written as `parsing` first, so a crash mid-parse leaves a visible failed row
rather than nothing.

A failed parse returns **HTTP 200**, not 500 - the upload succeeded and the row
exists; the client needs to open it and show why, which a 500 would deny.

### Frontend

`components/PurchaseOrdersScreen.js` + `.css`, reachable from a new
**Purchase Orders** sidebar item at `/purchase-orders`.

List and detail live in one screen rather than two routes, so the owner never
loses the list while resolving a dozen lines. The detail carries the totals
strip, the line table, and the resolution controls. **Unmatched lines are
tinted**, not merely annotated, so they are findable by scrolling.

The file endpoints are GETs behind the JWT, so they cannot be a plain
`<a href>`; the screen fetches to a blob, which keeps the Authorization header
and still hands the browser a real file to open or save.

---

## 3. Verified against live data

Backend booted on a spare port, a synthetic four-line distributor invoice
(built as a real PDF with a text layer) uploaded through the actual endpoint,
against tenant `171:171`.

**Parse - HTTP 200 in 10.7s, every header field correct:**

```
vendor    : SUNRISE BEVERAGE DISTRIBUTORS
invoiceNo : SB-2026-44817 | date 2026-09-02 | due 2026-10-02 | acct BETH-0194
totals    : sub 571.80  disc 12.30  tax 0  delivery 18.00  TOTAL 577.50
items     : 4 of 4, confidence 1.0
```

All four lines came back with the right code, name, pack, quantity, unit cost
and extended price. Notably the model read **quantity 12** for
`6/1.75L ... 12`, i.e. it did not mistake the pack description for the quantity,
which is the single most common failure on this document shape.

| Check | Result |
|---|---|
| Upload + parse | PASS - 10.7s, all fields correct |
| Product search | PASS - 10 hits for "Titos" from the real catalogue |
| Link to existing product | PASS - unmatched 4 -> 3, line reports `via manual` |
| Create product from a line | PASS - unmatched 3 -> 2, line reports `via created` |
| CSV export | PASS - correct rows, match status per line, BOM present |
| Original file download | PASS - HTTP 200, `application/pdf`, 2558 bytes |
| List | PASS - one row, correct totals and item count |
| Search covers the overlay | PASS - added product returned with `source: added` |
| Frontend build | PASS |

**Two defects found and fixed during this testing:**

- `itemCount` came back `undefined` on detail responses - `toApi()` read the
  SQL alias that only the *list* query computes, so the UI rendered
  "3 of  lines". Now falls back to counting the loaded rows.
- `create-product` failed outright with `permission denied for table products`.
  See the next section.

---

## 4. The permission finding, and what it changed

The original implementation of "add to inventory" inserted into
`syncgo.products`, mirroring what QuickPO does against its POS. That failed:

```
current_user = bottela | SELECT = true | INSERT = false | UPDATE = false
```

The application role is **read-only on the POS mirror**, and that is correct,
not an oversight. The mirror is owned by the sync process; a row we inserted
would be overwritten or deleted the next time the POS pushed its catalogue, so
the button would appear to work and quietly undo itself hours later.

So a manually added product is recorded in `po_manual_products` - Botella's own
note that this product exists - and the matcher reads **both** sources, POS
first, overlay second. When the product later appears in a real sync, the POS
row wins on sku and the overlay row stops being consulted.

This means **"Add to inventory" does not create the product in your POS.** It
resolves the invoice line so the document is complete and countable inside
Botella. Creating it in the POS needs a write path Botella does not have
(section 6).

---

## 5. A second finding worth knowing

The catalogue already contained `Roku Gin 750ml` (sku `080686958031`). The
invoice said `Roku Japanese Gin 750ml`. The auto-matcher **did not** match
them, because name matching is exact after case-folding and whitespace
collapsing - deliberately not fuzzy, since "Titos 750ml" and "Titos 1.75L" are
one edit apart and are different products.

The consequence is real: more lines land in the manual queue than strictly
need to. That is the safe direction to err - a wrong match silently attributes
a delivery to the wrong product - but a token-overlap matcher that proposes
"did you mean Roku Gin 750ml?" without auto-applying it would cut the manual
work substantially. Not built; see below.

---

## 6. Completed in the second pass

Everything below was listed as "not built" in the first pass and has since been
built. Verified end to end by uploading a real invoice through the real file
input and driving the screen: **13/13**.

**In-app document viewer.** "View original" used to call `window.open()` on a
blob URL. Three things wrong with that, all of which a store owner hits on the
first click: `window.open()` from inside an async fetch is no longer a user
gesture, so popup blockers ate it and the button looked dead; it left the app,
losing the parsed lines you opened the document to check against; and a `blob:`
tab has no filename and no way back. It now opens in a modal beside the parse,
with Download in the same frame, an "open in a new tab" escape hatch that IS a
user gesture, Escape to close, and zoom for photographed invoices. PDFs render
in an iframe (the browser's own viewer, with its page thumbnails and print);
images render as an `<img>`.

**Match suggestions.** Section 5's finding, closed. A token-overlap scorer
proposes near-misses without ever applying one - the exact matcher is unchanged,
because a wrong automatic match silently books a delivery against the wrong
product. Two things keep it honest:

- **Size is a gate, not a token.** If both names state a volume and the volumes
  differ, the score is zero however many words they share. Measured:
  `Roku Japanese Gin 750ml` vs `Roku Gin 750ml` scores **1.00** - the exact case
  from section 5 - while `Titos 750ml` vs `Titos 1.75L` scores **0.00**.
- **A floor and a margin.** Nothing below 0.45 is offered, and only a leader
  that also beats the runner-up by a clear margin is drawn as confident. Three
  near-identical sizes of one product must read as a choice, not an answer.

On the test invoice: 4 unmatched lines, 8 suggestions offered.

**Inline line editing.** `PATCH /:id/items/:itemId` had existed since the first
build with nothing calling it. Product name, quantity, cost and extended price
are now click-to-edit, saved on Enter or blur, abandoned on Escape. The numbers
a model read off a scan are exactly the ones a person needs to be able to fix.

**Re-parse.** `POST /:id/reparse` re-reads the stored file and runs the same
`saveParsed()` the upload path uses, so the two cannot drift. The owner's manual
links are captured first and re-applied by (line number + product name):

- name alone would move a link to the wrong line if the re-parse reorders
- line number alone would move it to a *different product* if the new parse
  finds one extra line near the top

Requiring both is why the response reports links **carried** and links **lost**
rather than silently re-attaching one to something nobody chose.

---

## 6b. Still not built

**Push to POS.** Confirmed out of scope. QuickPO writes a stock receipt back;
Botella has no POS write connector and the role it connects with is read-only.
A platform question, not a screen question.

**Receiving / stock adjustment.** Same reason.

**Vendor entities and vendor mapping.** The vendor is free text on the document.
Nothing consumes a vendor entity yet, so the table would have no reader.

**Multi-invoice documents.** One upload is one document (section 1).

## 7. Deployment notes

**Run the migrations.** `008` and `009` were applied to the analytics DB this
build connects to. On any other environment:

```
node database/migrate.js analytics
```

Note that will ALSO apply `005_instagram_trends`, `006_ig_dynamic_terms` and
`007_suggested_order_qty`, which were pending and are unrelated to this work.
They were deliberately left alone here; only 008 and 009 were applied, each
recorded in `schema_migrations` with the correct checksum so a later full run
skips them cleanly.

**A pre-existing config inconsistency to be aware of.** `backend/.env` says:

> `ANALYTICS_DATABASE_URL` takes precedence over the discrete `ANALYTICS_PG_*`
> vars below, which are kept only as the local fallback.

That is **not what the code does.** `database/analytics-connection.js` (the
runtime pool) and `database/migrate.js` both read only the discrete
`ANALYTICS_PG_*` vars and ignore `ANALYTICS_DATABASE_URL` entirely. The two
point at different databases:

| Source | Host | Database |
|---|---|---|
| `ANALYTICS_DATABASE_URL` | Neon (`...aws.neon.tech`) | `neondb` |
| `ANALYTICS_PG_*` | `localhost` | `bottleai_analytics` |

Both contain a `recommendations` table, so both look plausible. This cost a
debugging cycle here: the first migration run landed on Neon while the server
read localhost. The migrations have since been applied to **both**, so Quick PO
works either way, but the mismatch between the comment and the code is worth
resolving before it bites something else.

**Optional env:**

- `PO_PARSE_MODEL` - defaults to `claude-sonnet-5`.
- `PO_UPLOAD_DIR` - defaults to `backend/data/purchase-orders`. Should point at
  persistent storage; on an ephemeral filesystem the rows survive and the
  originals do not.

**No new dependencies.** `multer` and `@anthropic-ai/sdk` were already present.

---

## 8. Known limits

- Uploaded files are stored on local disk, so the backend is stateful for this
  feature. Multi-instance deployments need shared storage or S3.
- The parse is synchronous and holds a request for roughly ten seconds; a large
  scanned multi-page PDF will take longer.
- `confidence` is a blunt figure: the share of lines that came back with both a
  name and a quantity. It flags a parse worth checking; it does not claim the
  numbers are right.
- Only tested against a digital PDF with a text layer. **A photographed paper
  invoice takes the same code path and should work, but has not been tested**,
  and neither has a handwritten correction. The viewer's image branch (zoom, the
  white sheet behind the photo) is likewise written and unexercised. Worth a real
  scan before this goes in front of a store owner.
- Suggestions are name-only. They do not consider category, brand or price, so a
  supplier who abbreviates heavily ("BF TRC BRBN 750") will still fall through to
  the manual queue - correctly, since there is nothing there to match on.
