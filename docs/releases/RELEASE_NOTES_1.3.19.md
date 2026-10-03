# AlphaNine Dune Suite 1.3.19 — Recover Travelling Characters

**Recover Character → Recover to Hagga Basin** now supports an offline character stored in Arrakeen, Harko Village or another map with an isolated Travel state, on the verified database schema.

Recovery uses the existing vendor movement function and preserves Travel state, rotation, character/account IDs, ownership, inventory, equipment and progression. It does not call a travel-reset helper or alter PlayerController, PlayerState, travel or migration records.

The Suite still requires the server stopped, the player offline, one authoritative pawn, a verified safe Hagga destination and a verified safety backup. The move runs inside a recovery-owned transaction and is checked before commit and again through a fresh connection. Pre-commit failures roll back. Uncertain commit/read-back outcomes are recorded for reconciliation rather than reported as rolled back.

Travel-linked actors, migration imports, unsupported actor states and changed loader definitions remain blocked. A successful database recovery means the player can attempt login; successful game login has not been tested by this release.

Update to **AlphaNine-Dune-Suite-Setup-1.3.19.exe**, then use **Players → select player → Recover Character → Recover to Hagga Basin**.

Validation: 73 recovery/diagnostic regressions, Live Map selection tests, rendered UI syntax, read-only live schema checks, update integrity and packaged-runtime checks.
