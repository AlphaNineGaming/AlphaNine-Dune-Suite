# AlphaNine Dune Suite 1.0.92

## Real Funcom backup files now pass the correct archive policy

Version 1.0.91 successfully located and opened the actual backup artifact inside the VM, but it could reject a valid Funcom archive before copying it locally with an error such as:

> PostgreSQL archive TOC is missing required public.alphanine_market_bot_audit.

Those AlphaNine Market Bot tables are optional Suite additions. They are not present on every server and must not be mandatory for an ordinary Funcom database backup.

Version 1.0.92 removes that incorrect requirement. Backup validation now follows the selected server's actual PostgreSQL catalog: objects and data that exist in the catalog remain required, while optional Suite tables that do not exist are not invented as requirements.

## Verification remains strict

The correction does not weaken the real backup safety checks. The Suite still requires:

- A successful terminal Funcom `DatabaseOperation`.
- One unambiguous absolute VM artifact path.
- Stable remote file identity and byte size.
- A valid PostgreSQL custom-archive signature.
- A complete matching-version `pg_restore` read.
- Exact catalog-derived schema and data coverage.
- Matching VM and local SHA-256 digests.
- Atomic local publication with no selectable partial file after failure.

Once these checks pass, the actual VM backup is stored in the configured local database backup folder and its verified restore metadata is published beside it.

## Verification performed

- Added a production-shaped regression for a valid Funcom archive without AlphaNine Market Bot tables.
- Passed database backup and recovery-archive transport tests.
- Passed operation registry and rendered UI tests.
- Passed migration-preflight and server-migration import isolation tests.
- Passed Windows update-integrity, installer packaging, and packaged-runtime smoke tests.
