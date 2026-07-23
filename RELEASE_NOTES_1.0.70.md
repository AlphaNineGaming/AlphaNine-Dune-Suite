# AlphaNine Dune Suite 1.0.70

## Schematic Give Item routing

- Restored physical schematic templates, including `SandcrawlerSpiceContainer_Unique_Capacity_6_Schematic`, to the grade-0 Live Give inventory path.
- Stopped treating a template as a database recipe command merely because its identifier ends in `_Schematic`.
- Suppressed recipe-only catalog duplicates when a matching spawnable schematic item exists.
- Kept genuine recipe-only and Research unlock records available as explicit database-backed actions.

## Result and receiver handling

- Added success labels for `recipe-unlocked`, `research-unlocked`, and `already_unlocked`.
- Database-backed recipe and Research actions no longer require the Live Give receiver to be online.
- Result details now preserve both the primary success output and relog/reload guidance.

## Validation

- Added a regression test covering the Upgraded Regis Spice Container schematic and its similarly named recipe record.
- Passed schematic routing, offline item catalog, server discovery, and rendered Suite UI syntax tests.
