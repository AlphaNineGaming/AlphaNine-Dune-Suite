# AlphaNine Dune Suite 1.2.0

This hotfix restores local copying of verified Funcom VM database backups.

## Database backup validation

- Fixed a validator mismatch that treated normal PostgreSQL ACL entries in Funcom-created archives as unexpected schema objects.
- Vendor archives now use a schema inventory generated with the vendor privilege boundary, while Suite-native backups retain their stricter no-privileges format.
- Remote backup availability checks use the same corrected inventory rules.
- Unexpected schema mismatches now report descriptor counts such as `ACL=1` or `TABLE=1` instead of a generic error.

## Release quality

- Added regression coverage for the vendor privilege boundary and detailed TOC mismatch reporting.
- The backup archive remains subject to signature, stable-size, SHA-256, complete-read, schema, and data inventory verification.
- No database migration or configuration change is required. The bundled Market Bot runtime remains **1.0.99**.
