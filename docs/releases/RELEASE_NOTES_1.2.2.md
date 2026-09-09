# AlphaNine Dune Suite 1.2.2

This patch release enables Live Give for authenticated Operator accounts using the HTTPS or internet Web Portal.

## Web Portal Live Give

- Added `/api/admin/give-item` to the explicit Remote Operator write allowlist.
- Operators can now run both Dry-Run validation and confirmed Live Give from the authenticated Web Portal.
- Viewer sessions remain read-only and continue to receive a permission error for Live Give requests.
- Unrelated administration endpoints remain restricted to the Remote Owner role.

## Security and release quality

- Live Give requests still require an authenticated session and a valid CSRF token.
- Confirmed execution still uses the existing Live Give confirmation, receiver validation, and audit trail.
- Added an integration regression test proving that Operator Live Give reaches payload validation while an unrelated administration write remains Owner-only.
- Verified remote roles, Owner 2FA, HTTPS and tunnel login, local-only setup, secure cookies, CSRF handling, rendered UI syntax, and Live Give configuration persistence.
- No configuration or database migration is required. The bundled Market Bot runtime remains **1.0.99**.
