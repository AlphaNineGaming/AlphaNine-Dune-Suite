# AlphaNine Dune Suite 1.0.31

Player administration update introducing protected character renaming directly from the Suite.

## Highlights

- Adds **Rename Player** to the selected-player actions on the Players page.
- Provides a preview step that confirms the character is offline and the requested name is available.
- Updates the authoritative encrypted character-name record using the game database's own encryption function.
- Preserves account IDs, Funcom identity, inventory, bases, guild membership, permissions, and progression records.
- Refreshes player tools and the Live Map after a successful rename.

## Safety

- Creates an encrypted player-state backup before Apply is enabled.
- Uses the exact active player-state row instead of targeting a character by name.
- Rechecks the old name, connection state, and duplicate-name status inside a locked database transaction.
- Rolls the transaction back automatically if the encrypted name cannot be verified.
- Uses a short-lived preview token and records preview, success, and failure events in the admin audit log.
- Handles uncertain network responses with a second database read-back to prevent unsafe repeat attempts.

## How To Use

1. Make sure the player is fully offline.
2. Open **Players** and select the character.
3. Click **Rename Player**, enter the new name, and select **Preview Rename**.
4. Review the result, then select **Apply Rename** and confirm.

The rename changes only the character's displayed name. It does not rename the player's account or Funcom identity.
