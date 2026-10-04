# AlphaNine Dune Suite 1.3.22 — Force Pawn Teleport

Added **Force pawn teleport** under **Recover Character → Use coordinates instead**. Administrators can explicitly move an existing offline character to Hagga Basin despite retained vehicle/travel-parent links.

The Suite uses the existing vendor movement function and leaves those links and vehicle actors untouched. The final confirmation makes the override explicit. The game may reapply the retained links after login; this is a pawn movement option, not travel-link repair.

Offline/stopped-server checks, verified safety backups, identity protection and transactional verification remain required. Controller, PlayerState, inventory, equipment, progression, rotation, ownership and IDs are preserved. Changes to captured linked records cause rollback before commit.

Validation: all 109 recovery regressions, rendered UI syntax, installer integrity and packaged-runtime checks passed. The new override was tested with transactional fixtures; actual game spawning has not been verified.
