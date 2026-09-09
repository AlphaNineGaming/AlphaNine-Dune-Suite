# AlphaNine Dune Suite v1.2.4

## Installed-game item catalog

- Added an offline catalog generator that reads authoritative item rows from the user's installed Dune: Awakening `Systems.pak`.
- Included 3,566 locally discovered item templates from 20 base-item tables, including 1,282 physical schematics.
- Added the missing Spitting Cobra schematic: `B1C4_Unique_SMG2_Schematic`.
- Item Database and Give Item now use the same merged source, with 4,288 unique entries in the catalog generated for this release.
- Added **Item Database → Scan Installed Game** so administrators can refresh the catalog after a game update without a wiki or internet item service.
- No game textures, models, or other game assets are retained. The scan stores template identifiers and catalog metadata only.

## Cleaner catalog organization

- Deduplicated item identifiers case-insensitively before they reach the UI.
- Normalized category spelling and singular/plural variants into stable menu filters.
- Kept schematic items, recipe-only unlocks, and research unlocks in their correct grant paths.
- Added regression coverage for catalog uniqueness, category menus, offline loading, and schematic routing.

## Clearer Give Item durability

- Replaced the easy-to-miss durability checkbox with an always-visible **Item Condition** card.
- Durable items now show **Optional — OFF** until full durability is selected.
- Selecting the option clearly changes the state to **200 / 200 ON**.
- Non-durable items show **Not available** with an explanation instead of hiding the control.
- The UI explains that full durability writes both current and maximum durability as 200 and may require a player relog.
- Installed-game clothing and armor are now correctly recognized as durability-capable.

## Verification

- Installed-game catalog extraction and uniqueness tests passed.
- Give Item durability schema, eligibility, transaction, receipt, and read-back tests passed.
- Schematic routing and rendered UI syntax tests passed.
- Windows installer packaging and packaged resource-area tests passed.

## Upgrade

Install v1.2.4 over the existing Suite installation. Existing configuration and locally learned catalog records remain in the Suite data directory.
