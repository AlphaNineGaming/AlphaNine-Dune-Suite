# Recover Character to Hagga Basin

In **Players**, select an offline player, choose **Recover Character**, and confirm
**Recover to Hagga Basin**. The Suite resolves the player's existing authoritative
PlayerCharacter across maps. The administrator does not enter destination fields.

If recovery is blocked, choose **Inspect Travel State** in the recovery panel.
It shows the linked pawn's map and state using a read-only transaction, even when
the pawn is in Travel or its linkage is missing/ambiguous. **Export Diagnostics**
downloads one JSON report for investigation, with actor/linkage and travel-routing
metadata and relevant vendor function definitions. No manual SQL is needed.
Inspection creates no recovery confirmation and never calls the movement function.
It is local-only and excludes inventory/progression payloads, credentials and FLS
identifiers. Travel state is not reset or repaired by this inspection.

Recovery uses `dune.admin_move_offline_player_to_partition`, passing the original
FLS identifier, an existing validated Hagga partition, and exact safe coordinates.
There is no direct actor UPDATE, character creation, ID reassignment or travel
cleanup in the recovery implementation.

The existing full safety-backup policy applies: the battlegroup/game workloads must
be stopped, persistent writers must be clear, and an installed Market Bot must be
authoritatively quiescent. Recovery reports a blocking error instead of stopping
services or bypassing these checks.

Automatic destination discovery uses a genuine enabled Hagga preset saved from an
online player's confirmed safe position, its matching Suite audit event, and a
currently matching authoritative pawn/partition. It validates map bounds,
ownership, actor state, partition/dimension, and compatible home/return/login
dimensions. It prefers the newest corroborated safe preset. Missing, stale or
ambiguous safe evidence blocks recovery. The bundled example is never a fallback.
No installation-specific partition, dimension or coordinates are release constants.

The implementation recognizes the current investigated vendor movement routine and
dependencies by normalized definition fingerprints and validates actor storage.
An unknown game/database revision blocks recovery pending inspection. The supported
schema stores actor travel state in `dune.actors.state`.

Before movement the Suite creates and verifies a full database backup, rechecks the
player/destination, and saves a verified before-state journal scoped to the database
cluster and battlegroup. Its own PostgreSQL transaction locks the relevant records,
calls the vendor function, and compares the resulting map, partition, dimension,
exact location, rotation, identity, ownership and protected pawn data before commit.
Account/character linkage, controller/state actors, inventory/items and existing
travel records are also compared. Unrelated fields are never assigned by this path.

Any pre-commit error aborts the transaction. A fresh connection performs final
read-back after commit. A failed or uncertain commit/read-back is recorded as
unverified and cannot reuse its confirmation. Reopening recovery reconciles the
captured before/expected-after state without executing movement. Divergent state
blocks a retry and requires controlled recovery from the saved evidence/backup.
An ordinary rollback cannot undo an already committed recovery.

Tests: `npm run test:character-recovery`. They use a transactional database model,
captured vendor-definition fixtures and Players UI harnesses. The feature's read-only
inspection was additionally checked against the current server; no live character
was moved during implementation verification.

Travel diagnostics also export the installed vendor login, full actor loading, save and travel-state helper definitions. These are definitions only; inspection never invokes those routines. Their presence does not authorize travel finalization or prove login succeeds.

Isolated Travel pawns are eligible for protected relocation on the verified loader schema. The Suite checks the installed load_full_actors definition and requires the controller/PlayerState to remain Default, no linked travel-parent records and no transfer import. Travel state is preserved and checked before commit and on fresh read-back; no travel-reset helper is invoked. Successful game login remains a subsequent player test.

Explicit manual recovery: open Use coordinates instead, enter X/Y/Z or copy the Live Map fields, acknowledge the unverified landing height and preview. The local-only API resolves exactly one canonical Hagga partition in compatible character dimensions. Confirmation names the player and coordinates and explicitly states that offline recovery does not resolve safe ground. Coordinates are bound to the single-use preview; the execution request cannot replace them. Manual mode never runs automatically when safe destination discovery fails, and its source/verifiedSafe=false are captured in the before-state journal and audit destination. All backup, offline, preservation and transaction checks still apply.
