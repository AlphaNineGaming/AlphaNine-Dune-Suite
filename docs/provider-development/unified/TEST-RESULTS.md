# Unified regression and UI evidence

**31 relevant groups passed, 0 failed:** 47 Node cases across six provider groups, six portable Python fixture cases inside deployment tests, and 25 existing active regression scripts. Exact stdout/exit codes/timing are in unified-regression-results.json. No test is a real-game compatibility claim.

| Evidence | What was checked | Limit |
|---|---|---|
| Foundation and deployment | Aliases/projection/rollback, fixed SSH args, subprocess failure/timeout/overflow, schema/privacy allowlists and fresh admission | Mocks/local processes; Python runs on Windows |
| Unified HTTP integration | Every adapted route succeeds with synthetic validated evidence; absent schema/unknown deployment/wrong methods fail; no startup effects; credentials masked; concurrent target save refused; private data excluded | Disposable loopback backend; real external SSH/PG are blocked |
| Database adapters | Restricted role, lock/schema/PK/type/RLS/inheritance checks; same-transaction read-only recheck; fixed paging SQL and bounds; arbitrary SQL/relations/filters/sorts refused; rollback/cleanup and driver failures | Mock catalog/query client, not PostgreSQL |
| Routing/target/IPC | Exact route registry, unknown-provider refusal, no legacy fallback, all target-field locks, error release, job conflict, unknown profile and native launch refusal before side effects | VM-context Electron handlers; not actual Electron |
| UI automation | Existing navigation, Players rows/details, disabled rename/recovery/inventory/grants, UserGame schema/read-only controls, existing Explorer grid/exports and disabled filters/custom sorting; no separate Linux dashboard | In-app browser with synthetic backend; SIMULATED-unified-explorer.png |
| Legacy reads | Existing Database Explorer query/limits, player directory caching/selection, INI schema/parser, status/health/cache | Fixture/source tests |
| Legacy safety | Disk admission, operations/battlegroup generation, scheduler, backup/archives/vendor path, ownership repair, active atomic restore/rollback, INI recovery, setup/secret/auth persistence and rendered syntax | No real VM, dump or restore; 15 audited function bodies also hash-match |

Initial failures were obsolete Phase 3 expectations: blanket blocking of newly registered read routes and duplicate-dashboard button functions removed by this phase. They were replaced with shared-route/page tests; production logic was not weakened to satisfy them. During main-process review, malformed profile fallback to Hyper-V was identified and made fail-closed; missing files are unfinished setup, established aliases remain compatible. Final selected tests have no remaining failures. Discontinued Maintenance Mode was not restored.

All selected tests use disposable work profiles or fixture-controlled commands. The real Linux container recipe, genuine Dune/PG schema/protocol, real Docker/systemd/Kubernetes/Proxmox and fresh packaged Electron remain **not executed**. Existing historical discontinued workflow suites and installer/release workflows were not run. This is a relevant regression selection, not a claim that every repository script ran.

The browser recorded an expected old-preview polling error after its disposable backend was stopped for a code refresh; the current preview's shared Explorer query completed successfully. No production process was stopped. Source syntax, both patch replays, archive hashes and baseline preservation are recorded separately.
