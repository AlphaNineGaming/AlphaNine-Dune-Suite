# AlphaNine Dune Suite 1.0.14

Market Bot listing preservation hotfix.

## What's Changed

- Updated the bundled AlphaNine Market Bot so list ticks no longer delete existing NPC/manual listings just because pricing rules changed after an update or config change.
- Existing listings are now preserved unless they expire, are bought/simulated, exceed the configured per-grade cap, or are manually removed.

## Notes

- Suite updates do not delete market listings from the game database.
- If an older bot already removed listings, recreate them from the Market Bot page after installing this hotfix.
