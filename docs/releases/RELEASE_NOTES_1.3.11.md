# 1.3.11 — Scheduled Backup Storage Fix

Fixes scheduled backups reporting “Funcom reported success but the backup artifact is missing or empty” when Funcom writes the dump under Saved/DatabaseDumps.

- Resolves the actual dump location from the completed backup pod and its bound storage volume instead of assuming a fixed directory.
- Uses the resolved location for dump verification, recovery manifests, and scheduler backup retention.
- Protected restarts require the recorded backup and recovery manifest to still exist and belong to the configured battlegroup. Missing, empty, or unverifiable backups continue to block restarts.

After updating, open Backup & Restart Scheduler and select Save & Reinstall Schedule. Then select Run Backup Now and confirm that it completes successfully.

Validation: backup storage regression tests, scheduler tests, and Windows packaged-app smoke checks. Live validation on the affected VM is still pending.
