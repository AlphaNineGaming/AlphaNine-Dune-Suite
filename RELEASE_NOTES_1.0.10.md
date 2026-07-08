# AlphaNine Dune Suite 1.0.10

This release fixes a Market Bot fallback issue found in 1.0.9.

## Fixed

- The VM fallback no longer assumes the Kubernetes deployment is named `market-bot`.
- Suite now discovers the running Market Bot pod in the `dune-market-bot` namespace and proxies API requests through that pod.
- This fixes the error:

`deployments.apps "market-bot" not found`

## Notes

- Users still do not need to manually set the Market Bot API token.
- The VM must be running and SSH must be configured in the Setup Wizard for the fallback path to work.
