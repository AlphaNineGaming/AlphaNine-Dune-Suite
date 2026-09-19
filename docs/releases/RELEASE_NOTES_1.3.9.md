# 1.3.9 — VM Connections and Portal Live Give

This release combines the VM connection improvements from test build 5 and the web portal Live Give fix from test build 6, including the earlier receiver and health-check fixes.

- Reuse confirmed VM SSH connection details for 30 seconds and share concurrent discovery. Settings changes, VM control actions and failed SSH commands invalidate the cache. Failed commands are not automatically replayed.
- Share pending Hyper-V status reads and prevent older UI responses from replacing newer results. The initial Hyper-V query can still be slow.
- Let the authenticated HTTPS portal check Live Give availability without calling desktop-only diagnostics. The new response excludes credentials, paths, URLs and raw diagnostic errors. Existing role, CSRF and Owner confirmation checks remain enforced.
- Discover Give Item receiver targets using compact pod fields to avoid output-buffer failures when many historical backup pods exist.
- Exclude completed pods from health inventory while retaining failed pods. Limit concurrent health checks and share SSH connection discovery during scans.
- Report unavailable probes separately from confirmed unhealthy workloads, preserve SSH error messages, and avoid presenting missing warning data as zero warnings.

The changes do not delete historical backup pods or alter backup schedules. Operator permissions for queue and storage actions are unchanged.

## Validation

The affected PC confirmed Solari delivery and a healthy scan with the earlier test builds. The build 5 connection-cache and build 6 portal changes passed local regression tests; their live validation has not yet been reported.

Windows 25H2 was the reported onset of the original delays, not a proven root cause. The initial Hyper-V lookup remains a separate performance limitation.
