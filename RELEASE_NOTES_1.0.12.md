# AlphaNine Dune Suite 1.0.12

This release adds first-run installation support for the standalone AlphaNine Market Bot.

## Added

- Added `Install / Update Bot` on the Market Bot page.
- Suite now bundles the Market Bot Linux binary, item data, and Kubernetes manifest.
- The install action uploads the bot to the configured VM, applies the Kubernetes deployment/service, waits for rollout, and saves the API token.
- Fresh users no longer need the Market Bot to already exist before Suite can manage it.

## Verified

- Installed/updated the bundled bot on the VM from the new Suite endpoint.
- Confirmed Market Bot overview loads after install.
- Confirmed logs show the bot connected to the selected battlegroup database and listening on `:8081`.

## Notes

- The Market Bot installs with scheduled activity disabled by default. Users should review settings, enable `Bot Enabled`, then save config.
- Manual controls can be used after install once the bot is online.
