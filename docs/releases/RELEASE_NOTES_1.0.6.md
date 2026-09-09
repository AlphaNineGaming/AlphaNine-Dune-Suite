# AlphaNine Dune Suite 1.0.6

AlphaNine Dune Suite 1.0.6 adds controlled Sietch Rename tooling for live server admins.

## Highlights

- Added **Server Control -> Sietch Rename**.
- Lists live world partition labels from `dune.world_partition`.
- Shows partition ID, map, dimension, server ID, blocked state, and current label.
- Adds a guarded rename action that only updates the row when the current label still matches the value loaded by the UI.
- Adds admin audit entries for successful and failed rename attempts.

## Notes

- This changes `dune.world_partition.label` only.
- It does not change partition IDs, map names, server IDs, dimensions, ownership, or partition definitions.
- Players may need to relog, or the map/server may need a restart, if the game cached the old label.
- Make a database backup before renaming labels on an active server.

## Included Since 1.0.5

- All Market Bot automation, manual listing, simulation, and Python auto-detection improvements from 1.0.5 remain included.
