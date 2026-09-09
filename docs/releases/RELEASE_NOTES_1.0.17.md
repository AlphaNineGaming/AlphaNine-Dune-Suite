# AlphaNine Dune Suite 1.0.17

Market Bot install/update stability hotfix.

## What's Changed

- Market Bot install/update no longer deletes the Kubernetes deployment before every install.
- Suite now applies the Market Bot manifest in place, restarts the deployment, and waits for rollout.
- If Kubernetes reports an immutable/deleting deployment state, Suite falls back to a waited delete/recreate and retries the apply.

## Notes

- This fixes `error: object has been deleted` during Install / Update Bot.
- This update does not change, delete, or recreate market listings.
