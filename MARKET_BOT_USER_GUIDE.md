# AlphaNine Dune Suite Market Bot Guide

The Market Bot page lets a private or small friend server keep a market economy alive by adding NPC listings, buying player listings, and simulating buyer activity while the Suite is running.

## Requirements

- AlphaNine Dune Suite must be open for Suite-side controls and monitoring.
- The market bot service must be reachable from the Suite.
- The Bot API URL and API token must be saved in the Market Bot page.
- The game database must be reachable by the market bot service.

## Connect the Bot

1. Open `Market Bot` from the left sidebar.
2. Enter the Bot API URL, for example `http://VM-IP:8081`.
3. Enter the API token if it is not already saved.
4. Select `Save Connection`.
5. Select `Refresh Bot` and confirm the status cards update.

If the page shows `fetch failed`, the Suite cannot reach the bot URL, the bot is offline, or the token is missing or wrong.

## Main Controls

- `Restock Market`: Adds a small random batch of NPC listings.
- `Buy Player Listings`: Lets the bot buy a small number of player listings.
- `Simulate Buyers`: Simulates market demand and removes bought NPC/manual listings from the market.
- `Run Full Cycle`: Runs restock, buy, and simulation together.

The buttons run immediately. They do not wait for the configured intervals.

## Recommended Settings

Use conservative settings for small private servers:

- `BUY_INTERVAL`: `20m`
- `LIST_INTERVAL`: `2h`
- `SIM_INTERVAL`: `10m`
- `SIM_HOUSEHOLDS`: `10`
- `SIM_MAX_ORDERS`: `40`
- `SIM_INTENSITY`: `0.35`

The bot is tuned so each restock adds about 1 to 5 random listings, and each buy cycle buys about 1 to 2 player listings.

## Manual Listings

Use the manual listing section when you want to add a specific item yourself.

1. Search or select an item.
2. Pick the grade, tier, stack size, and price.
3. Add the listing.
4. Check the Live Market Listings section to confirm it appeared.

Manual and bot NPC listings can be removed from the Suite.

## Managing Listings

The Live Market Listings section shows the current market rows.

- Use the checkbox beside listings to select more than one.
- Use `Remove Selected` to remove multiple NPC/manual listings at once.
- Use `Remove` on a single NPC/manual listing to delete only that row.
- Use `Buy` on a player listing if you want the bot to buy that listing.
- Fold the Market Result panel when you do not need the latest API response.

Player listings are not deleted directly. They are bought through the bot so the market behaves like a real economy.

## Keeping the Market Small

For a quiet private server:

- Keep `LIST_INTERVAL` at `2h` or longer.
- Keep `SIM_INTENSITY` below `0.5`.
- Use `Simulate Buyers` after restocking if too many NPC listings remain.
- Use checkboxes and `Remove Selected` to clean old NPC/manual listings quickly.

## Troubleshooting

- `Bot API Offline`: Check that the market bot service is running and the URL is correct.
- `fetch failed`: Usually a network, URL, service, or token problem.
- Listings do not disappear after buyer simulation: Refresh the Market Bot page and check that simulation is enabled.
- Too many items appear: Increase `LIST_INTERVAL`, reduce `SIM_INTENSITY`, and manually remove selected NPC listings.
- No automatic activity: Confirm `Bot Enabled` is checked. Manual buttons still work even when scheduled bot activity is disabled.
