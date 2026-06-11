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
- Give Item with Dry-Run and Live Give modes
- Live Map with player, vehicle, and base markers when position data is available
- Server Management view
- Gear Codex
- Environment and setup checks
- Diagnostics tab with log viewer
- Settings export and import
- GitHub update check

## Requirements

- Windows 10 or Windows 11
- Dune: Awakening self-hosted server installed
- Administrator launch when using Hyper-V or VM controls
- Network access from this PC to the Dune server VM
- Database access through the configured Dune server environment

Node.js is only required for developers running from source. Installed users should use the Windows installer.

## Installation

1. Download the latest `AlphaNine Dune Suite Setup` installer.
2. Run the installer.
3. Keep the default shortcuts selected.
4. Launch `AlphaNine Dune Suite` from the Start Menu or Desktop.
5. Run as Administrator if you need VM or Hyper-V controls.

The installer includes the suite app and receiver files. Settings are stored in the Windows app data folder so they survive updates.

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
- Use Dry-Run before Live Give.
- Keep backups of settings before major changes.
- Only run Live Give on servers you own or are authorized to administer.
- Do not commit local config files containing secrets.

## Legal Notice

AlphaNine Dune Suite is an independent fan-made server administration tool.

Dune: Awakening, Arrakis, Deep Desert, Hagga Basin, and all related game assets, trademarks, logos, names, artwork, and intellectual property are owned by Funcom and their respective rights holders.

This project is not affiliated with, endorsed by, sponsored by, or approved by Funcom.

Any game-related assets used within the project remain the property of their respective owners and are used solely for community administration and informational purposes.

## Credits

AlphaNine Dune Suite is maintained by AlphaNineGaming.

Thanks to the Dune: Awakening self-hosting community for discovery work, testing, and operational feedback.
