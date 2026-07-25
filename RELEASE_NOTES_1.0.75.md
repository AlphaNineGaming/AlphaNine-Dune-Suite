# AlphaNine Dune Suite 1.0.75

## Database backup compatibility

- Fixed Battlegroup database dumps failing with `permission denied for table alphanine_market_bot_cycles`.
- Market Bot migrations now grant the standard `dune` backup user read access to AlphaNine Market Bot tracking tables and their sequence.
- Existing Market Bot installations receive the permission repair when the versioned runtime is updated.
- Installed but paused or deactivated Market Bots are also updated at Suite startup so their retained tracking tables cannot continue blocking backups.

## Verification

- Confirmed the original failure against a retained Kubernetes dump pod.
- Applied the permission repair to an affected installation and successfully created a fresh 2.1 MB Battlegroup backup.
- Added regression coverage for backup-user grants and upgrade-time migration behavior.
