# AlphaNine Dune Suite 1.0.18

Market Bot connection fallback hardening.

## What's Changed

- Suite now tries the Market Bot API from inside the VM via `127.0.0.1:8081` before using Kubernetes exec.
- Kubernetes fallback now tries every container declared in the Market Bot pod instead of assuming a single container name.
- Improved the fallback error if a pod is found but no container accepts the API connection.

## Notes

- This fixes remaining `container not found ("market-bot")` refresh/control failures on servers where the bot host port is reachable from the VM but not from the Suite PC.
- This update does not change, delete, or recreate market listings.
