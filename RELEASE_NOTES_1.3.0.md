# AlphaNine Dune Suite v1.3.0

## Experimental dungeon difficulty unlocks

- Fixed history loading being blocked solely because the expected dungeon recording function was not detected.
- Loads saved dungeon IDs and completion history directly from the connected server database. An installed-game scan is not required for IDs already recorded on that server.
- Adds a direct-record fallback when the recording function is unavailable and the database provides an identity/sequence-generated completion ID. Unsupported schemas remain blocked from writing.
- A player does not need a first completion if a valid dungeon ID is already available from server history or a successful installed-game scan.
- Uses bounded database lock waits and a transaction for changes. Preserves other players' completion links and leaves unrelated orphan records alone.

## How to use it

- Enable Progression Editing and open **Progression Inspector → Dungeon Difficulties**.
- Look up the player, ensure they are offline, and refresh history.
- Choose a saved server dungeon ID or an installed-game scan result, then enter the maximum selectable difficulty (experimental range: 3–30).
- Click **Generate Preview + Verified Backup** and review the planned changes. A verified full database backup is required.
- Type **APPLY DUNGEON EXPERIMENT**, apply the change, then log into the game and test the dungeon selector.

## Important limitations

- This edits saved completion history, not the difficulty of an active dungeon run. The player still chooses the active difficulty in-game.
- The experimental model treats 3 as the baseline; higher targets record a completion at target minus one. Setting 3 removes that player's links for the selected dungeon.
- Raising the unlock may create synthetic best-run statistics; lowering it may remove that player's higher completion links. No loot is granted.
- Values up to 30 are the Suite's experimental input range, not a guarantee that every dungeon supports every value.
- Missing local game assets still require configuring the installed-game scan path; this release does not bundle those assets.
- Automated code checks passed. PostgreSQL integration testing was blocked because the local database tunnel was offline; live in-game behavior remains unverified. Keep this feature experimental and test carefully with a recoverable backup.
- Full release validation is incomplete: the Windows update-integrity check is blocked by a local PowerShell Security module loading error.

## Upgrade

- Close the Suite and install **AlphaNine-Dune-Suite-Setup-1.3.0.exe** over the existing installation.
- Includes the market expiration and Buy & Pay improvements from 1.2.9. Market Bot runtime remains **1.0.102**.
