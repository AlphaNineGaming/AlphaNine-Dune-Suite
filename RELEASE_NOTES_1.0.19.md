# AlphaNine Dune Suite 1.0.19

Market Bot VM-local API fallback hotfix.

## What's Changed

- Suite now tries `curl` from inside the VM to `http://127.0.0.1:8081` before using raw `nc` or Kubernetes exec.
- The Kubernetes fallback skips terminating pods and only chooses pods whose status is `Running`.
- Kubernetes exec remains available as a last resort, but normal Market Bot control should no longer depend on the pod container name.

## Notes

- This targets remaining `container not found ("market-bot")` fallback errors after `1.0.18`.
- This update does not change, delete, or recreate market listings.
