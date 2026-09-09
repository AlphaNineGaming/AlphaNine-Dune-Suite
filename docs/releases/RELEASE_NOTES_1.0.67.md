# AlphaNine Dune Suite 1.0.67

## Market Automator pricing

- Added Fixed and Dynamic pricing modes, configurable bounds and rounding, deterministic item/cycle variation, metadata multipliers, category bases, and exact per-item overrides.
- Dynamic preview and execution use the same production calculator and cycle-ID definition.
- Legacy single-price configurations migrate to Fixed mode with the original value preserved as `basePrice` and a review notice shown before Dynamic mode can be enabled.
- Enabled legacy Automators retain fixed-price behavior after upgrade.
- Existing market listings are never automatically repriced, removed, or reposted.
- Each new listing audit records its pricing mode, base source, metadata, factors, seeds, cycle ID, and final submitted price.

## Offline item catalog

- Made the bundled local item catalog authoritative for Item Database and Give Item without requiring an internet connection.
- Added bounded, read-only discovery of identifiers already present in selected-server inventories, storage, market listings, vehicle modules, and Landsraad rewards.
- Preserved bundled item records and local images while supporting server-discovered and manually entered raw identifiers.
- Removed runtime catalog dependence on gaming.tools and Awakening Wiki.

## Validation

- Added regression coverage for distinct item prices through configuration, planning, request generation, API validation, both database price columns, and display serialization.
- Added enabled and disabled legacy migration tests, deterministic-seed tests, pricing-bound tests, exact-override validation, and existing-listing preservation checks.
