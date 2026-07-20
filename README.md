# AlphaNine Dune Suite

AlphaNine Dune Suite is a Windows desktop control center for self-hosted Dune: Awakening servers. It is built for server owners who want an installer, a setup wizard, and clear buttons instead of command-line setup.

## Overview

The suite runs as a local desktop app and opens an Operations Center for server status, players, give-item tools, Live Map, diagnostics, receiver management, and settings.

Normal users should not need to install Node.js, run npm commands, edit JSON files, manually launch the receiver, or use PowerShell for daily operation.

## Features

- Dashboard with server, database, receiver, and VM health
- First-launch setup wizard
- Integrated receiver start, stop, restart, and status
- Player feed and player management
- Player blueprint import, export, deletion, pre-import JSON preview, and interactive offline 3D viewing
- Give Item with Dry-Run and Live Give modes
- Live Map with player, vehicle, and base markers when position data is available
- Server Management view
- Gear Codex
- Environment and setup checks
- Diagnostics tab with log viewer
- Settings export and import
- GitHub update check

## Release Notes

### 1.0.64

- Expanded the fully offline blueprint viewer from 542 to 637 exact GLB models and from 555 to 655 blueprint-type mappings.
- Added 100 exact mappings for functional and decorative placeables from the separate placeable asset registry that was previously omitted from the installer.
- Added exact offline models for water cisterns, wind turbines, windtraps, storage containers, spice refineries, lighting, furniture, decorations, crafting stations, and other supported base placeables.
- Added regression coverage for the reported placeable identifiers and representative Atreides, CHOAM, Fremen, and downloadable-content placeables.
- Kept unsupported identifiers unmapped when no authoritative exact mesh exists, preventing visually incorrect substitutions in the viewer.

### 1.0.63

- Added a new royal AlphaNine Suite icon to the application, installer, taskbar, tray, and installed shortcuts.
- Added immediate Live Map destination feedback with a pulsing target marker while a teleport is being sent, followed by clear success or failure feedback.
- Allowed click-to-teleport destinations directly on player, vehicle, base, and clustered map markers instead of requiring an empty point beside them.
- Fixed offline-player teleport failures caused by the game database function being unable to resolve its schema-local `is_player_offline(text)` helper.
- Added receiver checks for every database routine required by offline teleport and validated the corrected schema resolution against a live server database.

### 1.0.62

- Fixed imported blueprint items that could report "base not found" because their inventory metadata still referenced blueprint ID 0.
- Added automatic repair for previously imported blueprint items whose stored reference does not match their database blueprint.
- Improved Live Teleport routing for offline players and allowed more time for receiver-backed teleport operations to complete.
- Restarted the managed receiver automatically when its active SSH, battlegroup, or teleport configuration is stale.

### 1.0.4

- Added a Give Item popup when admins select Grade 1-5, explaining that the player must relog before database-granted items appear in inventory.
- Added the same relog warning before live Grade 1-5 grants and Give Queue runs that include graded items.
- Bumped the service-worker cache for a clean app shell refresh after updating.

### 1.0.3

- Added Market Posting for creating live NPC exchange sell listings from the Suite.
- Added Live Market Listings so admins can see current exchange orders from the live database.
- Added a startup progress popup while the Suite detects server, database, VM, maps, players, and receiver status.
- Improved update packaging so the Windows installer filename matches updater metadata.
- Bumped the service-worker cache for a clean app shell refresh after updating.

### 0.3.5-beta

- Unified Live Map and Live Teleport coordinate handling.
- Added safe elevation provenance and preview diagnostics.
- Live Teleport now requires a matching preview with a known Z/elevation source.

### 0.3.4-beta

#### Live Map

- Complete Live Map overhaul.
- New backend marker API for Players, Vehicles, and Bases.
- Local map assets bundled with no runtime GitHub dependency.
- Added improved Live Map diagnostics.
- Fixed Suite UI startup regression caused by Live Map initialization.
- Corrected Hagga Basin Y-axis orientation so player movement matches in-game direction.
- Validated against a live database with real player, vehicle, and base data.

#### Other

- Improved overall Live Map stability.
- No changes to Live Give, Progression, Database, or Receiver functionality.

## Requirements

- Windows 10 or Windows 11
- Dune: Awakening self-hosted server installed
- Administrator launch when using Hyper-V or VM controls
- Network access from this PC to the Dune server VM
- Database access through the configured Dune server environment

Node.js is only required for developers running from source. Installed users should use the Windows installer.

## Offline Blueprint Models

The blueprint viewer works without an internet connection. The bundled catalog includes 637 exact meshes and 655 blueprint-type mappings, including building pieces, supported functional and decorative placeables, and pentashields; no extra model folder or download is required.

1. Open **Blueprints**.
2. Select **View** for a saved blueprint, or choose a JSON file and select its **Preview** button before importing.
3. Orbit, pan, and zoom the exact mesh-based layout on the 3D grid.

The viewer uses the exported game coordinates, rotations, and scale values. If a blueprint contains an unknown piece type, the coverage line reports its ID instead of drawing an invented substitute.

## Installation

1. Download the latest `AlphaNine Dune Suite Setup` installer.
2. Run the installer.
3. Keep the default shortcuts selected.
4. Launch `AlphaNine Dune Suite` from the Start Menu or Desktop.
5. Run as Administrator if you need VM or Hyper-V controls.

The installer includes the suite app and receiver files. Settings are stored in the Windows app data folder so they survive updates.

## Mobile App

AlphaNine Dune Suite includes mobile web app metadata, an install manifest, and a service worker. When the Suite is running, open the Web Portal URL shown in the app from a phone on the same network, then use the browser menu to add it to the home screen.

Notes:

- Android and iOS can launch the Suite from a home-screen icon.
- Browser-installed PWA mode normally requires HTTPS on real phones. A plain LAN `http://` URL may still work as a home-screen shortcut, but full install prompts and service-worker behavior depend on the mobile browser.
- For a store-distributed native app, wrap the same web portal in an Android/iOS shell and point it at the Suite host URL.

## Internet Web Portal

The Web Portal page can publish the authenticated Suite portal through Cloudflare Tunnel without opening an inbound router or Windows Firewall port.

1. Open **Web Portal** on the Suite computer.
2. Set an administrator password of at least 12 characters.
3. Select **Install cloudflared**.
4. Select **Start Test URL** to receive a temporary `trycloudflare.com` address.
5. For a stable address, create a named Cloudflare Tunnel, route its public hostname to `http://127.0.0.1:8813`, and paste its run token and public URL into the Suite.

The tunnel token is passed to `cloudflared` only when the tunnel starts and is not written to Suite configuration. Temporary TryCloudflare URLs are for testing; use a named tunnel and Cloudflare Access policies for regular internet access.

Remote security defaults:

- New and upgraded installations default to the **Viewer** role, which exposes an explicit read-only API allowlist.
- **Operator** permits limited server controls. **Owner** permits approved remote administration but requires password and authenticator reconfirmation every five minutes for writes.
- Setup, credentials, configuration export, diagnostics, environment details, permissions, Market Bot configuration, and Server Manager remain local-only for every remote role.
- Optional authenticator-app (TOTP) protection is configured only from the local Suite.
- Remote logins, blocked requests, and write actions are recorded in the Suite admin audit log.
- The downloaded `cloudflared.exe` must have a valid Windows publisher signature from Cloudflare, Inc.
- Active tunnels stop automatically after 60 minutes without remote traffic.

## First-Time Setup

On first launch, the Setup Wizard opens automatically.

Setup steps:

1. Welcome
2. Server Type
3. Database connection test
4. Receiver configuration
5. Save configuration
6. Finish setup

Recommended flow:

1. Choose your server type.
2. Let Auto Discovery fill what it can.
3. Enter database details if needed.
4. Click `Test Database`.
5. Configure the receiver.
6. Click `Start Receiver`.
7. Click `Test Receiver`.
8. Save configuration.

You can reopen the wizard later from Settings.

## Receiver Configuration

The receiver is the bridge used for Live Give operations. AlphaNine Dune Suite can manage it from the UI.

Receiver controls are available in Settings and Diagnostics:

- Start
- Stop
- Restart
- Test Receiver
- Status indicator

If the receiver is offline, Live Give will stay unavailable. Dry-Run remains available for safe testing.

## Live Give Modes

Give Item has two operating modes:

- Dry-Run: Builds and previews the request without sending a live grant.
- Live Give: Sends the request to the configured receiver when the server and receiver are online.

Safety notes:

- Dry-Run is the default.
- Live Give requires the server to be online.
- Live Give requires the receiver to be reachable.
- Some item qualities or grades may not be supported by the live receiver path.

## Live Map

The Live Map tab uses a Leaflet map view for tactical server data.

Live Map can show:

- Player markers when coordinates are available
- Vehicle markers when discovered
- Base markers when discovered
- Clicked map coordinates
- Coordinate search
- Player-list teleport: select a player without changing the camera, then click the map destination
- Debug details for marker and player position sources

If the map says `Loaded 1 player, 0 with coordinates`, the suite found player identity data but did not find a usable live position source yet.

## Database Tab

Database-related checks are available through Settings, Diagnostics, Admin Tools, and Live Map debug output.

Use `Test Database` to confirm the suite can reach the Dune database. If the test fails, check:

- The Dune server VM is running
- The database port is reachable
- The configured host/IP is correct
- The app is running with the permissions needed for VM access

## Troubleshooting

Start with the Diagnostics tab.

Common checks:

- `Test Database`
- `Test Receiver`
- `Test Server`
- Receiver status
- Suite logs
- Receiver logs
- Version info

Common fixes:

- Restart the receiver from Settings.
- Run the suite as Administrator.
- Confirm the Dune server VM is running.
- Confirm the configured VM IP is correct.
- Reopen Setup Wizard and save configuration again.
- Export settings before reinstalling or moving to another PC.

## Safety

- Do not share receiver tokens, database passwords, SSH keys, or exported settings publicly.
- Do not share Cloudflare tunnel tokens. Stop or rotate a tunnel if its token may have been exposed.
- Set the remote administrator password before starting an internet tunnel, and use a unique password.
- Use Dry-Run before Live Give.
- Keep backups of settings before major changes.
- Only run Live Give on servers you own or are authorized to administer.
- Do not commit local config files containing secrets.

## Community & Support

Need help with AlphaNine Dune Suite?

Join the AlphaNine Gaming Discord community:

[https://discord.gg/RQsVw2vyg](https://discord.gg/RQsVw2vyg)

Support includes:

- Installation assistance
- Configuration help
- Bug reports
- Feature requests
- Dune Awakening server discussions
- AlphaNine Dune Suite updates

YouTube:
[https://www.youtube.com/@AlphanineGaming](https://www.youtube.com/@AlphanineGaming)

## Legal Notice

AlphaNine Dune Suite is an independent fan-made server administration tool.

Dune: Awakening, Arrakis, Deep Desert, Hagga Basin, and all related game assets, trademarks, logos, names, artwork, and intellectual property are owned by Funcom and their respective rights holders.

This project is not affiliated with, endorsed by, sponsored by, or approved by Funcom.

Any game-related assets used within the project remain the property of their respective owners and are used solely for community administration and informational purposes.

## Credits

AlphaNine Dune Suite is maintained by AlphaNineGaming.

Thanks to the Dune: Awakening self-hosting community for discovery work, testing, and operational feedback.
