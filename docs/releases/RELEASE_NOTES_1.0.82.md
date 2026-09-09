# AlphaNine Dune Suite 1.0.82

## Reliable storage deposits — without restarting the VM

This release makes **Give Item to Storage** safer and adds visibility diagnostics for the frustrating case where an item is present in PostgreSQL but has not appeared in-game yet.

### What’s new

- **Safer slot selection:** new stacks use the lowest valid empty storage positions instead of extending beyond a finite container when earlier slots are available.
- **Verified deposits:** allocation, creation, quantity checks, duplicate detection, and database read-back now happen in one transaction. A failed verification rolls the entire deposit back.
- **Automatic rechecks:** after a successful grant, the Suite checks the exact deposited rows again after 2, 5, 15, and 30 seconds—without ever granting the item twice.
- **Persistent receipts:** every storage deposit records its target, item IDs, positions, player context, map, and verification state so the result can be diagnosed later.
- **Clear visibility status:** the Suite distinguishes “confirmed in the database” from “confirmed visible in-game” and warns if the running server changes or removes the deposited rows.
- **Three useful controls:** **Recheck Database**, **Confirm Visible In Game**, and **Protected Battlegroup Refresh** are now available in Give Item.

### What the admin needs to do

Usually, nothing—the verification checks run automatically. If a player still cannot see the item:

1. Click **Recheck Database**.
2. If the item is still verified in PostgreSQL, click **Protected Battlegroup Refresh**.
3. Ask the player to close and reopen storage or reconnect, then use **Confirm Visible In Game** once it appears.

The protected refresh reuses the Suite’s existing safety gates: it blocks while players are online, requires a verified backup, targets only the exact battlegroup, and performs post-start health checks. It does **not** restart the Hyper-V VM or delete raw Kubernetes pods.

### Additional safeguards

- Deposits are blocked when a target container already contains duplicate or out-of-range occupied positions.
- A running game overwrite is reported rather than hidden behind a generic success message.
- Refresh attempts are tracked through the existing operation scheduler and audit flow.

## Verification

- Storage deposit, receipt persistence, and verification-classification regression tests passed.
- Storage names, rendered UI syntax, operation registry, VM scheduler, remote access, and server health regression suites passed.
- The packaged Windows application passed its isolated runtime smoke test as version 1.0.82.
- The packaged executable and installed app both retain the required administrator manifest.
