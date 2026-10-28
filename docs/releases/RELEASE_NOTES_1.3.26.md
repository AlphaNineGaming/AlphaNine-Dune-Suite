# AlphaNine Dune Suite 1.3.26 — House Scrip Compatibility

House Scrip balances and grants now support databases that store currency as dune.virtualwallettype. This resolves the “operator does not exist: dune.virtualwallettype = integer” balance error and the “House Scrip storage is unsupported” grant error on those servers.

## Fixed

- Automatically detect the live currency schema and use HouseCredit for enum-based House Scrip storage.
- Use the matching database function signature when granting House Scrip.
- Keep compatibility with older databases that use a numeric currency ID.
- Preserve offline-player checks, typed confirmation, automatic backups, and exact balance verification.

## Validation

- 22 behavioral checks cover both currency formats, balance queries, simulated grants, and grant safeguards.
- Verified schema detection and a successful balance lookup against a live enum-based database. No live currency was granted during validation.
- Includes the cleanup stability fixes from 1.3.25. Repository source and release downloads are synchronized.

## Downloads

Windows x64 installer, portable ZIP, full source ZIP, and SHA-256 checksums. Install 1.3.26 over your existing Suite installation; no manual database migration is required.

Known limitation carried forward from 1.3.25: the Server Type feature remains nonfunctional.
