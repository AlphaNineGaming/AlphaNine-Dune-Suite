# AlphaNine Dune Suite 1.0.76

## Server Health

- Added a Suite-native Server Health page for the Dune Hyper-V VM, SSH, Kubernetes, storage, and critical services.
- Added bounded, read-only checks for every Kubernetes namespace, pod, container, workload, node, service endpoint, persistent volume claim, and recent warning event.
- Added PostgreSQL, RabbitMQ, Dune server, Receiver, and Market Bot status cards.
- Added CPU, memory, disk, Kubernetes metrics, and node-pressure reporting. Optional metrics show as Unavailable without lowering server health.
- Added manual refresh, optional 60-second auto-refresh, and scan overlap protection.

## Status accuracy

- Current healthy workloads no longer remain Unhealthy because of historical restart counts, completed failures, or retained Kubernetes warning events.
- Failed one-shot jobs remain visible as history without incorrectly lowering the live namespace or overall server state.
- Container last-termination details remain available for diagnosis while current readiness determines health.
- Added redaction for credentials and sensitive values in concise diagnostics.

## Verification

- Added parser, state-classification, redaction, optional-metrics, concurrency, and read-only safety regression coverage.
- Verified the feature in the packaged Windows runtime.
