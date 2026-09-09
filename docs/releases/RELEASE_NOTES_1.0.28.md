# AlphaNine Dune Suite 1.0.28

Market Bot connection reliability update for local Hyper-V servers.

## Highlights

- The Suite now detects the current VM IP during startup and updates the Market Bot connection automatically.
- Stale Market Bot URLs are repaired when the VM receives a different address after a restart or DHCP change.
- Market Bot requests use the Suite's current VM address as an additional safety net.
- VM, SSH, receiver, and Market Bot connection details now stay synchronized.
- Custom hostname-based Market Bot URLs and remote-server configurations are preserved.

## Admin Notes

- Existing Market Bot settings and API tokens are retained.
- The Market Bot does not need to be uninstalled or reinstalled for this update.
- After installing 1.0.28, restart the Suite once so startup discovery can refresh any stale saved address.
