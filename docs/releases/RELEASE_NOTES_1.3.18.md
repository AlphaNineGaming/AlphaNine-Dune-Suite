# AlphaNine Dune Suite 1.3.18 — Live Map Player Selection

Choose a player directly in **Live Map → Live Teleport** with the new **Player** dropdown. It uses the Suite's shared player directory and includes characters that are missing from the current map's markers. **Refresh Players** reloads the list.

Selecting a player does not move the character or change the camera. Click a destination to use the existing teleport controls. Marker selections keep the dropdown in sync, and teleport requests now display the name of the player selected in Live Map.

Existing teleport eligibility, map/partition resolution and receiver checks still apply. Selecting an Arrakeen character does not enable Hagga Basin map-click teleport or clear Travel state.

Character Recovery diagnostics also include the installed server's login, full actor loading, saving and travel helper definitions for read-only verification through the Suite. No travel helper is invoked and recovery safety checks remain unchanged.

Fully exit the Suite, install **AlphaNine-Dune-Suite-Setup-1.3.18.exe**, and reopen it.

Validation: player-dropdown identity and selection tests, 58 recovery/diagnostic regression tests, player-directory tests, teleport readiness/SQL resolution, rendered UI syntax, update integrity and packaged-runtime checks.
