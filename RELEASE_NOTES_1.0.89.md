# AlphaNine Dune Suite 1.0.89

## Manual database backups now save the real archive locally

The **Create Backup** action now places a complete, restore-ready PostgreSQL archive in the backup folder you selected. Previously, the Suite created the backup inside the Dune VM but saved only a small JSON pointer in Windows, which made the local folder look as though manual backups had stopped.

After a successful backup, the configured folder now contains:

- The verified `.backup` database archive.
- A matching `.backup.json` integrity and recovery record.

The Suite keeps the VM copy as well, reports both locations, and recognizes the Windows copy as a verified local restore source.

## Safer local publication

- Binds the download to the exact VM artifact that passed vendor-operation verification.
- Rechecks the copied byte count, SHA-256 digest, and PostgreSQL `PGDMP` signature.
- Publishes the archive atomically so an interrupted transfer never appears as a completed backup.
- Removes partial archives and incomplete metadata automatically after a failure.
- Checks available disk space and rejects unsafe destinations inside Suite, server, or temporary directories.
- Keeps existing VM-backed metadata backups compatible with the Backup Manager.

## Clearer backup feedback

- The Backup Manager now states that verified backup files and metadata are stored in the configured location.
- The completion message shows the VM path, local archive path, local metadata path, storage mode, and elapsed time.

## Verification

- Passed database backup catalog, archive transport, integrity, and local-publication regressions.
- Passed rendered UI syntax and operation-registry tests.
- Passed Windows release integrity and packaged-runtime smoke tests.
