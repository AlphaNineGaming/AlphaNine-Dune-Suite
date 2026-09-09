# AlphaNine Dune Suite 1.0.71

## Persistent Market Bot

- Replaced the Suite-process scheduler with a Suite-native Linux/amd64 service installed and supervised inside the Dune VM.
- Added Running, Paused, Waiting for Exchange, and Error status with last run/result, cycle counts, next run, and runtime version.
- Added automatic VM installation/update while preserving a fully paused staging state before activation.
- Uses the PostgreSQL server clock when no player Exchange order exists, so a new or quiet server no longer waits forever for a player-created listing.
- Bounds Kubernetes and database calls so OpenRC startup retries normally instead of hanging while the VM database pod is warming up.

## Simple market workflow

- Replaced the primary Market page with Enable Market Bot, Economy Style, Preview Market, Restock Now, Pause Bot, status, and constrained item customization.
- Added built-in Affordable, Balanced, and Expensive pricebooks.
- Added explicit prices for armor, schematics, faction gear, construction, storage, refinery, and other live catalog categories instead of falling back to 1 Solari.
- Added a complete production preview with search, category/tier filters, totals, per-item actions, and CSV export.

## Safety and persistence

- Added a PostgreSQL advisory transaction lock, strict managed-listing ownership table, idempotent cycle records, per-item deficits, and cycle creation/value caps.
- Existing active listings are never repriced, removed, or reposted.
- Player listings and untracked NPC/manual/legacy listings are never modified.
- Disabled the old broad Suite-side expired cleanup, arbitrary listing removal, and automated player-listing buying.
- Database credentials are obtained inside the VM at runtime and excluded from Market Bot configuration and logs.

## Migration

- Preserves Legacy Market Automator configuration, exact overrides, and existing listings.
- Requires an exact preview fingerprint plus explicit confirmation before activation.
- Prevents the legacy and persistent engines from running concurrently.
- Rollback restores the preserved legacy configuration disabled for review.

## Carried fixes

- Includes the 1.0.70 grade-0 schematic Live Give and recipe/research result-routing fixes.
- Makes the Suite VM restart command non-interactive so Hyper-V cannot stall waiting for confirmation.
