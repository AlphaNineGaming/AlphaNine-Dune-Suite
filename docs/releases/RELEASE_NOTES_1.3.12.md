# 1.3.12 — Server Download Repair & Scheduler Status Fixes

- Added **Repair Server Download** under **Server → Maintenance**. SteamCMD validates the downloaded server files and redownloads missing or damaged files, with progress and errors shown in the Suite.
- Fixed the scheduler showing **Not Installed** while a server operation is active. Installation status now stays separate from activity checks; uncertain results show **Status Unavailable**.
- Fixed successful server deployments being reported as failed because existing management links could not be recreated. The Suite verifies the selected battlegroup revision before accepting this specific warning case.
- Explicit SteamCMD failures, including `0x2A6`, remain failures even if the wrapper later reports completion.
- Includes the scheduled-backup storage fix from 1.3.11 and retains the verified-backup requirement for protected restarts.

## After updating

For download problems, select **Server → Maintenance → Repair Server Download**. After validation succeeds, use **Check Server Update** to apply the download. Applying an update may restart server workloads.

If upgrading from 1.3.10 or earlier, open **Backup & Restart Scheduler → Save & Reinstall Schedule**, then use **Run Backup Now** to verify the backup.

Download validation does not fix insufficient disk space or filesystem permissions. If SteamCMD still fails, inspect the error log before retrying.

## Validation

Updater, download-repair, scheduler, operation, rendered-UI and packaged-runtime checks. The corrected scheduler display was also checked against the affected VM.
