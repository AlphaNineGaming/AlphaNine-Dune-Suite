# AlphaNine Dune Suite 1.0.96

## Market Bot public target matching fix

Version 1.0.95 correctly launched the repair boundary but compared the resolved namespace with a field intentionally omitted from the Market Bot's public status response. The identical selected and installed battlegroup was therefore rejected after repeated polling.

Version 1.0.96 matches the published remote battlegroup to the fully resolved Suite database target, with unit coverage for the namespace-omitting public response. Permanent target mismatches now fail immediately instead of consuming the full retry window.

The repair remains fail-closed. The failed 1.0.95 attempt did not replace the VM runtime or modify listings.

## Safe Market Bot uninstall

Market Automation now includes an **Uninstall Bot** action. The user explicitly chooses whether to keep existing bot-owned listings or remove only listings proven to be Market Bot-owned; player listings and untracked NPC listings are never modified.

Uninstall pauses and proves the exact bot generation Quiescent, supports draining an older pause-compatible runtime without replacing it, stops and unregisters the OpenRC service, removes the VM runtime/configuration/state directory through rollback-staged paths, and verifies that the service, restart path, PID, supervisor, and managed processes are absent before deactivating local state.
