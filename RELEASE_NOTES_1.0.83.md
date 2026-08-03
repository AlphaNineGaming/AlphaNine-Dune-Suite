# AlphaNine Dune Suite 1.0.83

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
- Icehunter was consulted only as independent orientation evidence. No Icehunter or Red-Blink code, markers, CDN files, map tiles, icons, or heatmap images were incorporated.

## Verified and signed self-updates

This release hardens the Suite updater after Windows Defender blocked the unsigned 1.0.82 installer.

### Update verification

- The Install Update button is enabled only when GitHub provides the installer’s SHA-256 digest and exact file size.
- The desktop app verifies both values after download and before launch.
- Windows must report a valid trusted Authenticode publisher signature for the installer.
- Incomplete, altered, unsigned, or untrusted-publisher downloads are deleted and never executed.
- The update screen shows separate downloading, SHA-256 verification, publisher verification, and launch states.

### Release protection

- Local unsigned builds remain available for developer testing only.
- The new Windows release command fails before packaging unless a trusted code-signing identity is configured.
- After packaging, the release command independently verifies valid Authenticode signatures on both the installed application executable and the NSIS installer.
- Public release documentation now prohibits publishing artifacts produced by the unsigned local-build command.

### Easier Windows Firewall experience

- The authenticated HTTPS portal now listens on `127.0.0.1` by default, so local users do not need to approve a Windows Firewall prompt.
- Phone and LAN access is an explicit opt-in from Web Portal and requires the Secure Remote Access password first.
- Enabling or disabling LAN access rebinds the HTTPS listener immediately without restarting the Suite.
- The confirmation and status text instruct users to allow **Private networks only** and leave Public networks unchecked if Windows asks.
- Disabling Private LAN Access immediately removes the LAN listener while preserving local and outbound Cloudflare Tunnel access.

Signing a new file does not guarantee immediate SmartScreen reputation, but it establishes a consistent verified publisher identity so reputation can carry across future releases.
