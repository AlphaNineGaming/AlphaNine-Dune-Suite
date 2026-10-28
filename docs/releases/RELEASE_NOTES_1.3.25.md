# AlphaNine Dune Suite 1.3.25

- Fixed Old Server Packages failing with `stdout maxBuffer length exceeded` on large inventories.
- Added streaming command output, bounded background parsing and parser crash isolation.
- Improved cleanup error reporting and dashboard recovery after failed scans.
- Preserved conservative package retention and protection for referenced images.
- Updated the Discord invitation: https://discord.gg/cz4Zwbt7k

Automatic container cleanup and kubelet policy controls are excluded. This release does not enable container purging or alter kubelet configuration.
