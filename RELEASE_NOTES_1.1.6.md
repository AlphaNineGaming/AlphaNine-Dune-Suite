# AlphaNine Dune Suite 1.1.6

This release fixes HarkoVillage selection in Market Automation.

- HarkoVillage is selectable when its native Exchange and access point exist but its saved Exchange inventory is missing.
- The first Harko selection transactionally links one existing Harko inventory or creates a new empty Exchange inventory.
- The resolved inventory is saved back to `HarkoVillage_EX` before the Market Bot preview or switch continues.
- Existing Exchange listings and player listings are not moved, removed, or modified.
- Multiple linked inventories, duplicate Exchange names, missing access points, and invalid cross-Exchange inventory links remain blocked.

