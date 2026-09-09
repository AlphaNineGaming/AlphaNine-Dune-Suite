# AlphaNine Dune Suite 1.0.86

## Give Item durability correction

- **Set Durability to 200** now grants eligible weapons, armor, tools, and equipment with exactly **200 current and 200 maximum durability**, matching the in-game `200 (200)` display.
- Writes the authoritative per-instance JSON-number fields `CurrentDurability` and `DecayedMaxDurability` inside the existing Give Item transaction.
- Verifies both values before commit and during database read-back, receipt evidence, audit evidence, and delayed rechecks for player-inventory and storage destinations.
- Rolls back the entire grant if either current or maximum durability is absent, non-numeric, or not exactly 200.
- Continues to write no durability fields for resources, consumables, schematics, cosmetics, and other non-durable items.

## Verification

- Adds regressions for maximum-durability encoding, current and maximum read-back mismatches, fabricated non-durable data, both destinations, transaction rollback, and delayed verification.
- The Windows packaged runtime is checked to ensure the corrected `200 (200)` implementation is included.
- No live Give Item operation was performed.
