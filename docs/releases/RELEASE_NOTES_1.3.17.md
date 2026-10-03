# AlphaNine Dune Suite 1.3.17 — Character Travel Diagnostics

Investigate a blocked character recovery directly through the Suite, without
running SQL or collecting database rows manually.

## New in Players

Select an offline player and open **Recover Character**:

- **Inspect Travel State** shows the current map, linked pawn ID and actor state.
- **Export Diagnostics** downloads one JSON report containing player/actor linkage,
  travel-routing metadata and the relevant vendor database function definitions.
- Inspection remains available when recovery is blocked by a Travel state, missing
  pawn or ambiguous character linkage. It runs in a read-only transaction, does not
  create a recovery confirmation and never invokes the movement function.
- Recovery errors now identify the exact pawn class, ownership, actor-ID or state
  mismatch instead of showing one generic identity error.

Diagnostics are available only in the local Suite. Reports omit inventory,
equipment, progression payloads, credentials and the original FLS identifier.

## Travel-state safety

This update collects evidence; it does not clear Travel state or move a blocked
character. The existing movement function does not clear Travel. Recovery remains
blocked until a supported reconciliation path has been established.

## Updating

Fully exit the Suite, install **AlphaNine-Dune-Suite-Setup-1.3.17.exe**, and reopen it.
For a blocked recovery, use **Inspect Travel State → Export Diagnostics** and share
the exported report for investigation.

## Validation

58 recovery/diagnostic regression tests cover protected movement, rollback,
read-only inspection of blocked characters, report export, stale-selection guards
and the local-only API boundary. The packaged-runtime release checks run these
tests against the built app as well.
