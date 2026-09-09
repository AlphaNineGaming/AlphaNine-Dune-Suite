# AlphaNine Dune Suite v1.2.6

## Market Bot player buying repaired

- Market Bot preview and purchase cycles now read the authoritative Dune universe clock from `dune.farm_variables`.
- The calculation includes Dune's persisted downtime offset, keeping listing expiration checks aligned with the game server after restarts and downtime.
- Fixed the Unix-versus-universe timestamp mismatch that made valid player listings appear expired and caused the bot to skip them.
- The database wall clock remains a fail-safe fallback if the authoritative universe row is unavailable.

## Accurate Live Market Listings

- The Suite's Live Market Listings panel now uses the same Dune universe clock as the Market Bot runtime.
- Active listings display their real remaining lifetime instead of a false **Expired** status.
- Listing tracking remains read-only and continues to exclude claim records, fulfilled-order history, and empty item rows.

## Runtime and safety

- Updated the bundled Market Bot runtime to 1.0.101.
- Existing opt-in buying controls remain unchanged: purchase chance, maximum purchases per cycle, maximum unit price, and maximum total spend.
- Cleanup remains restricted to listings recorded in the Market Bot ownership table and never broadly removes player listings.

## Live verification

- Verified against a real HarkoVillage player weapon listing.
- The corrected runtime recognized the active listing using the `farm-variables` clock, purchased one item, and created the expected 5,000 Solari seller payout.
- Market Bot, HarkoVillage Exchange, Live Market Listings, rendered UI, update-integrity, and packaged-runtime tests passed.

## Upgrade

Install v1.2.6 over the existing Suite installation. Existing configuration, catalogs, and Exchange listings are preserved. If Market Bot shows an older installed runtime after upgrading, use **Repair Runtime** once to deploy runtime 1.0.101.
