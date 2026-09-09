# AlphaNine Dune Suite 1.1.0

This release makes the persistent Market Bot easier to manage and adds direct visibility and control over the real in-game market.

## Market cleanup

- **Clean Bot Market** no longer depends on the removed Migration Maintenance workflow.
- Cleanup automatically pauses and drains the bot, verifies authoritative quiescent state, and removes only listings tracked as bot-owned.
- Player listings remain protected.
- Uninstall with bot-listing removal uses the same guarded cleanup path.

## Live market tracking

- The bot catalog and exact preview are collapsible and closed by default.
- Catalog rows are clearly identified as potential bot inventory rather than current market listings.
- **Live In-Game Market Listings** reads current sell orders from the game database and shows item, Exchange, seller type, price, stack, grade/tier, and expiration.
- Live rows support search and adjustable row limits.

## Exchange selection

- **Bot Listing Exchange** is populated from the server's live Exchange records.
- Exchanges require a configured inventory, access point, and unique name before they can be selected.
- First-time activation records the chosen Exchange.
- Changing an active bot's Exchange pauses and drains it, installs the new target, and leaves it paused for an explicit resume.
- Existing listings stay at their original Exchange until they expire or are removed with **Clean Bot Market**.

## Arrakeen Exchange initialization

- When the Arrakeen world partition exists but its Exchange records are absent, Market Automation offers **Initialize Arrakeen Exchange**.
- Initialization begins with a read-only inspection and uniquely named recovery snapshot.
- Apply requires exact typed confirmation plus a final confirmation dialog.
- The transaction re-checks the previewed state and aborts on expiration, changes, duplicates, ambiguous inventory links, or conflicting access points.
- It may add only `Arrakeen_EX`, its linked inventory, and `Arrakeen_AP`.
- It never creates, deletes, modifies, or moves market listings and does not automatically retarget the bot.

The Market Bot runtime remains at 1.0.98 because its exact Exchange targeting was already supported; version 1.1.0 changes Suite-side orchestration and visibility.
