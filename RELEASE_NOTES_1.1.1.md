# AlphaNine Dune Suite 1.1.1

This release makes selecting and monitoring the Arrakeen or HarkoVillage market substantially easier.

- Fixed **Initialize Arrakeen Exchange** failing with `prompt() is not supported` in the Electron desktop app. The protected typed confirmation now uses the Suite-native dialog.
- Fixed the Market Bot remaining in **Draining** when database credential lookup crossed the VM's scoped `sudo kubectl` permission boundary.
- Updated the bundled Market Bot runtime to 1.0.99 with clearer credential and planner failure diagnostics.
- Added direct **Use Arrakeen** and **Use HarkoVillage** choices.
- One confirmation now handles runtime repair/update, safe pause and drain, Exchange persistence, read-only preview verification, and automatic resume for an active bot.
- Added live progress with the current stage, percentage, elapsed time, and activity log.
- Exchange controls remain locked while work is active, and refreshing or reopening Market Automation reconnects to the running operation.
- Arrakeen displays **start map first** until its native map runtime has registered the Exchange.
- The bot catalog remains collapsible, and the read-only live in-game listing tracker distinguishes current listings from the catalog plan.

Existing listings are not moved or removed, player listings are never changed, and the bundled Market Bot runtime is 1.0.99.
