# AlphaNine Dune Suite 1.0.73

## Landsraad reward-tier safety

- Landsraad tier editing now requires exactly five distinct thresholds in `dune.landsraad_task_rewards`.
- Configurations containing active and legacy reward groups fail closed instead of exposing extra thresholds as editable tiers.
- Invalid tier counts show the detected count and full threshold list, return no editable tier rows, and disable preview and apply.
- Preview rejects ambiguous configurations before creating a backup or preview token.
- Apply re-checks the exact-five requirement and cannot enter the write transaction if the live configuration has become ambiguous.

## Preserved protections

- Valid five-tier changes continue to use a full backup, typed confirmation, table lock, transaction, stale-preview detection, and read-back verification.
- Task IDs, reward templates, reward amounts, and all rows in ambiguous configurations remain unchanged.
