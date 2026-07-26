# AlphaNine Dune Suite 1.0.78

## Arrakeen listing ownership compatibility

- Changed persistent Market Bot listings to use a clean native `Duke` NPC actor that Arrakeen can render.
- Added an idempotent upgrade migration that transfers only active AlphaNine-tracked listings from the former custom actor.
- Player listings and untracked NPC listings remain untouched.
- Retains the verified category masks, real Exchange access-point resolution, and accurate visible-stock totals introduced in 1.0.77.

## Verification

- Confirmed the 1.0.77 rows were returned by the live game `get_exchange_sell_orders` function, isolating the remaining problem to the custom owner actor.
- Added native-actor and tracked-only migration regression coverage.
