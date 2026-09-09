# AlphaNine Dune Suite 1.0.93

## Market Bot can be enabled again

Version 1.0.92 could fail while installing Market Bot with:

> config fingerprint does not match the canonical Market Bot policy

The Suite included UI-only pricing provenance in its SHA-256 input, while the Linux Market Bot correctly recalculated the fingerprint from executable policy fields only. The safety check rejected the disagreement and left the status probe at `UNKNOWN`.

Version 1.0.93 now serializes exactly the policy fields understood by the Market Bot. It also matches Go's canonical JSON escaping rules, so server-discovered item names containing HTML-sensitive or Unicode separator characters cannot create a future cross-runtime mismatch.

The independent fingerprint check remains enforced. No bypass or manual VM configuration change is required.

## Clearer failed status reporting

When the VM bot returns a structured validation error, the Suite now displays that error directly instead of the raw SSH command line.

## Verification performed

- Passed the Market Bot JavaScript regression suite.
- Passed the Go Market Bot unit suite.
- Passed JavaScript syntax checks for the bot library, server, and tests.
- Generated a complete 1,746-item runtime policy and verified that a compiled Go bot accepted the exact Suite fingerprint.
