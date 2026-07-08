# AlphaNine Dune Suite 1.0.9

This release fixes the Market Bot connection failure reported in 1.0.8 where the page could show:

`Partial connection: health: fetch failed / status: fetch failed / config: fetch failed`

## Fixed

- Added an automatic VM/Kubernetes fallback for Market Bot API calls.
- Suite now tries the normal Market Bot URL first, then safely proxies through the configured VM over SSH when the bot API port is not reachable from the user's PC.
- The fallback supports Market Bot health, status, config saves, manual tick buttons, manual buy actions, and listing removal.
- Token recovery still runs automatically, so users should not need to manually copy or paste the Market Bot API token.

## For Users

- Update normally from Suite or install this build over the previous one.
- Open **Market Bot** and press **Refresh Bot**.
- If the VM is running and SSH is configured in the Setup Wizard, the Market Bot page should connect even when port `8081` is private or blocked.
