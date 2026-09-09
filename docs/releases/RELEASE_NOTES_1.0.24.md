# AlphaNine Dune Suite 1.0.24

Live Market controls polish for admins.

## What's Changed

- Player market listings now clearly show `Buy & Pay`.
- Player listings also keep a separate `Remove` action for admin cleanup.
- NPC/manual listings show `Remove` without a confusing buy action.
- Every live market row now has a checkbox.
- `Select Visible` now selects all visible listings, not only NPC/manual listings.
- `Remove Selected` can remove any selected market listing from Suite.
- Backend listing removal now supports all market listing types.

## Notes

- `Buy & Pay` is only for player listings because it removes the listing and creates the seller payout.
- `Remove` only deletes the listing and does not create a seller payout.
