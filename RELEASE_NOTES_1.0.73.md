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

## Server Updater timeout reliability

- Quick server status checks now use a short bounded deadline, while start, restart, backup, and update commands receive operation-specific bounded timeouts.
- The Dune server update command may run for up to 30 minutes; browser deadlines remain longer than the corresponding backend work so the UI does not fail first.
- Failures now identify the exact stage, server-management command, elapsed time, backend deadline, and underlying error. A nested `server timeout of 9000 ms` is reported as a timeout from the installed server-management command instead of being mistaken for the Suite request deadline.
- Failed and timed-out updater jobs always release their busy state, and failed availability checks are not cached, allowing the next status refresh to succeed.
- No live server update is performed by the regression or packaged-runtime validation.
