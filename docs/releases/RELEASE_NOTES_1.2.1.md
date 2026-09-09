# AlphaNine Dune Suite 1.2.1

This release combines the PostgreSQL backup-validation correction with a repaired **Open Battlegroup.bat** workflow for installed Suite users.

## Database backup validation

- Fixed Funcom-created VM backups being rejected when their PostgreSQL archive contains normal ACL entries.
- Vendor backup verification now builds its expected schema inventory with the same privilege boundary used by the Funcom dump.
- Suite-native backups retain their stricter no-privileges format.
- Remote backup availability checks use the corrected vendor inventory rules.
- Unexpected schema mismatches report descriptor counts such as `ACL=1` or `TABLE=1` instead of the previous generic error.
- Backup archives remain subject to signature, stable-size, SHA-256, complete-read, schema, and data inventory verification before local publication.

## Battlegroup console launcher

- The Server Control button now rereads the saved server installation paths from Settings every time it is clicked.
- Electron receives those exact configured paths and independently falls back to the persisted desktop configuration when needed.
- The detected `battlegroup.bat` is launched with `cmd.exe` in a persistent command window instead of being handed to the generic file opener.
- The command window starts in the configured Dune Self-Hosted Server folder, preserving the relative paths expected by Funcom's script.
- Windows-safe argument handling supports installation paths containing spaces.
- Launch success and failure are recorded in the desktop log with the resolved batch path.

## Release quality

- Added regression coverage for the vendor privilege boundary and detailed PostgreSQL TOC mismatch reporting.
- Added rendered bridge checks covering saved Settings paths, persisted fallback paths, persistent-console invocation, and Windows verbatim argument handling.
- Verified the launch command against a real temporary `.bat` file and confirmed that it executed from the detected working directory.
- No configuration or database migration is required. The bundled Market Bot runtime remains **1.0.99**.
