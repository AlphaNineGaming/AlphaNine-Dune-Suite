# Mutation adapters — design only, unavailable on new providers

There must be one feature contract and one existing page for each feature. The page submits a feature operation; the backend resolves the selected provider/runtime and chooses its implemented adapter. Shared business logic should consume normalized observations and plans, not shell commands, hypervisor identifiers or raw provider configuration.

## Common operation contract

1. Resolve and pin a provider/runtime/target snapshot and actor. Reject missing capabilities and adapters before transport calls. Enforce portal roles and local-only restrictions independently.
2. Read normalized state and build a preview through the existing validators/planners. Bind preview identity, expiry, input/schema/version, selected target and baseline state.
3. Acquire the existing OperationRegistry conflict/journal entry plus a target lease for the entire background job. Revalidate remote identity, permissions, state and preview immediately before effects. Cancellation or connection loss does not silently change endpoints.
4. Create and verify feature-appropriate recovery evidence through a separately validated backup adapter. Use original safety boundaries, archive integrity, outside-schema and ownership checks where applicable.
5. Execute only the adapter's compiled/validated operation or authenticated protocol request. Never accept arbitrary SQL or commands from the UI. Record bounded progress and safe evidence; keep credentials outside journals/reports.
6. Confirm the actual postcondition through an independent read. Queue acceptance, executable presence or HTTP success alone is not success. If interrupted, require reconciliation against the same target and operation identity before retrying.
7. Roll back only through a tested recovery adapter scoped to the original target. A rollback may not select a new provider or restore onto a changed target. Report incomplete recovery clearly.

This contract is not fully wired to all legacy background jobs yet. The current patch pins HTTP work and guards target changes against registered active jobs while preserving their existing implementations. Provider-specific mutation modules and full remote/runtime job leases remain future work.

| Feature | Shared existing logic | Provider-specific contract still needed | Required real evidence before enablement |
|---|---|---|---|
| VM lifecycle/disk | VM/disk admission, conflicts and operation journal | Hyper-V facade retained; Proxmox authenticated VM API; other types do not inherit VM capabilities | VM identity, ownership, power state, attached disks/checkpoints, interrupted action and recovery |
| Game lifecycle/maps | Battlegroup intent generations, confirmations, offline/readiness checks | Native/systemd process/service actions; selected Docker container actions; Kubernetes workload/CRD actions with storage/node binding | Exact game runtime, process wrappers, graceful-stop semantics, players/availability and safe restart behavior |
| Update/package cleanup | Version plans, package/backup validation and rollback | Signed/provenance-checked fetch, provider package paths, active-reference checks, deploy/cleanup primitives | Genuine game payloads, real layouts/versions, verified recovery and interrupted update |
| Teleport/recovery | Coordinate/readiness/travel graph validators | Verified live administrative transport or validated offline actor/schema writer | Protocol/authentication, account/controller binding, elevation/travel semantics, acknowledgement, offline state and rollback |
| Give/progression/rewards | Bounds/catalog/rank validation, queues, receipts and reward plans | Provider's authenticated receiver/AMQP/admin path and supported schema/functions | Correct identity, actual inventory/progression changes, idempotency, game cache synchronization and receipt/postcondition proof |
| Market Bot/automation | Stock/pricing plans, evidence/reconciliation and single-writer ledger guards | Service installer/controller, exact market/schema/settlement transport and runtime integrity | Real ledger/settlement semantics, single writer, pause/reconcile behavior, safe install/uninstall and rollback |
| Backup | TOC/catalog/hash/transfer/publication checks | Consistent dump/vendor operation, named workload/volume ownership, scoped transfer/local storage | Complete restorable archives, correct namespace/ownership, transfer interruption and retained recovery evidence |
| Restore/import/ownership repair | Existing atomic schema restore, outside-boundary checks, promotion and rollback | Stopped-runtime confirmation, archive/schema matching, atomic restore and recovery transport | Disposable real PG restore/rollback, constraints/partitions/owners/functions, outside-boundary integrity and service restart safety |
| Scheduler | Config/timezone normalization, task/journal evidence | Runtime-specific scheduler registration and job leases, lifecycle/backup adapters | Actual clocks/timezones, sole worker, backup path identity, interruption and missed/repeated job recovery |
| INI editing/recovery | Typed schema parser/updater and conflict/backup/recovery checks | Canonical template/active config-slot model, conditional writes preserving ownership/mode and verified backups | Real sections/locations, symlink policy, expected-content conflicts, interrupted write/restore and gameplay-effect evidence |
| Blueprints/inventory/repair/cleanup | Format validation, item/object ownership, dependency graphs and previews | Validated schema readers, bounded writers and backup/recovery | Actual object graph and identity, side effects/dependencies, exact affected rows and rollback |
| Web Portal | Existing sessions/TOTP/roles, origin/security policy | Unified per-operation authorization, target-bound transport and permitted exposure | TLS/login/roles, cross-site/unauthorized denial, no bypass through provider/IPC routes and safe audit export |

## Provider requirements

**Remote Linux:** SSH host trust, nonprivileged permission model, explicit deployment/runtime binding, genuine payload/schema profiles and exact administrative protocol remain prerequisites. Do not add sudo, daemon privileges, plaintext PG fallback, hidden credential extraction or arbitrary commands to work around failed diagnostics.

**Docker server provider:** design explicit engine endpoint/authentication and same-host/volume/container identity, networks and persistent data ownership. The current Remote Linux selected-container GET inspector is not this provider. Root-equivalent engine access must not be assumed or granted automatically.

**Proxmox:** separate VM control from game runtime/SSH/database access. An authenticated Proxmox API and valid VM ID do not establish Dune or PG compatibility. Require actual host/VM permissions, identity/state semantics, restore testing and least-privilege scope.

**Managed hosting:** inventory documented read/admin APIs and operator permissions first. Unsupported API/protocols or inaccessible DB/filesystem facets stay unavailable; no Windows/Hyper-V fallback or fabricated compatibility.

No simulated test, selected server type, caller-provided capability or report label can turn these designs into enabled mutations. Promotion requires implemented backend admission, reproducible failure/rollback tests and separately reviewed real-server evidence. Publishing/deploying still requires explicit approval.
