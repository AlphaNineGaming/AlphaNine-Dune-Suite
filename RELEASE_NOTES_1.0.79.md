# AlphaNine Dune Suite 1.0.79

## Arrakeen Market Bot compatibility

- Fixes bot-created listings existing in PostgreSQL but not appearing in Arrakeen's in-game Exchange.
- Uses verified category mask and depth metadata and resolves Exchange access points from live database rows.
- Uses a clean native `Duke` NPC actor that Arrakeen can render.
- Safely migrates and repairs only active AlphaNine-tracked Market Bot listings.
- Unknown category metadata fails closed instead of creating invisible stock.

## Market Bot controls

- Adds a persistent Listing Category selector. Operators can list from all categories or restrict future restocks to one selected category.
- Adds Clean Bot Market, which pauses the bot and removes only listings strictly recorded as Market Bot-owned.
- Player listings and untracked NPC listings are never changed by cleanup.
- Interleaves deficient categories during capped all-category restocks so alphabetical categories cannot consume the entire cycle.

## Verification

- Added regression coverage for category metadata, native ownership, fair category allocation, and tracked-only cleanup.
- Rebuilt the embedded Linux Market Bot runtime as version 1.0.79.
- Verified the packaged Windows application with its isolated runtime smoke test.
