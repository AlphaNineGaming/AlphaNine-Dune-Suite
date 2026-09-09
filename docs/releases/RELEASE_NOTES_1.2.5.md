# AlphaNine Dune Suite v1.2.5

This release repairs Market Bot purchases of real player listings on private servers such as HarkoVillage.

## Player-listing universe clock

- Market Bot preview and purchase execution now derive the current Exchange time from the server's authoritative `dune.farm_variables` universe clock.
- The calculation includes the persisted downtime offset used by Dune's universe timeline.
- The previous comparison between universe-relative listing expirations and the Unix epoch has been removed. That mismatch incorrectly classified every real player listing as expired.
- The database wall clock remains a fail-safe fallback if the authoritative universe row is unavailable.

## Runtime and verification

- Updated the bundled Market Bot runtime from 1.0.100 to 1.0.101.
- Added regression checks for the authoritative clock source, downtime offset, diagnostic clock label, and removal of the Unix-versus-universe comparison.
- Existing player-buying limits remain unchanged: opt-in enablement, purchase chance, maximum purchases, maximum unit price, and maximum spend per cycle.

## Upgrade

Install v1.2.5 over the existing Suite installation, then use **Repair Runtime** if the Market Bot page reports an older installed runtime. Existing configuration and listings are preserved.
