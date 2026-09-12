# AlphaNine Dune Suite v1.3.4 - Reward Notifications and Blueprint Builder

Adds an in-game whisper after verified inventory grants, showing the actual item and quantity. Give Item and Give Queue include notification status. Whisper failures do not retry or invalidate the item grant.

- Requires an online recipient and selected battlegroup.
- Creates a dedicated AlphaNine Rewards chat account on the first eligible notification; existing player accounts are not overwritten.
- Database grants mention that relogging may be needed.
- Ordinary live grants currently report only published/queued, so they do not trigger a received-reward whisper. A receiver must report verified delivery to trigger it.
- Does not create native Claim Rewards packs or alter existing claims.

Automated protocol, recipient, failure, verification-gate, grant regression, and rendered UI tests passed. Actual in-game whisper rendering has not been verified for this release.

## Blueprint Builder

Open Blueprints > Open Designer to create local 3D construction projects in a separate sandboxed window. Includes 565 native construction pieces, socket snapping, selection, editing, undo, White/Gray display colors, and project copies. Existing Suite settings and reward notifications are preserved.

The builder is experimental. Imported native blueprints remain read-only, and general game export is unavailable in the builder UI. Catalog coverage does not establish in-game placement compatibility for every piece.
