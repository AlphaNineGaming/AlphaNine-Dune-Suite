# AlphaNine Dune Suite 1.0.23

Market Bot uninstall and admin market control update.

## What's Changed

- Added `Uninstall Bot` to remove the Market Bot service from the VM.
- Bot uninstall removes the Kubernetes deployment, service, config, secret, namespace, VM files, and saved Suite bot token.
- Existing market listings are not deleted when the bot is uninstalled.
- Suite live market `Buy` can buy player listings, remove the listing, and create the seller Solari payout.
- Suite live market `Remove` can remove NPC/manual listings directly from Suite.
- UI sound controls now start visually disabled by default, matching the config default.
- Expanded the Market Bot user guide with uninstall and setup details.

## Notes

- Use `Live Market Listings` to remove market rows.
- Use `Uninstall Bot` only when you want to remove the bot service from the VM.
