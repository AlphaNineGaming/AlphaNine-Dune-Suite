# AlphaNine Dune Suite 1.0.85

## Give Item durability

- Adds **Set Durability to 200** to the desktop and web Give Item surfaces.
- Applies exactly 200 current durability only to eligible weapons, armor, tools, and equipment.
- Clearly reports **Durability not applicable** for resources, consumables, schematics, cosmetics, and other non-durable items without fabricating durability data.
- Verifies durability transactionally and through database read-back, receipts, audit evidence, and delayed rechecks for player inventory and storage destinations.
- Rolls back the complete grant if durability or destination verification fails.

## Distribution change

- Removes Server Migration from the shipped UI and API surface.
- Excludes migration worker binaries and migration-only packaged tooling.
- Ignores legacy migration hold files so they cannot suppress normal Suite startup or block Give Item.

## Verification

- Covers eligible and non-durable items, storage and player destinations, rollback, read-back mismatch, and delayed verification.
- The packaged runtime is checked to ensure Server Migration is unavailable while Give Item durability remains present.
- The Windows installer is unsigned and may display an unknown-publisher or reputation warning.
