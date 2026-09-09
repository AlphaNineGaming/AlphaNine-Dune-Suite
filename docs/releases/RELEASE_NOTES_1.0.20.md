# AlphaNine Dune Suite 1.0.20

Market Bot Kubernetes Service fallback.

## What's Changed

- Market Bot control no longer uses `kubectl exec` into the bot container.
- Suite now connects by direct VM-local API first, then falls back to a Kubernetes Service port-forward to `svc/market-bot:8081`.
- Error messages now report service/API reachability problems instead of container-name failures.

## Notes

- Run `Install / Update Bot` after installing this version so the Market Bot Service manifest is applied.
- This update does not change, delete, or recreate market listings.
