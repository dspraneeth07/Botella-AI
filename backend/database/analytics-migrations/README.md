# Analytics migrations

The `.sql` files in this directory are applied, in filename order, exactly once
per database by `backend/database/migrate.js` (`npm run migrate`,
`npm run migrate:status`, or at boot when `MIGRATE_ON_BOOT` allows it). The
runner records each file's name and SHA-256 in `schema_migrations`. The rules
that follow come from how that runner behaves, not from preference; read the
header comment of `migrate.js` for the full set.

## The `DRIFTED` warning on 001-004 and 029

Every server boot, and every `npm run migrate`, prints

```
[migrate:analytics] WARNING 001_product_first_seen.sql was EDITED after being applied (checksum mismatch). Applied migrations are immutable - fix forward with a new file.
```

for `001_product_first_seen.sql`, `002_recommendation_evaluations.sql`,
`003_effectiveness_extensions.sql`, `004_action_claims.sql` and
`029_signal_effects.sql`, and `npm run migrate:status` lists the same five as
`DRIFTED`. The 19 October 2026 QA audit recorded it as defect 11.

What it means, precisely: the text of each of those five files on disk no
longer hashes to the checksum `schema_migrations` recorded when the file was
applied. The files were edited after they had already run - on this checkout's
database and, since the same files shipped, on every database that applied
them before the edit. The file you read is therefore not a faithful account of
what that database executed. Whether the difference is a comment, a reworded
`CREATE INDEX IF NOT EXISTS`, or a column that one environment has and another
does not, the checksum cannot say; `git log -p -- <file>` can.

What it does NOT mean: nothing is broken by the warning itself. `migrate.js`
reports drift and continues - `summary.drifted` is printed in the "done" line
and never turns into a non-zero exit, because a boot loop over a checksum would
be worse than a warning. The five files are not re-executed; an applied name is
skipped whatever its checksum.

### How to reconcile

The runner has exactly one reconcile mechanism, the `-- @baseline` pragma, and
`000_base_tables.sql` is the one file using it today. The rule (`isBaseline()`
in `migrate.js`): when a file's FIRST line is exactly `-- @baseline`, and its
name is already recorded with a different checksum, the stored checksum is
UPDATED to match the file ("baseline NNN: recorded checksum reconciled") and
the file is still not re-executed. An unrecorded baseline whose declared
`CREATE TABLE IF NOT EXISTS` tables all already exist is recorded without
being run. `--status` shows such a file as `baseline` rather than `DRIFTED`
until the next apply reconciles it.

So there are three honest options for each drifted file, and the choice
depends on what the edit was:

1. **Leave it.** The warning is informational. This is the right answer while
   nobody has checked what changed; it keeps the one signal that catches real
   tampering visible.
2. **Declare the on-disk text authoritative.** When `git log -p` shows the
   edit changed nothing the database holds (a comment, a reworded grant that
   every environment already has), add `-- @baseline` as the file's first
   line. Adding the line changes the checksum again, which is fine: the next
   `npm run migrate` reconciles it on every database and the warning stops.
   Editing a baseline never changes a database - only the repository's
   account of it - so this is safe by construction and that is also its limit.
3. **Fix forward.** When the edit added DDL that an environment applied before
   the edit does not have, that DDL goes in a NEW numbered file (idempotent -
   `IF NOT EXISTS` / `OR REPLACE`), so every environment converges on the next
   run. The old file still warns until it is also baselined under option 2.

The SQL files themselves were deliberately not touched when this note was
written; which option each of the five takes is a decision for whoever reads
the diffs, and the runner supports all three.

## Duplicate numbers: 005, 023, 024, 025

Four prefixes are used twice:

| number | files |
| ------ | ----- |
| 005 | `005_instagram_trends.sql`, `005_po_recommendations.sql` |
| 023 | `023_card_statements.sql`, `023_store_gate_verdict.sql` |
| 024 | `024_calibration_bundle.sql`, `024_card_statement_events.sql` |
| 025 | `025_card_statement_grants.sql`, `025_signal_history.sql` |

It works, because the runner sorts by full filename and the two files with a
shared number happen to be independent of each other, so the lexicographic
tiebreak on the rest of the name has never mattered. It is still a trap: the
next author who picks "the number after the last one I see" picks one that is
taken, and a future pair that is NOT independent would apply in alphabetical
rather than intended order. Do not renumber the existing files - a rename is a
new, unapplied name to every database that already recorded the old one, and
the old one is then reported as `missing`.

**Rule for a new file: next number = max + 1, and check with `ls`.** The
highest number in this directory is the one to look up, not the highest you
remember (it moved from 038 to 039 while this note was being written, on
another branch of the same tree); two branches adding the same next number at
once will collide at merge, which is a visible conflict and the cheap kind.

```
ls backend/database/analytics-migrations | sort | tail -3
```

Other file rules, from the runner header: numeric prefix, atomic (wrap in
`BEGIN`/`COMMIT` or rely on the single multi-statement query), idempotent DDL,
never edit an applied file, and `-- @baseline` only for recovered or squashed
base schemas.
