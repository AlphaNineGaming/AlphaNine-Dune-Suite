# Local provider test environments

## Current extended lab — unexecuted development recipe

Run `node scripts/provider-lab/run-container-lab.cjs` from the Suite root for the
new disposable Linux/OpenSSH/PostgreSQL lab. It uses **Dockerfile.linux**, not the
older Compose recipe below. Docker, OpenSSH/keygen, Node and the Suite's `pg`
dependency must already be available. Set `A9_PROVIDER_LAB_BASE` to an explicitly
selected `debian:bookworm-slim@sha256:<64-hex-digest>`; floating tags are refused.
Packages come from Debian's signed archive snapshot `20250901T000000Z`. The
immutable built image ID, base and results are recorded under
`work/provider-container-lab/`. No Docker installation or system configuration
is performed by the runner.

The lab uses a synthetic ELF/PAK/config layout, synthetic GET-only engine protocol,
real PostgreSQL fixture schemas/roles, disposable keys and TLS certificates.
It tests authentication/trust refusal, Linux process/file reads, explicit container
scope, database auth/TLS/schema/privilege failures, missing permissions, unsupported
layouts and interrupted connections. It does not contain or test a real Funcom
server, Docker discovery daemon, systemd service or Kubernetes cluster. A passing
lab never authorizes mutations or a Verified compatibility label.

Only the generated SSH public key is mounted. Ports bind to loopback. The exact
run ownership label is checked before removing the fixture container; there is
no broad prune. Lab images and private keys remain under their exact run name and
work directory for investigation. Do not attach production credentials/storage.
The prerequisite check is non-success with `not_executed` if Docker/OpenSSH is
unavailable. This lab has not been built or executed on the development workstation.

For all fixture regressions set `ALPHANINE_TEST_PYTHON` and `PYTHON` to an actual
Python 3 interpreter before `node scripts/test-provider-suite.cjs`. Python fixture
tests on Windows do not establish Linux-specific compatibility.

Run `node --test scripts/test-provider-foundation.cjs` from a complete Suite source tree. This needs Node and no dependencies, credentials or network access. The mock transport and actual local Node subprocess fixture are deterministic. The fixture does not implement Linux, SSH, Docker, Kubernetes or PostgreSQL. These tests cannot verify those deployments.

Run `node scripts/test-provider-suite.cjs` for the selected active legacy regressions plus new tests. It uses disposable temporary files under work/provider-tests and writes a results.json. Any failed case causes a nonzero exit. The discontinued migration workflow test has been removed; shared SSH retry behavior remains covered by test-read-only-ssh-retry.cjs. HTTP integration runs only against disposable loopback backends with a preload that prevents actual external process execution.

## Optional real SSH container recipe: NOT executed or verified

This is an additional lab recipe, not evidence of compatibility. Docker was not installed in the development environment. The image argument must be an approved immutable `alpine@sha256:...` reference. The apk dependency versions remain unresolved until built; record their installed versions and the resulting image digest, retain the image and rerun against that exact digest before calling the container environment reproducible. Do not substitute `latest`.

Use only lab credentials. Generate a dedicated key pair in this directory with `ssh-keygen -t ed25519 -f client_ed25519`, then build/start the Compose service locally after supplying ALPINE_IMAGE. The SSH listener binds the host loopback interface only. No production credentials, Docker socket, server volumes or real database are mounted. The server supports public-key authentication only.

Capture the lab host public key from the container using `docker compose exec ssh-lab cat /etc/ssh/ssh_host_ed25519_key.pub`. Construct a dedicated known-hosts entry `[127.0.0.1]:22222 <key-type> <public-key>` from that directly observed key. Use absolute host paths for the client private key and known-hosts file in an endpoint JSON:

```json
{
  "serverType": "remote-linux",
  "host": "127.0.0.1",
  "port": 22222,
  "user": "diagnostic",
  "keyPath": "<absolute lab private-key path>",
  "knownHostsPath": "<absolute lab known-hosts path>",
  "runtimeRoot": "/srv/dune"
}
```

From the Suite root run `node scripts/diagnose-provider.js --endpoint-file <endpoint.json> <new-report.json>`. Only explicitly supplied endpoints are contacted. The CLI never auto-discovers a host. It refuses to overwrite the report destination. Exit 0 means a Linux OS was observed, 2 means Linux was not established, and 1 means input/export/transport setup failed; none means game compatibility was Verified. Inspect individual checks for partial failures.

Validation cases still required: correct key; missing/replaced known-hosts entry; wrong client key; unreadable runtime root; empty or missing OS-release file; IPv4 nondefault port; paths with spaces; dropped SSH connection; response/timeout limits. IPv6 endpoint support is not implemented. Add real game runtime/schema cases only with disposable data and separately scoped read-only credentials.

Stop/remove only this Compose lab using `docker compose down` when finished. A recreated container has a new host identity: re-establish lab trust directly rather than disabling host verification. Never attach real server storage to this recipe. Do not publish a release from this test environment.
