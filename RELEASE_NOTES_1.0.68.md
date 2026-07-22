# AlphaNine Dune Suite 1.0.68

## Server Cleaner bigint correction

- Fixed base deletion failures caused by PostgreSQL bigint actor IDs being rounded when passed through JavaScript numeric conversion.
- Base actor IDs now remain exact strings through scan results, UI rendering, the deletion request, backend validation, operation logging, and SQL parameters.
- Added audit records for Cleaner deletion requests and failures so validation and database errors retain the affected actor ID.
- Added source and packaged regression checks that reject `Number` conversion in the Server Cleaner actor-ID flow.

## Supported scope

- Single-base deletion is supported with the existing ownership checks, confirmation requirements, transaction, and deletion SQL.
- Bulk base deletion is not implemented.
- Owned actor `953` was not modified.
- Live destructive deletion remains pending validation against a confirmed orphan or disposable test base.

## Validation

- Server Cleaner regression test.
- Rendered UI syntax test.
- Operation registry reliability test.
- Blueprint feature regression test.
- Packaged application smoke test, including execution of the packaged Server Cleaner regression test.
