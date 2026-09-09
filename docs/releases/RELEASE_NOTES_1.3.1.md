# AlphaNine Dune Suite 1.3.1

Saving in the UserGame Settings editor no longer runs the broad defaults command that could overwrite UserEngine.ini and reset custom server ports.

- Update only the UserGame.ini fields you changed, preserving other per-map settings and engine files.
- Back up template and active UserGame.ini and UserEngine.ini files on the Windows computer before writing changes.
- Find saved backups under **UserGame Settings → INI backups and recovery**, with individual INI downloads and separate game/engine restore buttons.
- Back up the current files before a restore, reject stale edits, verify saved bytes, and attempt rollback if a write fails.
- Label the harvest-amount control as **effect unverified**. Saving its INI key does not confirm a gameplay effect.

Restart the battlegroup when ready after saving or restoring. The editor does not restart it automatically.

Recovery history covers backups created by this version. Older VM-only backups are not automatically imported; engine values overwritten without an earlier backup cannot be reconstructed.

Validation: INI preservation, custom engine ports, backups, restores, stale edits, rollback, rendered UI syntax, and access-control regression checks. Live VM validation was unavailable in the release environment because Windows denied access to the configured SSH key.
