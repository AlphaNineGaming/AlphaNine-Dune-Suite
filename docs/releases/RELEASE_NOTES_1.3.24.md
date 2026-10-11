# AlphaNine Dune Suite 1.3.24 — Edit Landsraad Task Goal Amount

UserGame Settings now includes **Landsraad → Task goal amount**. Load the live settings, enter a whole number from 0 to 1,000,000, then save UserGame.ini. Restart the battlegroup to apply the setting.

The editor reads and changes `Data.m_TaskGoalAmount` in the Landsraad settings section while preserving the other struct members, nested values, and asset paths. Saves use the existing verified local backups, per-file updates, conflict checks, and rollback workflow. Malformed or duplicate task goal members block the save.

Validation covers parsing, numeric bounds, nested-field preservation, missing fields, no-op saves, template and active-file updates, backups, and rollback. Release validation also runs rendered UI syntax, update integrity, and packaged runtime checks. Gameplay effects have not been tested on a live server.
