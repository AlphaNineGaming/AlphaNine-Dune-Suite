# AlphaNine Dune Suite 1.0.15

Market Bot VM fallback hotfix.

## What's Changed

- Fixed Market Bot VM fallback requests on servers where Kubernetes cannot infer the correct pod container.
- Suite now discovers the running Market Bot pod's actual container name before using `kubectl exec`.
- The user-facing error is clearer if the pod exists but no usable container can be found.

## Notes

- This does not delete or change market listings.
- Install this update if Market Bot actions show `unable to upgrade connection: container not found ("market-bot")`.
