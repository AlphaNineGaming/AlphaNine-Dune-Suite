# AlphaNine Dune Suite v1.2.9

## Accurate market expiration times

- Fixed fresh 14-day player listings appearing to expire in roughly two days, and active listings incorrectly showing **Expired**.
- The Suite fetches game time from the connected server database at startup and on every listings refresh.
- Removed the extra downtime adjustment that pushed the calculated game clock ahead. No listing expiration records are rewritten.
- Removed the Unix-clock fallback. If the server game clock is unavailable, the Suite shows **Expiry unavailable** instead of guessing and blocks new listing creation.

## New: Buy & Pay for player listings

- Added **Buy & Pay** to eligible player listings in **Market Automation → Live In-Game Market Listings**.
- Purchase the entire listed stack with admin funding. No player buyer wallet is charged, and Market Bot does not need to be running.
- The seller receives a normal Solari payout to **claim in the game's Exchange**. This is not an instant wallet deposit.
- The purchased item and sell listing are removed permanently. The item is **not delivered to the Suite user**.
- Confirmation shows the item, quantity, unit price, total payout, and seller actor ID before any purchase is applied.

## Purchase safeguards

- Requires a fresh, one-use preview that expires after five minutes and is bound to the selected database.
- Rechecks the listing under database row locks and rejects changed, expired, empty, NPC, or already-purchased listings.
- Creates the payout and removes the listing/item in one transaction. A failed step rolls back the transaction.
- Prevents duplicate-click purchases and records the result in the admin audit log.
- Keeps stacked payouts correct by storing the per-unit price and purchased quantity separately.
- Limits each purchase to 999,999,999 Solari. Available to the local Suite user and remote **Owner**, not remote Viewer or Operator accounts.

## Market Bot 1.0.102

- Uses the same corrected server-clock calculation for listing expiry and player-buying eligibility.
- Waits without trading when the server game clock is unavailable.
- Existing purchase chance, cycle interval, purchase-count limits, and spending limits remain unchanged.

## Upgrade and first test

- Back up your server/database, close the Suite, and install **AlphaNine-Dune-Suite-Setup-1.2.9.exe** over your existing installation.
- Open **Market Automation**, refresh listings, and compare the same order with the in-game Exchange.
- Check the installed Market Bot version. If it still reports **1.0.101**, use **Repair Runtime** to update it to **1.0.102**.
- For Buy & Pay, review the confirmation carefully and only confirm a listing you intend to purchase. Purchases cannot be undone from this panel.
- The experimental dungeon tools from 1.2.8 remain included and unchanged; this release does not resolve their reported dungeon-schema or local game-folder detection issues.
