# AlphaNine Dune Suite 1.0.32

Market Bot reliability update for new or empty server markets.

## Highlights

- Fixes the Market Bot crash and installation timeout when the game database does not yet contain a usable non-Global Exchange.
- Keeps the bot online in a clear **Waiting for Exchange** state instead of entering a restart loop.
- Retries Exchange discovery automatically every minute and begins normal operation as soon as the game creates the Exchange.
- Safely blocks buy, listing, and simulation writes until a valid Exchange is found.
- Adds a clear waiting status and guidance to the Market Bot page.
- Updates the bundled Linux Market Bot service and the user guide.

## After Updating

1. Open **Market Bot** and select **Install / Update Bot** once.
2. If the status is **Waiting for Exchange**, start the battlegroup and have a player open the in-game Exchange. Creating one ordinary player listing is the clearest initialization test.
3. Wait up to one minute, then select **Refresh Bot**.
4. Confirm the status is **Online** before restocking the market or enabling automatic cycles.

Do not repeatedly reinstall the bot while it is waiting. The bot is already healthy and will connect automatically when the game Exchange becomes available.
