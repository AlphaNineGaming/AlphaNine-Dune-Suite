# AlphaNine Dune Suite 1.1.8

Players now appear where you expect them: directly in the **Players** tab, without opening **Give Item** first.

## Live player discovery in Players

- Opening **Players** immediately runs the same shared live-player discovery used by **Give Item**.
- **Refresh Players** now forces a fresh player-directory lookup instead of running the older broad admin refresh.
- Player Management, Give Item, permissions, progression, blueprints, and repair tools continue to share one consistent player directory.
- Concurrent lookups remain coalesced, so switching between tools does not start duplicate discovery requests.
- If a temporary refresh fails, the Suite keeps the last confirmed player list visible and reports the warning instead of replacing it with an empty result.

## Release quality

- Added rendered UI regression checks for automatic Players discovery and forced refresh behavior.
- Corrected the Market Bot Go test to enforce the released scoped-`sudo` command order: command timeouts remain outside `sudo kubectl`.
- Includes all player inventory deletion reliability fixes from 1.1.7.

No configuration migration is required. The bundled Market Bot runtime remains **1.0.99**.
