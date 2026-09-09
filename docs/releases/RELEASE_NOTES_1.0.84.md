# AlphaNine Dune Suite 1.0.84

## Distribution notice

- This Windows installer is not Authenticode-signed. Windows may display an unknown-publisher or reputation warning.
- The Suite verifies the GitHub-published SHA-256 digest and exact file size before launching this unsigned installer.

## Known Resource Spawn Locations

- Adds an optional Live Map layer containing 117 Hagga Basin spawn locations: 87 Small Spice and 30 Flour Sand.
- Adds resource-type filters, search, counts, Show All, Hide All, clustering, and X/Y/Z marker details.
- The layer is disabled by default and clearly identifies these as possible spawn locations, not live active-resource state.
- Resource markers are non-draggable, cannot become teleport targets, and use the Suite's existing world-coordinate conversion.
- The packaged dataset contains only resource names and numeric coordinates with provenance metadata; no game map or proprietary asset is bundled.

## Experimental Resource Areas

- Adds ten optional procedural-distribution overlays for Bauxite, Magnetite, Azurite, Dolomite, Erythrite, Jasmium, Basalt, Cistanche, Primrose Field, and Saguaro.
- Uses Maximum-Y orientation with authoritative IgwLevelBounds of `-457200..355600` on both axes and labels values only as heatmap intensity.
- Generates overlays locally from the user's installed `Tools.pak`; no raw or derived heatmap images are included in the installer.
- Keys the local cache to the installed Steam build ID and full `Tools.pak` SHA-256 so a changed build or PAK regenerates instead of reusing stale overlays.
- Applies a monotonic contrast display curve so low nonzero heatmap intensity remains visible at the default 45% opacity; zero intensity stays transparent and location data is unchanged.
- Fixes packaged first-click activation: a cache miss now uses the bundled, licensed local extraction helper, selects all ten types when no prior selection exists, reports preparation and image-load failures visibly, and preserves saved filters across master-toggle off/on cycles.
- The feature is experimental and disabled by default. It does not claim exact nodes, guaranteed spawns, live activity, depletion, or quantities.
- Maximum-Y orientation was independently cross-checked. No third-party code, markers, CDN files, map tiles, icons, or heatmap images were incorporated.

### How to use Experimental Resource Areas

1. Open **Live Map** and select **Hagga Basin**.
2. Enable **Experimental Resource Areas**. On first activation, all ten resource filters are selected automatically.
3. Wait for **Preparing resource areas…** to change to **Resource areas ready.** The first generation can take time because the Suite reads the locally installed `Tools.pak` and creates a writable local cache.
4. Use the individual resource filters and the opacity control. Turning the master toggle off hides the overlays without erasing those selections.
5. If `Tools.pak` is not detected, select **Select Game Folder** and choose the Dune Awakening installation folder containing `DuneSandbox\Content\Paks\Tools.pak`, then select **Retry**.

The overlays require the locally installed game files on the Suite computer. They remain disabled by default and represent heatmap intensity—not exact nodes, guaranteed spawns, active resources, quantities, or depletion state.

## Verified self-updates

This release keeps the unsigned NSIS distribution flow used by earlier Suite builds while retaining release-asset integrity checks.

### Update verification

- The Install Update button is enabled only when GitHub provides the installer’s SHA-256 digest and exact file size.
- The desktop app verifies both values after download and before launch.
- Incomplete, altered, or mismatched downloads are deleted and never executed.
- The update screen shows separate downloading, SHA-256 verification, and launch states.

### Release flow

- The Windows release command runs update-integrity, icon, packaging, and packaged-runtime checks before publication.
- Authenticode publisher verification is not required by this release flow.

### Easier Windows Firewall experience

- The authenticated HTTPS portal now listens on `127.0.0.1` by default, so local users do not need to approve a Windows Firewall prompt.
- Phone and LAN access is an explicit opt-in from Web Portal and requires the Secure Remote Access password first.
- Enabling or disabling LAN access rebinds the HTTPS listener immediately without restarting the Suite.
- The confirmation and status text instruct users to allow **Private networks only** and leave Public networks unchecked if Windows asks.
- Disabling Private LAN Access immediately removes the LAN listener while preserving local and outbound Cloudflare Tunnel access.
