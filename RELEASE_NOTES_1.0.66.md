# AlphaNine Dune Suite 1.0.66

This release narrows Blueprint management to saved-layout listing, validated inventory import, and JSON/ZIP export.

## Blueprint management

- Lists each selected player's saved blueprints.
- Imports validated blueprint JSON into the selected player's inventory.
- Exports one blueprint as JSON.
- Exports selected blueprints.
- Exports all saved blueprints as a ZIP archive.

## Safety preserved

- Retains player selection and inventory-capacity checks.
- Retains input validation and protected database transactions.
- Retains relog guidance and blueprint audit records.

## Packaging

- Removes unused rendering dependencies, catalogs, assets, fixtures, tests, and package content.
- Keeps the existing independent market remediation intact.

## Market automation

- Empty template allowlists now rotate automatically through marketable items in the Suite's existing local catalog.
- An optional template allowlist can still restrict automation to administrator-selected items.
- Existing listing targets, per-cycle limits, stack size, price, grade, expiration, catalog validation, and disabled-by-default scheduling remain in place.
