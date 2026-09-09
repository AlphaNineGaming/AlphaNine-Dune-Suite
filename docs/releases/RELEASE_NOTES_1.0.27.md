# AlphaNine Dune Suite 1.0.27

Server cleanup release for orphaned base and fief maintenance.

## Highlights

- Added a dedicated Server Cleanup page in the main Server menu.
- Added a dry-run base/fief scanner that compares base ownership references against the live player list in `dune.player_state`.
- Added guarded orphan-base deletion for bases whose owner/rank references no longer match any existing player.
- Protected unknown-owner and still-owned bases from deletion.
- Added revalidation before delete so a base cannot be removed if the player appears again between scan and delete.

## Admin Notes

- Cleanup is manual and dry-run first; there is no automatic base deletion.
- Delete actions are audited in `admin-audit.log`.
- Current cleanup scope targets orphaned base/fief console ownership only. Other stale server data can be added later under the same Server Cleanup page.
