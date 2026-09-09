# AlphaNine Dune Suite 1.0.90

## Backups no longer require the removed Migration Maintenance workflow

Version 1.0.89 correctly added local database archives, but an older safety gate still required **Migration Maintenance Mode** before backup or restore actions could begin. That workflow is no longer part of the Suite UI, leaving users with no valid way to satisfy the requirement.

Version 1.0.90 removes that obsolete dependency from:

- Database **Create Backup**.
- **Create Safety Backup Only**.
- Database import and restore readiness.
- The Server page's **Backup** action.
- Scheduler **Run Backup Now**.

## Clear, purpose-built safety rules

- **Create Backup** works while the battlegroup is running and still saves the verified archive locally.
- **Safety Backup** requires the battlegroup stopped while the Dune VM remains running.
- Import and restore require a valid backup, a stopped battlegroup, no competing import, and explicit `IMPORT` confirmation.
- Backup and restore operations pin the exact selected battlegroup so a target change aborts the operation.
- Offline safety is rechecked before destructive import stages and before publishing successful results.

The Backup Manager now explains the online versus stopped-server behavior directly beside the buttons.

## Verification

- Passed database backup, archive transport, local-publication, and restore-guard regressions.
- Passed VM scheduler and battlegroup control-path tests.
- Passed operation-registry, rendered UI syntax, and legacy maintenance regression tests.
- Passed Windows update-integrity, installer build, and packaged-runtime smoke tests.
