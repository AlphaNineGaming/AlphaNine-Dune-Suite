# AlphaNine Dune Suite 1.2.3

This release repairs the optional random player-listing buyer and updates its default purchase chance to 50% per Market Bot cycle.

## Player-listing buyer fixes

- Seller claim records now preserve the listing's per-unit price. Stacked listings no longer multiply the payout by the stack size twice when the seller takes their Solari.
- Seller claim records use the Exchange's non-expiring sentinel instead of an ordinary listing expiry, preventing unclaimed payouts from being purged before collection.
- A purchase now fails closed unless the dedicated Market Bot Exchange user exists and provides the debit path.
- New buyer configurations default to a 50% purchase chance per normal cycle. Existing saved configurations remain unchanged until the operator explicitly saves the new percentage.

## Runtime and verification

- Updated the bundled Market Bot runtime from 1.0.99 to 1.0.100 so installed servers detect and deploy the corrected transaction.
- Added regression checks for the per-unit payout, non-expiring seller claim, dedicated buyer debit, and 50% default.
- Player buying remains opt-in, capped by maximum purchases, maximum unit price, and maximum total spend per cycle.
