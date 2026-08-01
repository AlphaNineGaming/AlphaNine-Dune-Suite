# AlphaNine Dune Suite 1.0.83

## Easier Windows Firewall experience

This release fixes the Windows Defender Firewall “blocked some features” prompt reported after 1.0.82. The prompt was caused by the authenticated HTTPS portal listening for LAN connections automatically, not by malware detection.

- The HTTPS portal now listens only on `127.0.0.1` by default, so normal local use does not request Windows Firewall access.
- Phone and LAN access is an explicit opt-in under **Web Portal → Phone / LAN Access**.
- LAN access requires the Secure Remote Access password and can be enabled or disabled without restarting the Suite or VM.
- If Windows asks after LAN access is enabled, the UI clearly instructs users to allow **Private networks only** and leave Public networks unchecked.
- Cloudflare Internet Access remains available as a separate outbound connection and does not require an inbound router or Windows Firewall port.

## Verified self-updates

- The Install Update button is enabled only when GitHub provides the installer’s SHA-256 digest and exact file size.
- The desktop app verifies both values after download and before launching the installer.
- Incomplete, altered, or mismatched downloads are deleted and never executed.
- Update progress clearly separates downloading, SHA-256 verification, and installer launch.

## Storage visibility diagnostics

- Storage deposits create durable receipts with the target container, item IDs, slot positions, and verification state.
- The Suite can safely re-check database stability and explain when the game client may need the container reopened or the server restarted before the new item becomes visible.
