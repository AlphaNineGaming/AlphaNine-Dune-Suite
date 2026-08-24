# AlphaNine Dune Suite 1.1.5

This release adds direct player backpack inventory management to the Players view.

- View the selected player's backpack contents, including item name, template, stack size, grade, durability, slot, and database item ID.
- Search the loaded backpack and refresh it on demand.
- Delete an individual item stack directly from the inventory table.
- Inventory lookups and deletes are scoped to the selected player's exact backpack and item ID.
- Blueprint-backed inventory items remove their linked blueprint records with the item.
- Deletion uses one standard confirmation dialog, with no backup, offline-player gate, preview, or typed confirmation.

