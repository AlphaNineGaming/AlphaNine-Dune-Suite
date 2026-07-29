# AlphaNine Dune Suite 1.0.81

## Current-term Landsraad reward tiers

- Fixes reward tiers accumulating in the editor after weekly Landsraad resets.
- Resolves the latest term directly from `dune.landsraad_decree_term`, ordered by `start_time` and `term_id`.
- Avoids compiling the game `dune.landsraad_load_current_term()` function, which fails on servers missing its custom Landsraad array types.
- Joins reward rows through `dune.landsraad_tasks` and limits inspection, backup, updates, stale-data checks, and read-back verification to the current non-test term.
- Preserves every historical term and reward row without displaying or modifying it.
- Rejects test terms, missing or ambiguous current terms, invalid current-term tier counts, and term rollover during preview or apply.
- Keeps the exact-five rule, protected backup, typed confirmation, table locks, transaction rollback, and audit logging.

## Verification

- Reproduced the reported 15-threshold case as five current thresholds plus ten retained historical thresholds.
- Confirmed the editor returns only the five current thresholds.
- Added a regression assertion that the packaged server contains no call to `landsraad_load_current_term()`.
- Passed current-term scoping, historical retention, exact-five, test-term, rollover, rendered UI, JavaScript syntax, and packaged installer checks.
