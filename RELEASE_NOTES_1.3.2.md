# AlphaNine Dune Suite v1.3.2

## Dungeon selection made clearer

- Replaced the confusing autocomplete field with a proper dungeon dropdown. Open it to see all known IDs—no need to erase the current name first.
- Combines saved server IDs and installed-game scan results in one sorted list, without duplicates.
- Removed automatic dungeon selection. Choose the dungeon you want to edit.
- Added a separate **Enter an exact dungeon ID manually** option.
- Keeps scanned IDs and your selected dungeon when refreshing history.

## Better feedback while working

- Added visible preview/backup and apply messages with elapsed time while waiting for the server.
- Explains that creating and verifying a full database backup can take several minutes.
- Disables dungeon controls during preview/apply to prevent duplicate clicks and changes mid-request.
- Shows when the unlock was applied and verified, including a separate warning if the subsequent history refresh fails.
- Warns that a timeout does not prove nothing changed. Refresh history before retrying an uncertain apply.

## How to use it

- Open **Progression Inspector → Dungeon Difficulties**, look up the player, and refresh history.
- Choose a dungeon from the dropdown. Use **Scan Installed Game** to discover additional IDs from locally available game assets, or choose manual entry if you know the exact ID.
- Keep the player offline, set the maximum selectable difficulty, generate the preview and verified backup, review the log, then type **APPLY DUNGEON EXPERIMENT** to apply.

## Important

- The dropdown lists IDs known to the connected database or installed-game scan—not necessarily every dungeon in the game.
- Dungeon editing remains **experimental**. It changes saved difficulty unlock history, not an active run, and does not grant loot. Keep a recoverable backup and test in-game.
- This update improves selection and feedback; it does not make database backups faster or change the dungeon write algorithm.
- Dungeon logic, catalog, selector behavior, and rendered UI syntax checks passed. Live database/in-game testing remains unverified. Full Windows update-integrity validation is limited by the previously observed PowerShell Security module loading issue.
- Includes the UserGame Settings preservation and recovery improvements from 1.3.1. Market Bot remains **1.0.102**.

Close the Suite before installing **AlphaNine-Dune-Suite-Setup-1.3.2.exe** over your existing installation.
