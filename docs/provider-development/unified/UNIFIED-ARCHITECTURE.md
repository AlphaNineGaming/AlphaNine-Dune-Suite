# Unified provider architecture — Suite 1.3.24 development

This work uses a separate `work/unified-suite` copy extracted from the latest Phase 3 source tree `e3db774f4b4f86b8b0d20a5965a3e607064c476f`. The prior working copy, installed Suite and production systems are untouched. No installer or release was built.

## What is implemented

The **existing Suite routes, pages and renderers** now serve the adapted read features. The separate Phase 3 compatibility dashboard and its duplicate read-operation buttons were removed. Navigation remains consistent; unsupported feature pages show a reason and disabled controls. Setup Doctor holds provider diagnostics and the sanitized report. The existing Setup Wizard selects the provider, trust information and deployment scope.

Selecting a provider is not a capability grant. Remote Linux reads require fresh recognized-layout/runtime evidence and, for database operations, fresh restricted-role/schema evidence. Docker, Proxmox and managed-hosting server providers remain Unsupported/planned. Docker workload inspection through Remote Linux is an Experimental deployment runtime, not a complete Docker server provider.

| Common operation | Existing route | Existing page / shared logic | Remote Linux scope |
|---|---|---|---|
| Server status | GET `/api/status` | Dashboard and Server Control status renderer | Exact scoped process/service/workload state; game online state is not inferred |
| Runtime health | GET `/api/server-health` | Server Health cards/tables | Scoped runtime state; application, service and resource observations not collected remain Unknown |
| Version metadata | GET `/api/server-update/check` | Existing server version fields | Numeric manifest/revision observations; update availability is `null` with `not_probed` assessment |
| Configuration | GET `/api/usergame-settings` | Existing schema-driven UserGame Settings renderer and setting schema | Four approved typed fields when present; inputs/save disabled; full config excluded |
| Database connection | GET `/api/database/status` | Existing Database status renderer | Explicit direct verified TLS; restricted effective privileges and read-only transaction |
| Player rows | GET `/api/admin/players`, GET `/api/players/feed` | Existing directory/search/cards/details/feed | At most 100 plain-table rows; row IDs are explicitly not account/controller identities |
| Explorer schemas/tables/metadata/rows | Existing `/api/database-browser/*` routes | Existing Explorer grid, paging, metadata, cell normalization and local exports | Only validated `dune.player_state` and three approved columns; ascending PK order, no filters/custom sorting |

The standalone CLI remains useful for diagnostics without importing the application backend. `/api/providers/read` remains a backend diagnostic/adapter interface, not a second Linux feature UI.

## Routing and adapter contracts

`lib/providers/feature-router.js` defines exact method/path/operation/capability/page entries. It resolves the common routes and projects provider observations into the existing response formats. There is no caller-supplied provider override, command, SQL or generic mutation executor.

For Hyper-V, the adapter boundary continues into the original handlers, which retain their existing business logic, validation, safety checks and command implementations. The registry recognizes these operations but does not replace their implementations or weaken their per-action checks. This is an incremental adapter boundary: most legacy mutations are still in `server.js` and their original modules. They have not all been extracted into provider modules.

For Remote Linux, dispatch calls `suiteProviders.read` with a fixed registered operation. That collects a cloned target/configuration, runs the strict SSH inspector, checks optional explicit TLS database access, reconstructs capabilities from approved evidence, and applies the required capability. Unsupported providers and missing adapters fail closed. No nonlegacy request can fall through to a Hyper-V handler. Wrong methods and unregistered routes are refused, including historical mutating GET operations.

The provider facets remain distinct:

| Facet | Current implementation | Next adapter work |
|---|---|---|
| VM/hypervisor | Original Hyper-V facade; none for Remote Linux | Explicit Proxmox inventory/VM adapters with API authentication/identity; no inferred mapping from game state |
| Runtime | Strict SSH + native/systemd/selected Docker observations | Runtime lifecycle, protocol health and supported workload topology |
| Filesystem/configuration | Bounded canonical-slot reads; original legacy filesystem functions | Provider path model, ownership/permissions and conditional backup/write/rollback |
| Database | Existing legacy transport; separate verified-TLS Remote Linux transaction | Additional validated schema profiles; safe read-only views/functions; provider backup/restore adapters |
| Administrative transport | Legacy receiver/AMQP/admin paths retained | Explicit authenticated protocol adapter, requests/receipts/postcondition semantics |
| Capabilities | Fixed backend feature registry and evidence-derived read admission | Operation-specific mutation implementations and deployment evidence; no type-wide enable flag |

The complete 42-family compatibility matrix and route/predicate inventory are in `FEATURE-COMPATIBILITY-MATRIX.md` and its JSON companion. Hosting-independent rendering, parsers, planning, validation and journaling are identified there for reuse. Reusable logic is not automatically enabled if its current transport has side effects or unresolved target assumptions.

## Target stability

`lib/providers/target-binding.js` pins cloned configuration snapshots using AsyncLocalStorage. API work binds the provider, VM/SSH identity, deployment root/selector, database endpoint/credentials, selected battlegroup, receiver and transport settings. `loadConfig` returns the snapshot during bound work and rejects a conflicting on-disk target. Already-open remote/database connections remain attached to their original captured settings; they never reconnect to a newly selected target.

`saveConfig` rejects target/credential/scope changes while a request lease or registered Suite operation is active. UI-only preferences remain outside the target identity. Selecting a battlegroup uses the same guard without taking a lease that would block its own idle selection. Masked secret placeholders are compared as the existing secret rather than as a new target.

An opaque random UI revision changes when target identity changes. Player, configuration, health and Explorer caches are cleared. Late adapted read responses are discarded if that revision changed before display. Target fingerprints and credentials are never returned in the compatibility report.

These locks are process-local. They cover the Suite's supported configuration API and registered jobs; they are not a cross-process filesystem lock or a hypervisor/runtime lease. Manual file edits are detected on subsequent bound `loadConfig` calls. They cannot revoke a query already sent to a captured old endpoint. External batch consoles and tools are not registered Suite operations; their lifetime is not fully controlled by this architecture. These are explicit remaining risks, not claims of global operation fencing.

Operational Hyper-V profiles still cannot be silently converted into a remote diagnostic profile. Provider selection requires a separate/unfinished isolated profile where necessary. Startup permissions remain fixed for the process; reopening after setup is required to start permitted legacy services. No selected type starts remote writers or services automatically.

## Backend and desktop safety

All new feature reads require the local Suite, a loopback peer, correct local Host/port and matching Origin; cross-site requests and remote portals are denied. New responses use `Cache-Control: no-store`. The UI uses the same registry to select existing loaders and disable unavailable controls, but backend admission is independent of the UI.

Nonlegacy desktop IPC cannot launch `battlegroup.bat` or arbitrary local paths. These checks run in Electron's main-process handlers before side effects. The local document Designer and file-selection dialogs retain their existing app-level validation; they do not grant game-server capabilities.

No Remote Linux start/stop/restart, update, VM/disk, teleport, grant, repair, Market Bot, scheduler, backup/restore/import, database write, filesystem write/delete or administrative API operation is enabled. A simulated report marked Verified cannot enable one. Discontinued Migration Maintenance Mode remains disabled; no obsolete workflow was restored.

## Database Explorer boundary

The adapter uses the Phase 3 dedicated direct-TLS connection path, never the legacy superuser/credential-discovery/tunnel path. Every operation starts a fresh read-only transaction, checks effective restricted privileges, validates a plain table/SELECT/PK/types/no-RLS/no-inheritance profile, holds an ACCESS SHARE lock against schema replacement, and rolls back/closes on completion or failure.

Schemas/tables/metadata list only the approved table. Rows use a fixed SELECT with bound page-size/offset parameters; page size is 1–100 and offset 0–10,000. Only `id`, `character_name`, `online_status` are returned; names/cells are bounded. Filtering, custom sorting, arbitrary selected columns, SQL, relations, views and custom types are refused. PostgreSQL transaction restrictions are an additional safeguard, not an arbitrary SQL sandbox. [PostgreSQL transaction documentation](https://www.postgresql.org/docs/current/sql-set-transaction.html).

This narrow profile may not match real Dune deployments, particularly decrypted views or custom status enums. Those remain Unsupported, even if PostgreSQL connects successfully. The manually supplied database endpoint's association with the game deployment also needs independent owner evidence. Private player/Explorer rows never enter cached/shared compatibility reports. Page CSV/JSON exports are explicit local exports of those private rows, not sanitized support reports.

## Evidence and assumptions

31 selected regression groups passed; machine results are in `unified-regression-results.json`. Fifteen audited legacy function bodies match original commit `c2047a265ac6c34a8fd2f55a12a38f73289dc712`; this is static preservation evidence, not proof of all live Hyper-V behavior. Target-edit concurrency is intentionally stricter than the old behavior to satisfy this phase's safety requirement.

Browser checks used a disposable loopback backend with mock SSH/catalog responses and all real outbound connections blocked. Existing pages, approved reads, disabled writes, private-data scope, report exclusion and limited Explorer controls were inspected. The screenshot is explicitly simulated evidence. Native Electron handlers were tested in a VM context; no fresh packaged Electron runtime was available and none was built.

No real Linux/Dune/PG deployment, systemd daemon, Docker discovery engine, Kubernetes cluster or Proxmox host was tested. The Phase 3 real-container recipe remains unexecuted on this workstation because Docker/Podman/WSL are unavailable. Existing source assumptions about binary layouts, PG schema semantics, permissions, DHCP/VM-IP refresh behavior and background job contexts need real validation. Nothing is promoted to Verified.

Mutation contracts and provider-specific requirements are in `MUTATION-ADAPTER-DESIGN.md`; owner validation instructions are in `REAL-SERVER-VALIDATION.md`.
