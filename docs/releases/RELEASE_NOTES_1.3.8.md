# AlphaNine Dune Suite v1.3.8 — Battlegroup Import Fix

Fixes database backup imports failing while moving the uploaded backup from `/tmp` into the Battlegroup dump folder.

- Corrects the generated Bash command that caused `syntax error near unexpected token ';'`.
- Prevents echoed shell scripts from being misreported as VM permission failures.
- Clarifies that actual permission failures concern the configured VM SSH user.
- Retains staged backups when promotion fails.

Local imports resolve the currently selected Battlegroup's dump folder, including after a reinstall. Select the new Battlegroup in Settings and use the verified local backup with its AlphaNine metadata. Backup integrity and version compatibility still apply.

Validated with real Bash tests covering direct copies, sidecars, missing dump folders with mocked sudo, failure preservation, and current Battlegroup selection, plus the backup and packaged release checks. A live restore on the reporting user's VM has not been performed.
