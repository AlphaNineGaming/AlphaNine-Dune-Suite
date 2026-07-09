# AlphaNine Dune Suite 1.0.26

Market cleanup hotfix for expired bot/manual listings.

## What's Changed

- Added automatic cleanup for bot/manual market listings with `0`, null, or expired timers.
- Cleanup is limited to NPC orders or `AlphaNineMarket` owner rows, so real player listings are not removed by the automatic pass.
- Cleanup now runs when Suite refreshes Market status or Live Market Listings.
- Cleanup now runs before and after manual Market Bot ticks.
- Suite also runs the cleanup shortly after startup and every 10 minutes while open.
- Manual Market Bot tick results now report how many expired listings were cleaned.

## Notes

- This is a Suite-side cleanup, so no Market Bot binary rebuild is required.
- The cleanup removes the exchange order, sell-order row, and linked listing item for stale bot/manual listings.
