# AlphaNine Dune Suite 1.0.77

## Arrakeen Market Bot visibility

- Fixed bot-created listings existing in PostgreSQL but not appearing in Arrakeen's in-game Exchange categories.
- Market Bot now posts only items with verified category mask and depth metadata.
- Existing invisible zero-category listings owned and tracked by Market Bot are safely replaced during restock; player listings are never changed.
- Active and deficit totals now count only category-verified listings.
- Unknown category metadata fails closed and is reported as skipped instead of creating invisible stock.
- Exchange access points are resolved from live database rows rather than assuming an identifier.

## Verification

- Added category metadata, invisible-listing repair, and Exchange access-point regression coverage.
- Rebuilt the embedded Linux Market Bot runtime as version 1.0.77.
