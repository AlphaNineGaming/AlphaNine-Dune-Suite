# AlphaNine Dune Suite 1.3.16 — Character Recovery

Bring an offline player's existing character back to a verified safe location in
Hagga Basin with a simple action in Players.

## New: Recover Character

- Open **Players**, select an offline player, choose **Recover Character**, then
  confirm **Recover to Hagga Basin**.
- Recovery finds the player's persistent character even when it is stored in
  Arrakeen, Harko Village or another map. The current map does not need to be loaded.
- The Suite automatically resolves a validated destination for your installation;
  administrators do not enter maps, partitions, dimensions or coordinates.
- Moves the existing character while preserving its IDs, ownership, rotation,
  inventory, equipment, progression and skills. It does not create a replacement
  character or remove controller, state or travel records.

## Protected recovery

- Requires the player to be offline and the server's game workloads to be stopped.
  An installed Market Bot must be paused with verified quiescence.
- Creates and verifies a full safety backup before moving the character.
- Verifies the destination and protected character data before committing. A failed
  pre-commit check rolls back the transaction.
- Performs a separate final read-back. An uncertain commit or failed final read-back
  is reported clearly and reconciled before a retry; a committed change is never
  presented as having been rolled back.
- Missing or ambiguous character, destination or safety evidence blocks recovery.

Safe destination discovery uses an enabled Hagga location previously saved from an
online player's confirmed safe position, its matching Suite audit event and a
currently matching persistent character/partition. Disabled example presets are
excluded. If that evidence is unavailable or stale, recovery stops without moving
the character. See the [Character Recovery guide](../character-recovery.md).

## Updating

Fully exit the Suite, install **AlphaNine-Dune-Suite-Setup-1.3.16.exe**, and reopen it.
After a successful recovery, the player can attempt to log in again.

## Validation

45 recovery regression tests cover success, cross-map resolution, rejection of
online or ambiguous players, destination and backup failures, function failures,
verification rollback, protected data preservation and the Players interface.
The destination resolver was also checked against the current server using
read-only queries; no live character was moved during development verification.
