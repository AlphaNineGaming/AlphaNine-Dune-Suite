# AlphaNine Dune Suite v1.2.8

## A cleaner Progression Inspector

Choose from four dedicated section buttons: **Progression**, **Skills**, **House Scrip**, and **Dungeon Difficulties**. Player Lookup stays shared, and only the selected section is displayed. Progression opens by default.

## New: experimental dungeon difficulty unlocks

Server owners can now test changing a player's dungeon unlock range through saved completion records. The editor accepts a maximum selectable difficulty from **3 to 30**; it does not choose the active run or grant loot.

**Scan Installed Game** reads dungeon identifiers from the local `Dungeons.pak` without modifying game files or requiring a first completion. The tested game build yielded five numbered laboratory dungeons and the Pit. Demo/test assets are excluded.

Results distinguish **Database verified** IDs matched to server history from **Game asset** IDs found only in the installed files. Game-asset IDs are candidates for testing, not confirmed database mappings or guaranteed unlocks. Existing server IDs and manual ID entry remain available.

## How to use it

1. Enable **Progression Editing** in Settings and have the selected player log out.
2. Open **Progression Inspector**, look up the player, and choose **Dungeon Difficulties**.
3. Choose an ID from server history, or click **Scan Installed Game** and then **Use ID**. Scanning requires a supported local game installation on the Suite computer.
4. Enter the desired maximum selectable difficulty and create a preview. The Suite creates a verified full database backup and an exact affected-row snapshot.
5. Review the planned changes, type `APPLY DUNGEON EXPERIMENT`, and apply while the player remains offline.
6. Have the player log back in and check the in-game difficulty slider. Select the actual run difficulty in the game.

## What changes behind the scenes?

The experiment assumes that completing difficulty **N - 1** unlocks difficulty **N**. For example, requesting **10** creates a saved difficulty **9** completion if needed. Synthetic completions use a deliberately poor duration, but can still affect completion statistics and best-run displays.

Lowering the target removes the selected player's completion links above the required level while preserving other party members' links. Setting **3** clears that player's completion links for the selected dungeon to test the base range.

## Safeguards and testing limits

Previews expire after 15 minutes. Apply rechecks player status and completion history, rejects stale previews, writes in one transaction, and reads back the saved result.

**This feature is experimental.** Database read-back confirms the saved records, not the game's response. Live in-game unlocking has not been validated for this release. The value **30** is the Suite's experimental test limit, not a verified official game maximum. Test on a backed-up server and report the dungeon ID, target, and observed slider result.

## Upgrade

Install **AlphaNine-Dune-Suite-Setup-1.2.8.exe** over your existing installation. Existing configuration and user data are retained; keep your normal backups.
