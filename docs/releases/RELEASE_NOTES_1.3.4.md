# AlphaNine Dune Suite v1.3.4 - Reward Notifications

Adds an in-game whisper after verified inventory grants, showing the actual item and quantity. Give Item and Give Queue include notification status. Whisper failures do not retry or invalidate the item grant.

- Requires an online recipient and selected battlegroup.
- Creates a dedicated AlphaNine Rewards chat account on the first eligible notification; existing player accounts are not overwritten.
- Database grants mention that relogging may be needed.
- Ordinary live grants currently report only published/queued, so they do not trigger a received-reward whisper. A receiver must report verified delivery to trigger it.
- Does not create native Claim Rewards packs or alter existing claims.

Automated protocol, recipient, failure, verification-gate, grant regression, and rendered UI tests passed. Actual in-game whisper rendering has not been verified for this release.
