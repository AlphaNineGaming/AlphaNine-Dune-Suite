# AlphaNine Dune Suite v1.3.6 — Server Recovery & Update Fixes

Get your server back online with a targeted database repair, clearer progress, and more reliable server controls.

## New: Repair Database Update

Find **Repair Database Update** in **Server Control → Maintenance**, beside **Check Server Update**.

The button handles the known database migration failure containing `must be able to SET ROLE "postgres"` when AlphaNine market-bot tables have incompatible ownership. It:

- Checks that the failure matches and that no game processes are active.
- Creates a full database backup, validates the archive, and verifies the local copy with SHA-256 before changing anything.
- Corrects ownership of the affected AlphaNine market-bot tables and sequence.
- Retries the failed migration and waits for the database to report **Ready**.
- Saves a local backup and repair report. A healthy database returns **No repair needed**.

This is a targeted recovery tool, not a general fix for every startup failure. It is available from the local Suite only. The automatic backup transfer currently supports compressed archives up to 64 MB; larger archives stop safely before ownership changes.

## Live repair progress

Repairs lasting five seconds or longer now show a progress bar with the current stage and elapsed time. Progress follows completed workflow stages, rather than estimating download speed or time remaining. Status polling reconnects after temporary connection failures, and errors remain visible with the repair report location.

## Server control fixes

- **Open Battlegroup.bat:** fixed Windows launch quoting that could report success without opening the management console.
- **Server Update:** retries transient Kubernetes resource conflicts, reading fresh state for each attempt. Newer administrator control requests still take priority.

## Validation

Targeted tests cover ownership scope, failed or corrupt backups, active-server protection, changed targets, migration retry, operation conflicts, the five-second progress threshold, connection recovery, and launcher errors. The release also passes the Suite UI and packaged-runtime checks.

Install **AlphaNine-Dune-Suite-Setup-1.3.6.exe** below, or use the Suite's update check.
