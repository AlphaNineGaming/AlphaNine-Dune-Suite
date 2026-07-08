# AlphaNine Dune Suite 1.0.21

Market Bot install diagnostics and service fallback refinement.

## What's Changed

- Market Bot service port-forward fallback now uses a dynamic VM-local port and tries `curl` before raw socket traffic.
- Install / Update Bot now collects pod status, service endpoints, pod describe output, and recent logs if Kubernetes rollout times out.
- Timeout errors should now show the real bot startup problem instead of only `timed out waiting for the condition`.

## Notes

- This update does not change, delete, or recreate market listings.
- If install still fails, send the full Market Bot result text; it should now include the useful pod/log details.
