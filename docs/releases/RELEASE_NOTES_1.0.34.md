# AlphaNine Dune Suite 1.0.34

Server Cleaner update adding a guarded administrator override for owned player bases.

## Owned-Base Deletion

- Keeps the existing orphan-base cleanup behavior unchanged.
- Adds an optional **Enable owned-base deletion** control to Server Cleaner.
- Allows administrators to remove a base even when its owner still exists in `dune.player_state`.
- Supports bases classified as **Owned** or **Partial missing**.
- Keeps **Unknown owner** bases protected because ownership cannot be verified safely.

## Safety

- Requires actor-specific typed confirmation in the form `DELETE BASE <actor ID>`.
- Blocks the override when any matched owner is reported online.
- Rechecks ownership, player matching, and online state in the backend immediately before deletion.
- Shows a final destructive-action confirmation containing the base actor and affected instance count.
- Records owned-base deletions separately as `owned_base_override_deleted` in `admin-audit.log`.
- Preserves the original orphan-only backend rule when the override is not explicitly enabled.

## How To Use

1. Open **Server Cleaner** and select **Scan Bases**.
2. Confirm the target base is shown as **Owned** or **Partial missing** and that its player is offline.
3. Enable **Owned-base deletion**.
4. Enter the exact confirmation displayed by the base actor, such as `DELETE BASE 123`.
5. Select **Delete Owned Base** and approve the final confirmation.

Base deletion is permanent. Create a server backup before using the owned-base override.
