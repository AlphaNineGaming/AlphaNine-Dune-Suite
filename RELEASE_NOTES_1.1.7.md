# AlphaNine Dune Suite 1.1.7

This release fixes player backpack item deletion failing with an SSH `Connection closed by host` error.

- Inventory delete transactions are now streamed securely over SSH instead of being placed on the SSH command line.
- Removed the broad inventory-row lock that could stall while the live game server was using the player's inventory.
- Database lock and statement timeouts now prevent an operation from hanging indefinitely.
- If the SSH response is interrupted after the database commits, the Suite verifies the inventory before reporting failure.
- Deletion remains scoped to the selected player's exact backpack and item ID.
