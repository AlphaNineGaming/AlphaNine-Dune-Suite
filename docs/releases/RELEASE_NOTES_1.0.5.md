# AlphaNine Dune Suite 1.0.5

AlphaNine Dune Suite 1.0.5 brings the Market Bot from a hidden backend utility into a usable economy control page for small private servers.

## Highlights

- Added a full Market Bot page for economy simulation and manual market operations.
- Added editable bot settings for buy, listing, and simulation intervals.
- Added controls to restock the market, buy player listings, simulate buyers, or run a full economy cycle.
- Added live market listing management with single remove, multi-select remove, and player listing buy actions.
- Improved listing display so item name, grade, tier, stack size, price, owner type, and exchange are easier to read.
- Added a foldable Market Result panel so API output does not take over the page.
- Added Setup Wizard and Settings support for automatic Python detection and saved Python runtime paths.
- Added a short Market Bot user guide for setup, safe defaults, manual listings, cleanup, and troubleshooting.

## Market Bot Behavior

- Restock runs now add a small random batch of NPC listings instead of flooding the market.
- Buy runs are tuned to buy a small number of player listings.
- Buyer simulation now removes consumed NPC/manual listings from the live market instead of leaving stale rows behind.
- NPC/manual listings can be removed from the Suite whether they were created manually or by the bot.

## Recommended Small Server Defaults

- `BUY_INTERVAL`: `20m`
- `LIST_INTERVAL`: `2h`
- `SIM_INTERVAL`: `10m`
- `SIM_HOUSEHOLDS`: `10`
- `SIM_MAX_ORDERS`: `40`
- `SIM_INTENSITY`: `0.35`

## Notes

The Suite must be running for Suite-side monitoring and controls. Scheduled market-bot behavior depends on the bot service configuration; manual buttons run immediately from the Market Bot page.
