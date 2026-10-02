# AlphaNine Dune Suite 1.3.14

Teleport no longer depends on the vendor battlegroup-status command. Online teleport checks the selected RabbitMQ pod's readiness and active game-command consumer before publishing. Offline teleport uses its existing database routine checks.

Transport failures report the failed check instead of the generic "Server is not online" message. Failed online requests no longer fall back to an offline database write. Restart the Suite and its managed receiver after installation so both use the updated readiness protocol.
