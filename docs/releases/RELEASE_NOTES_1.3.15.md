# AlphaNine Dune Suite 1.3.15 — Teleport Routing Hotfix

This hotfix corrects a readiness-check regression introduced in 1.3.14 that could block teleport with **"Teleport command queue has no active game consumer"** while the server was running.

## What changed

- Teleport now follows the `heartbeats` exchange bindings for the `notifications` routing key to identify the actual destination queues. It no longer assumes a queue is named `notifications`.
- Supports generated queue names, direct/topic/fanout exchanges, and exchange-to-exchange routes.
- Keeps checks for the selected messaging pod and active consumers. Missing routes and unavailable consumers still produce specific errors.
- Detects older running receivers and prompts a restart so the corrected checks are loaded.

Offline teleport retains its existing database checks. The vendor battlegroup-status CLI is still not required for teleport.

## Updating

Fully exit the Suite, install **AlphaNine-Dune-Suite-Setup-1.3.15.exe**, and reopen it. If prompted, use **Setup Doctor → Restart Receiver**.

Thank you for the follow-up reports, and sorry for the extra update needed to correct the queue-name assumption.
