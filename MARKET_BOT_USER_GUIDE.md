# AlphaNine Dune Suite Market Bot Guide

The Market Bot page lets a private or small friend server keep a market economy alive by adding NPC listings, buying player listings, and simulating buyer activity while the Suite is running.

## Requirements

- AlphaNine Dune Suite must be open for Suite-side controls and monitoring.
- The server VM must be running and reachable by SSH from Suite.
- A battlegroup must be detected or selected in Suite so the bot can connect to the correct game database.
- The Suite can install or update the standalone AlphaNine Market Bot service from the Market Bot page.

## Install or Update the Bot

1. Open `Market Bot` from the left sidebar.
2. Select `Install / Update Bot`.
3. Confirm the prompt and wait for the install result.
4. Select `Refresh Bot`.
5. Review the editable config.
6. Check `Bot Enabled` when you are ready for scheduled activity.
7. Select `Save Bot Config`.

The install action uploads the bundled Market Bot binary and item data to the VM, applies the Kubernetes service, creates the API token, and connects it to the selected battlegroup database.

The bot installs with scheduled activity disabled by default. Manual buttons still work after the bot is online.

## Connect the Bot

Most users do not need to enter an API token manually. Suite creates and saves it during install.

Use `Save Connection` only if you need to point Suite at a custom bot URL or an already-deployed bot.

If the page says the Market Bot pod was not found, select `Install / Update Bot`.

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
- `Market Bot pod not found`: Select `Install / Update Bot`.
- `fetch failed`: Usually a network, URL, or service reachability problem. Suite will try the VM fallback automatically when possible.
- Listings do not disappear after buyer simulation: Refresh the Market Bot page and check that simulation is enabled.
- Too many items appear: Increase `LIST_INTERVAL`, reduce `SIM_INTENSITY`, and manually remove selected NPC listings.
- No automatic activity: Confirm `Bot Enabled` is checked. Manual buttons still work even when scheduled bot activity is disabled.
