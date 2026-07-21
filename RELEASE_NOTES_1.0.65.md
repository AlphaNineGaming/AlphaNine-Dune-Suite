# AlphaNine Dune Suite 1.0.65

This release adds a safe, local-only Database Explorer for inspecting the selected Dune: Awakening battlegroup PostgreSQL database without exposing generic database editing.

## Read-only Database Explorer

- Browse the live database by schema, table, and view.
- Inspect column types, nullability, primary keys, approximate row counts, and relation sizes.
- Browse bounded row pages with sorting and parameterized filters.
- Inspect a selected row and export the current page as CSV or JSON.
- Search the table/view list without querying every relation.

## Database safety

- Every operation runs in a PostgreSQL `READ ONLY` transaction.
- Table and column identifiers must match live PostgreSQL metadata.
- Filter values are sent as query parameters and are never concatenated into SQL.
- Query, lock, page-size, column-count, cell-size, and response-size limits prevent runaway reads.
- Binary values are represented by size instead of transferring their contents.
- The Explorer does not accept arbitrary SQL and cannot insert, update, delete, or execute generic row editing.

## Portal security

- Database Explorer is available only from the local Suite.
- Its navigation entry is hidden from every HTTPS/internet portal role.
- Its API rejects LAN, HTTPS, and internet portal requests, including authenticated Owner sessions.
- Existing password, TOTP two-factor authentication, CSRF, secure sessions, and role protections remain unchanged.

## Validation

- Validated live against the `dune` schema with 168 discovered tables/views.
- Verified real metadata, primary-key detection, sorting, filtering, and multi-page browsing.
- Verified injection text remains a parameter and invalid relation names are rejected.
- Passed database-browser, rendered UI, remote-access, database-setup, installer, and packaged-runtime tests.
- Production dependency audit reports zero vulnerabilities.
