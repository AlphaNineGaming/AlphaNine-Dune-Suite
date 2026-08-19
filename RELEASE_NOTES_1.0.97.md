# AlphaNine Dune Suite 1.0.97

## Market Bot resume proof fix

The Market Automation page could display the exact requested generation as **Quiescent**, then reject **Resume Bot** when a second status read landed in the narrow interval while the runtime was refreshing its bounded proof.

Resume now accepts the normal matching Quiescent proof immediately. If that one status read is temporarily non-Quiescent, the Suite independently verifies the same pause generation and configuration fingerprint, the durable pause marker, absence of a cycle lease, two stable Market Bot database samples, no advisory lock, and no incomplete durable cycle before publishing Resume.

The safety behavior remains fail-closed: generation or fingerprint disagreement, a missing pause marker, an active lease or lock, changing evidence, a wrong battlegroup, or an incomplete cycle still blocks Resume.

After Resume succeeds, the page also replaces any stale resume error with the live running state. **Waiting for Exchange inventory** now remains visibly distinct from a pause failure: it means the bot is running and will retry automatically after the game server assigns the Exchange inventory.
