# AlphaNine Dune Suite 1.0.33

Market activity and listings-table update for a clearer, more dynamic private-server economy.

## Market Buyer Cycle

- Renames **Buy Player Listings** to **Run Buyer Cycle** so the action matches its full behavior.
- Continues buying eligible player listings and creating normal Solari claims for their sellers.
- Simulates demand for NPC stock by removing 1-2 random bot-owned listings during every buyer cycle.
- Keeps player payments and NPC turnover separate: simulated NPC sales never create payments or debit Solari.
- Adds an **NPC Listings Sold** runtime counter and clear action results after manual cycles.
- Applies the same behavior automatically according to `BUY_TIMER`.

## Improved Listings Table

- Replaces the compact listing rows with a bordered, column-based market table.
- Adds dedicated columns for item, grade, tier, stack, seller/type, price, expiration, and actions.
- Gives item names and templates more room while keeping controls easy to scan.
- Shows readable remaining expiration such as `2d 6h remaining` using the server's game clock.
- Highlights expired entries and preserves usability on smaller windows with horizontal scrolling.

## After Updating

1. Open **Market Bot** and select **Install / Update Bot** once to deploy the updated bundled service to the VM.
2. Select **Run Buyer Cycle** to test it immediately.
3. Confirm the NPC listing count drops by 1-2 and **NPC Listings Sold** increases.
4. Player listings that meet the configured pricing rules will still be purchased and paid normally.
