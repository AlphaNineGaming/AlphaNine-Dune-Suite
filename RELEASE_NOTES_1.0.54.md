# AlphaNine Dune Suite 1.0.54

## Secure Internet Web Portal

- Added one-click Cloudflare Tunnel client installation.
- Added temporary public test URLs and stable named-tunnel support.
- Added a dedicated loopback-only tunnel origin that always enforces administrator login, secure sessions, CSRF checks, and login rate limits.
- Added internet portal status, open, copy, start, and stop controls.
- Enabled PWA service-worker registration over the public HTTPS portal.
- Kept Cloudflare tunnel tokens out of saved Suite configuration.
- Added Viewer, Operator, and Owner remote permission modes, defaulting to read-only Viewer.
- Added an explicit remote API allowlist and unconditional local-only blocks for secrets, setup, diagnostics, configuration, permissions, logs, and Server Manager.
- Added optional authenticator-app two-factor authentication.
- Added five-minute Owner reconfirmation for remote write actions.
- Added audit records for remote logins, blocked requests, and write actions.
- Added Windows publisher verification for downloaded `cloudflared.exe` files.
- Added automatic tunnel shutdown after 60 minutes without remote activity.
- Fixed temporary URL discovery so the Suite waits for Cloudflare instead of checking only once.
