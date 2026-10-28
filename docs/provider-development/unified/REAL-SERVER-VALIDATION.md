# Read-only real-server validation plan

This development source is Experimental. Use a separate local source checkout/profile; do not replace the installed Suite, build an installer, or copy production configuration. Nothing was sent to community testers automatically.

## Safe owner procedure

1. Review the feature matrix and deployment limitations. Use existing account access only. If Python 3, SSH trust, a restricted TLS database role or deployment evidence is missing, accept Unsupported; do not change server permissions/schema/services to make the test pass.
2. Independently verify the SSH host key, then supply dedicated trusted known-hosts/key paths. Prefer the standalone diagnostic CLI first; it never imports the Suite backend or installs a remote agent. The Phase 3 endpoint-file format and strict host verification remain unchanged.
3. For UI tests, create an isolated local profile with `{"setupComplete":false}` and separate `ALPHANINE_CONFIG_PATH` / `ALPHANINE_DATA_DIR`; set `ALPHANINE_SKIP_STARTUP_SERVICES=1` and an unused loopback PORT. Run the development backend with its existing dependencies. Select Remote Linux in the existing Setup Wizard, supply explicit connection/root/scope fields and run read-only diagnostics. Do not convert the operational Hyper-V profile.
4. Inspect the **existing** Dashboard, Server Health, Server Control version fields, Players, UserGame Settings, Database and Database Explorer pages. Record which capabilities passed fresh evidence checks. Unknown values must remain Unknown, rather than online/healthy/zero/current.
5. Database access is optional and requires a pre-existing dedicated restricted role, verified TLS and owner-confirmed endpoint association. No role creation, firewall/tunnel change, superuser fallback, Secret extraction, schema mutation or data update is part of this test. Views/custom types may legitimately leave Players and Explorer Unsupported.
6. Compare read results with independent owner observations. Scope matters: process health is not game/login health, a player row ID is not an account ID, limited rows are not online population, and version metadata is not an update assessment.
7. Download/review the sanitized report from Setup Doctor and share it yourself through your chosen channel. Do not share local config/endpoint files, kubeconfigs, keys, database dumps, raw inspect/env output, private player panels or Explorer CSV/JSON exports. Explicit Explorer exports contain private rows and are not sanitized support reports.

## Evidence gates

| Validation | Evidence requested | Pass/fail meaning |
|---|---|---|
| Real Hyper-V regression | Existing installations, alias/missing-version profiles, DHCP/VM-IP discovery, shared reads and backup/restore safeguards in disposable tests | Preserves legacy behavior; does not verify another provider |
| Native Linux/systemd | Genuine layout/version, exact executable/service PID, account permissions and denied/incomplete scans | Scoped runtime/config observations only; protocol health remains unknown |
| Docker discovery | Actual engine API versions, container/image and root-mount binding, permissions and interruption | Validates selected runtime inspector only, not a standalone Docker provider |
| Kubernetes | SSH-host/cluster-node/storage/PVC identity design and permissions | Operational reads stay unavailable until this binding is implemented and reviewed |
| PostgreSQL | TLS/name verification, restricted effective grants, schema-only/PK/type/RLS/inheritance evidence and endpoint association | Validates only the approved read profile; no schema/data changes |
| Explorer | Every schemas/tables/metadata/rows route, bounds, fixed sort, rejection of arbitrary relations/views/SQL, private-report exclusion | Confirms limited table scope; cannot authorize arbitrary DB browsing |
| Target stability | Concurrent read vs config/provider/battlegroup changes, existing long jobs, external edits and stale UI responses | No operation/provider/target mixing; document process-local/cross-process limitations |
| Failure behavior | Denied permissions, wrong host trust, disconnects, TLS/auth failures, locks/timeouts and unsupported layouts | Fail closed; no fallback to privileged/legacy transport |
| UI and desktop | Packaged Electron/source resource paths, common pages, backend denial despite enabled/forged controls, IPC launch guards | Native packaged behavior must be tested separately from a browser fixture |

The disposable real Linux/SSH/PG container recipe remains under `scripts/provider-lab/`. It uses a pinned Debian digest/package snapshot, synthetic ELF/game files and GET-only engine fixture; it never mounts a production directory or the host Docker socket. Docker/Podman/WSL are unavailable on this workstation, so it has not run. Run it on a tester-controlled disposable Docker host before real owner validation, retain its image ID/results and report failures explicitly.

Before any mutation release, implement and validate the contracts in `MUTATION-ADAPTER-DESIGN.md`, including actual backup/restore/rollback and postcondition evidence. Keep provider/feature classification Experimental or Unsupported until separately reviewed actual deployment evidence supports promotion. No release or deployment approval is implied by this plan.
