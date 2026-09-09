# AlphaNine Dune Suite 1.1.9

Server configuration is now easier to reach and safer to change. This release adds a dedicated **UserGame Settings** page and direct access to the server's `battlegroup.bat` launcher.

## Live UserGame.ini settings

- Added **UserGame Settings** as a child page beneath **Server Management**, keeping live configuration separate from day-to-day Server Control actions.
- The page reads the active `UserGame.ini` directly from the configured Dune server VM and presents 18 supported settings in clear groups.
- Player building controls include maximum landclaim segments, blueprint extensions, base-backup extensions, and building-restriction enforcement.
- Additional controls cover XP and progression, fame, guild cost, market fees, spice tax, harvesting, cutteray efficiency, security zones, PvP, deterioration, and Coriolis behavior.
- The raw file remains available as an advanced read-only preview for administrators who want to verify the complete configuration.

## Protected save workflow

- Saving changes only explicitly supported fields; unknown settings and existing comments remain untouched.
- Values are type-checked and range-checked before the Suite writes anything.
- The current VM file is copied to a timestamped backup before replacement.
- The replacement is uploaded, installed, and verified with SHA-256 before it is applied.
- The Suite runs the Battlegroup default-user-settings apply command after verification.
- A failed verification or apply step restores the backup automatically.
- The battlegroup is never restarted automatically, so administrators retain control over player-impacting operations.
- Live editing is restricted to the locally installed Suite.

## Server Control convenience

- Added **Open Battlegroup.bat** to Server Control.
- The button resolves the configured Dune server installation and opens its exact `battlegroup.bat` file through Windows.
- Missing or invalid server paths produce a clear error instead of opening an unrelated file.

## Release quality

- Added parser and validation coverage for supported values, line-ending preservation, section-aware insertion, unknown-key rejection, and bounds enforcement.
- Added rendered and packaged UI checks for the Server Management child page, automatic live-file loading, save controls, and Battlegroup launcher bridge.
- No configuration migration is required. The bundled Market Bot runtime remains **1.0.99**.
