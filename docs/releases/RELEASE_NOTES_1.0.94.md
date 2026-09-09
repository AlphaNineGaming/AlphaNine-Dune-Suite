# AlphaNine Dune Suite 1.0.94

## Market Bot update deadlock repaired

Version 1.0.93 could detect an older persistent Market Bot but offered no safe way to update it. The normal pause action rejected the version mismatch, while the background installer refused to replace an activated bot until it was already authoritatively Quiescent.

Version 1.0.94 adds **Repair / Update Bot** to Market Automation when an installed bot has a compatible pause protocol but its version or generation disagrees with the Suite. The repair:

- republishes a newer pause generation through the existing runtime;
- binds the exact remote configuration fingerprint;
- independently proves the pause marker, absent cycle lease, free bot-specific lock, stable tracked listings, and zero unfinished cycles before replacing anything;
- installs and verifies the bundled current runtime; and
- always leaves the bot paused for operator review.

The repair never creates, removes, restocks, or resumes listings.

## Quiescence now tracks Market Bot activity only

The old proof counted every database advisory lock, active writer, open transaction, and untracked Exchange-order change. Ordinary players or game services could therefore keep a correctly paused Market Bot in Draining indefinitely.

Quiescence now tests the Market Bot's own advisory lock, cycle lease, unfinished cycle evidence, and tracked-listing digest. Unrelated player and database activity no longer blocks a safe pause. When proof still fails, the UI shows the specific failed condition instead of a generic message.

## Verification

- Go Market Bot unit suite.
- Market Bot JavaScript regression suite.
- Rendered UI syntax suite.
- Packaged runtime and Windows installer verification.
