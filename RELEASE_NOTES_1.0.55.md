# AlphaNine Dune Suite 1.0.55

Version 1.0.55 adds a complete player-building blueprint workflow, an exact offline 3D viewer, granular progression grants, House Scrip management, and restored construction-set discovery.

## Player Building Blueprints

- Browse each player's saved building blueprints directly from the live server database.
- Import validated blueprint JSON files into the selected player's inventory as replicator items.
- Preview every selected JSON layout in 3D before importing it; no player data is changed during preview.
- Export one blueprint as JSON, export selected blueprints, or download every saved blueprint as a ZIP archive.
- Delete blueprints with explicit confirmation and associated inventory-item cleanup.
- Clear relog guidance explains when the player must reconnect before inventory changes appear.

## Exact Offline 3D Viewer

- Bundles 538 exact building-piece meshes and 551 blueprint mappings in the installer; no internet connection, external model folder, or extra download is required.
- Uses exported position, rotation, and scale transforms to reconstruct saved bases locally.
- Mouse controls provide orbit, tilt, pan, and wheel zoom; input remains captured by the viewer so zooming does not scroll the Suite page.
- Corrected transform and stair-orientation handling across mapped variants.
- Includes layer visibility for building pieces, placeables, and pentashields, plus reset, bounds, component counts, and unknown-piece reporting.
- Unknown identifiers are reported instead of being replaced with guessed geometry.

## Granular Skill Ranks

- Select an individual target rank for each supported skill instead of granting only a complete unlock.
- Rank costs are calculated only through the requested level.
- Existing higher ranks are preserved and never downgraded.
- Grants require the player to be offline and include an automatic backup, protected write, and read-back verification.

## House Scrip

- View the selected player's current House Scrip balance from Progression Inspector.
- Grant a specific amount using the detected game database currency function and its exact live argument types.
- Grants require the player to be offline, exact typed confirmation, an automatic backup, audit logging, and exact balance verification.
- The balance display now scales safely for large values.

## Item Catalog

- Restored Construction Sets in both Give Item and Item Database.
- Construction-set entries use the unified catalog and remain searchable alongside the rest of the item database.

## Reliability and Packaging

- Added regression coverage for blueprints, the exact model pack, construction sets, granular skill ranks, House Scrip, packaged UI content, and rendered JavaScript syntax.
- The packaged Windows application continues to request administrator access where required by local server-management operations.
- Version remains 1.0.55 for this release.

## Before You Start

- Fully close the Suite before installing the update.
- Skill-rank and House Scrip grants require the target player to be offline.
- A player may need to relog before blueprint inventory changes become visible in game.
