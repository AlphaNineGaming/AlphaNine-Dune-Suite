# AlphaNine Dune Suite v1.2.7

## Grade 1–5 Give Item compatibility

- Fixed database-backed player-inventory grants failing with `Player inventory contains invalid occupied slot positions` when the inventory also contains unrelated legacy or game-managed positions.
- Capacity checks now count the actual free normal slots available for the requested item stacks.
- Existing nonstandard rows are left untouched. The Suite allocates a different free slot for the new item.

## Transaction safety

- The database transaction still verifies every newly inserted row before commit.
- New rows must have the expected inventory, item template, quantity, grade, unique normal slot, and requested durability values.
- Delayed receipt checks continue to verify that the granted rows remain intact without repeating the grant.

## Upgrade

Install v1.2.7 over the existing Suite installation. Existing configuration, catalogs, receipts, and server data are preserved.
