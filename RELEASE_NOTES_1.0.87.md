# AlphaNine Dune Suite 1.0.87

## Web portal role-menu correction

- Fixed **Owner — full approved remote access** showing only the Dashboard in the authenticated LAN and internet web portals.
- Owner now receives every remotely approved menu while setup, credentials, diagnostics, environment details, logs, Server Manager, and other local-only features remain restricted to the server computer.
- Viewer and Operator retain their explicit menu allowlists and server-side endpoint permissions.
- Unknown or invalid session roles continue to fail closed to Dashboard-only access.

## Verification

- Added browser-policy regressions for Viewer, Operator, Owner, and invalid roles.
- Confirmed Viewer write requests remain blocked by the server-side read-only policy.
- Passed the remote-access integration and rendered UI syntax suites.
- The Windows packaged-runtime test verifies the corrected remote menu policy is included in the installer.
