# AlphaNine Dune Suite Market Bot Guide

This guide explains what the AlphaNine Market Bot does, how to install it, how to configure it, and how to operate it from AlphaNine Dune Suite.

## What The Market Bot Does

The Market Bot keeps the in-game exchange active on small or private servers where there are not enough real players to create a healthy economy.

It can:

- Add NPC sell listings to the market.
- Buy real player listings when they are fairly priced.
- Simulate buyer demand so NPC/manual listings can sell over time.
- Let admins manually add specific market listings.
- Let admins buy or remove selected listings from Suite.
- Keep prices and demand moving without needing a large player population.

The bot is meant to make the market feel alive, not flood it with unlimited items. The default settings are intentionally conservative.

## How It Runs

The Market Bot is a standalone service installed on the server VM by Suite.

Suite installs it as a Kubernetes deployment:

- Namespace: `dune-market-bot`
- Deployment: `market-bot`
- Service: `market-bot`
- VM files: `/opt/market-bot/`
- API port: `8081`

After it is installed, the bot runs inside the VM. Suite is needed to install, configure, monitor, and manually control it. Scheduled bot activity runs from the VM service while the VM and bot pod are running.

## What Suite Installs

When you click `Install / Update Bot`, Suite:

1. Connects to the configured VM over SSH.
2. Creates `/opt/market-bot/bin`, `/opt/market-bot/data`, and `/opt/market-bot/cache`.
3. Uploads the bundled Linux bot binary to `/opt/market-bot/bin/market-bot`.
4. Uploads item data to `/opt/market-bot/data/item-data.json`.
5. Detects the active game database service.
6. Creates or updates the bot Kubernetes ConfigMap and Secret.
7. Creates the API token automatically.
8. Applies the Kubernetes manifest.
9. Restarts the `market-bot` deployment.
10. Waits for the bot pod to become ready.

Users normally do not need to install anything manually on the VM.

## Uninstalling The Bot

Use `Uninstall Bot` when you want to remove the Market Bot service from the VM.

Suite removes:

- The `market-bot` Kubernetes deployment.
- The `market-bot` Kubernetes service.
- The bot ConfigMap and Secret.
- The `dune-market-bot` namespace.
- The VM files under `/opt/market-bot/`.
- The saved Suite bot API token.

Uninstalling the bot does not delete existing in-game market listings. To remove listings, use `Live Market Listings` and remove selected rows from Suite.

## API Token

The API token is the shared secret Suite uses to control the Market Bot API.

Most users should leave the API token field blank.

Suite automatically:

- Generates the token.
- Saves it in the Suite config.
- Writes it to the VM Kubernetes secret named `market-bot-secret`.
- Reuses the saved token on later updates.

Use the API token field only when connecting Suite to a custom or already-installed bot service.

## First-Time Setup

1. Open AlphaNine Dune Suite.
2. Make sure the VM is online and reachable.
3. Make sure Suite has detected or selected the correct battlegroup/database.
4. Open `Market Bot` from the left sidebar.
5. Click `Install / Update Bot`.
6. Wait until the install result says the deployment is ready.
7. Click `Refresh Bot`.
8. Review the runtime and editable config.
9. Enable `Bot Enabled` only when you are ready for automatic scheduled activity.
10. Click `Save Bot Config`.

Manual buttons can be used after the bot is online, even if automatic scheduled activity is disabled.

## Main Page Sections

### Bot API

Shows whether Suite can reach the bot API.

Common states:

- `Online`: Suite can reach the bot.
- `Offline`: Suite cannot reach the bot directly.
- `Partial connection`: Suite reached some endpoints but not all, or had to use a VM fallback.

### NPC Listings

Shows how many bot/NPC listings exist and when the bot last restocked.

### Player Buys

Shows how many player listings the bot has bought and when the last buy cycle ran.

### Simulation

Shows whether simulated buyer demand is ready, running, or disabled.

### Runtime

Shows live bot counters, including uptime, Solari balance, simulation orders, and simulation units.

### Editable Bot Config

Controls the bot scheduler and economy behavior.

### Manual Listing Tools

Lets admins add a specific item listing manually.

### Live Market Listings

Shows market rows and allows selecting, buying, or removing listings.

## Economy Control Buttons

These buttons run immediately. They do not wait for the configured interval.

### Buy Player Listings

The bot scans player listings and buys a small number of listings that pass its pricing checks.

Use this when:

- Players listed items and you want the bot to create demand.
- You want to test buying without waiting for `BUY_INTERVAL`.

Default behavior is conservative, usually around 1 to 2 buys per cycle depending on available listings and config.

### Restock Market

The bot adds random NPC sell listings.

Use this when:

- The market is empty.
- You want to add a small amount of supply immediately.
- You are testing whether listings appear in the game.

The bot is tuned to add a small random batch rather than flooding the market.

### Simulate Buyers

The bot simulates player demand against market listings.

Use this when:

- NPC listings are sitting too long.
- You want the economy to move even without real players buying.
- You want to reduce market clutter naturally.

### Run Full Cycle

Runs buy, restock, and simulation together.

Use this for testing or for a quick manual economy pass. For normal use, let the scheduler handle the cycles after the bot is configured.

## Important Settings

Intervals use Go duration format.

Examples:

- `30s` = 30 seconds
- `5m` = 5 minutes
- `20m` = 20 minutes
- `2h` = 2 hours

Do not enter plain numbers for interval fields unless the UI specifically expects a number. Use duration suffixes such as `m` or `h`.

| Setting | What it controls | Recommended private-server value |
| --- | --- | --- |
| `Bot Enabled` | Turns automatic scheduled bot cycles on or off. | Off until tested, then On |
| `Simulation Enabled` | Enables simulated buyer demand. | On |
| `BUY_INTERVAL` | How often the bot checks player listings to buy. | `20m` |
| `LIST_INTERVAL` | How often the bot restocks NPC market listings. | `2h` |
| `SIM_INTERVAL` | How often simulated buyers run. | `10m` |
| `SIM_HOUSEHOLDS` | Size of the simulated buyer population. Higher means more demand attempts. | `10` to `80` |
| `SIM_MAX_ORDERS` | Maximum simulated purchases/orders per simulation tick. | `40` to `120` |
| `SIM_INTENSITY` | Demand strength multiplier. Higher means more aggressive simulated buying. | `0.35` to `1.0` |

Some internal settings may also exist in the bot config:

| Setting | What it does |
| --- | --- |
| `MAX_BUYS` | Maximum player listings the bot may buy in one buy cycle. |
| `LISTINGS_PER_GRADE` | How many listings the bot can create per grade/category pass. |

## Recommended Configs

### Quiet Friend Server

Use this when there are only a few players and you want the market to move slowly.

- `Bot Enabled`: On
- `Simulation Enabled`: On
- `BUY_INTERVAL`: `20m`
- `LIST_INTERVAL`: `2h`
- `SIM_INTERVAL`: `10m`
- `SIM_HOUSEHOLDS`: `10`
- `SIM_MAX_ORDERS`: `40`
- `SIM_INTENSITY`: `0.35`

### Medium Private Server

Use this when there are regular players but not enough trading activity.

- `Bot Enabled`: On
- `Simulation Enabled`: On
- `BUY_INTERVAL`: `10m`
- `LIST_INTERVAL`: `1h`
- `SIM_INTERVAL`: `10m`
- `SIM_HOUSEHOLDS`: `40`
- `SIM_MAX_ORDERS`: `80`
- `SIM_INTENSITY`: `0.6`

### Testing Only

Use this only while checking that the bot works.

- Keep `Bot Enabled` off.
- Use `Restock Market` once.
- Check the in-game exchange.
- Use `Simulate Buyers` once.
- Refresh Suite and confirm counts changed.

Avoid very short intervals for normal use. They can make the market noisy and harder to review.

## Manual Listings

Manual listings let an admin add a specific item instead of waiting for random restock.

Typical flow:

1. Open the manual listing section.
2. Search for or select an item.
3. Choose grade, tier, stack size, price, and expiration.
4. Click the add/list button.
5. Refresh market listings.
6. Confirm the listing appears in Suite or in game.

Manual listing expiration should use the same day choices players see in game:

- `1` day
- `3` days
- `7` days
- `14` days

Bot random listings can use randomized expiration based on the supported day range. Manual listings should be explicit so admins know exactly how long the listing will stay.

## Buying And Removing Listings

The Live Market Listings section supports listing management.

You can:

- Select multiple rows with checkboxes.
- Remove selected NPC/manual listings at once.
- Remove a single NPC/manual listing.
- Buy a player listing through the bot.
- Fold the result panel when you do not need to see the latest API response.

Important behavior:

- NPC/manual listings can be removed directly.
- Player listings should be bought, not deleted, so player sale behavior stays closer to normal market behavior.
- When Suite buys a player listing, it removes the listing and creates the seller Solari payout record.
- The Suite buy/remove buttons work from the live listing table and do not require the bot API to be reachable.
- Removing listings is for cleanup and admin control, not normal economy simulation.

## Bot Actor ID

The bot uses a database actor as the owner/seller identity for its market activity.

The log may show something like:

`bot actor id: 1056 (Revy)`

This means:

- `1056` is the database actor ID on that server.
- `Revy` is the actor class the bot is using.
- The ID can be different on every server.
- It is not a real online player action.

## Does Updating Suite Delete Listings?

Installing a Suite update does not intentionally delete market listings.

Market listings can disappear when:

- They expire naturally.
- They are bought by players.
- They are bought by simulated buyers.
- An admin removes them from Suite.
- A database restore/import rolls back the market state.
- A cleanup action is run manually.

The Suite installer/update process itself should not clear the market.

## How Automatic Scheduling Works

When `Bot Enabled` is on, the VM bot service checks its schedule and runs cycles based on the configured intervals.

- `BUY_INTERVAL` controls automatic player listing buys.
- `LIST_INTERVAL` controls automatic NPC restocks.
- `SIM_INTERVAL` controls simulated buyer demand.

The scheduler reads live config, so changes apply on the next scheduler check after saving config.

Manual buttons ignore the interval timer and run immediately.

## Keeping The Market Small

If the bot is adding too many listings:

- Increase `LIST_INTERVAL`.
- Keep `SIM_INTENSITY` low.
- Lower `SIM_MAX_ORDERS` if simulation is too aggressive.
- Use `Remove Selected` to clean old NPC/manual listings.
- Avoid repeatedly pressing `Run Full Cycle` unless testing.

For most private servers, start slow and increase only if the market feels empty.

## Troubleshooting

### Bot API Offline

Check:

- VM is running.
- Suite VM settings are correct.
- SSH is reachable.
- The bot was installed with `Install / Update Bot`.
- Port `8081` is reachable or Suite can use the VM fallback.

### Market Bot Pod Not Found

The bot Kubernetes deployment is missing.

Fix:

1. Open Market Bot.
2. Click `Install / Update Bot`.
3. Wait for the install result.
4. Click `Refresh Bot`.

### Token Not Configured

The bot API health endpoint answered, but authenticated endpoints failed.

Fix:

1. Leave the API token field blank.
2. Click `Install / Update Bot` again.
3. Suite will generate and apply the token.
4. Click `Refresh Bot`.

### Timed Out Waiting For Condition

The Kubernetes pod did not become ready before the timeout.

Look at the full install result. Newer Suite versions include pod status, service endpoints, pod describe output, and recent logs.

Common causes:

- Bad or missing bot binary.
- Database connection failure.
- Missing Kubernetes secret/config value.
- VM cannot mount `/opt/market-bot` files.
- Bot process starts and exits because config is invalid.

### Exec Format Error

If logs show:

`exec /app/market-bot: exec format error`

The VM tried to run a bot binary built for the wrong platform.

Fix:

1. Update Suite to a version with the corrected Linux bot binary.
2. Click `Install / Update Bot` again.
3. Wait for the pod to become ready.

### Listings Do Not Show In Game

Check:

- The bot page shows Online.
- `Restock Market` completed successfully.
- The selected in-game exchange/category matches the item category.
- The game UI was refreshed or reopened.
- You are checking the same battlegroup database Suite is connected to.

### Simulate Buyers Runs But Listings Stay The Same

Possible reasons:

- Simulation is disabled.
- `SIM_INTENSITY` is too low.
- `SIM_MAX_ORDERS` is too low.
- Listings are priced above what simulated demand will buy.
- You need to refresh the market list after the action.

### Too Many Listings

Fix:

- Set `LIST_INTERVAL` to `2h` or longer.
- Lower `SIM_INTENSITY` to `0.35`.
- Avoid repeated manual `Restock Market` or `Run Full Cycle` clicks.
- Use checkboxes and `Remove Selected` to clean up.

## Safe Operating Workflow

For a new server:

1. Install/update the bot.
2. Keep `Bot Enabled` off.
3. Run `Restock Market` once.
4. Confirm listings appear in game.
5. Run `Simulate Buyers` once.
6. Confirm some activity changes in Suite.
7. Turn on `Bot Enabled`.
8. Save config.
9. Let it run for a few hours before increasing intensity.

## Support Checklist

When reporting a Market Bot issue, include:

- Suite version.
- Whether the VM is local or remote.
- Screenshot or text of the Market Bot connection result.
- Output from `View Bot Logs` if available.
- Whether `Install / Update Bot` completed.
- Current values for `BUY_INTERVAL`, `LIST_INTERVAL`, `SIM_INTERVAL`, `SIM_HOUSEHOLDS`, `SIM_MAX_ORDERS`, and `SIM_INTENSITY`.
- What button was clicked before the issue appeared.

## Quick Defaults

Good starting defaults for most small private servers:

- `BUY_INTERVAL`: `20m`
- `LIST_INTERVAL`: `2h`
- `SIM_INTERVAL`: `10m`
- `SIM_HOUSEHOLDS`: `10`
- `SIM_MAX_ORDERS`: `40`
- `SIM_INTENSITY`: `0.35`

Start conservative. Increase only when the market feels too empty.
