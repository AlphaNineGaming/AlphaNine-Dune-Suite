# AlphaNine Dune Suite 1.0.83

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
