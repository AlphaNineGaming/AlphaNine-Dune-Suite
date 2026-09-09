# AlphaNine Dune Suite 1.0.91

## The actual VM backup is now copied locally

Version 1.0.91 corrects the complete manual backup path. **Create Backup** now waits for the successful Funcom `DatabaseOperation`, resolves its exact backup artifact inside the VM, and streams that file into the configured local database backup folder.

The final local file must match the VM artifact's byte size and SHA-256 before the Suite publishes restore metadata or reports success. An incomplete transfer, changed artifact, insufficient disk space, or failed verification leaves no selectable partial backup.

This behavior is available from both the Database Backup Manager and the Server page's **Backup** button.

## Migration dependency removed from backup

The local-copy implementation introduced after v1.0.81 accidentally reused migration-only SSH helpers. That could block normal backups with a message requiring a test-profile migration known-host file.

Backup creation, VM artifact verification, local transport, archive-tool discovery, database health checks, and Safety Backup offline checks now use dedicated database helpers and the Suite's normal configured VM connection. They no longer depend on Migration Maintenance, Migration Offline Mode, migration SQL/evidence, or migration known-host files.

Version 1.0.81 used the normal connection but saved only local JSON metadata. Version 1.0.91 retains that reliable connection behavior while also downloading and verifying the real backup payload.

## Clear backup behavior

- **Create Backup** may run while the battlegroup is online.
- **Create Safety Backup Only** requires the selected battlegroup fully stopped while the VM and PostgreSQL remain available.
- Successful results display the VM source, verified local path, byte size, SHA-256, and metadata path.
- The exact selected battlegroup remains pinned throughout the operation.
- Routine backup fails clearly if the real VM artifact cannot be copied; it does not silently substitute a different archive.

## Verification

- Passed database archive, VM-to-local transport, atomic publication, and restore-selection regressions.
- Passed operation registry, rendered UI, scheduler, and battlegroup control tests.
- Passed legacy migration-maintenance, migration-preflight, and server-migration import isolation tests.
- Passed Windows update-integrity, installer packaging, and packaged-runtime smoke tests.
