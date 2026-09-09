# AlphaNine Dune Suite 1.0.22

Market Bot Linux binary packaging hotfix.

## What Changed

- Rebuilt the bundled Market Bot executable as Linux/amd64 so Kubernetes can run it inside the VM.
- Fixes Market Bot pods crashing with exec /app/market-bot: exec format error.
- Keeps the 1.0.21 install diagnostics so any future startup failure shows pod status and logs.

## Notes

- This update does not delete or recreate market listings.
- After installing Suite 1.0.22, run Market Bot -> Install / Update Bot again to replace the bad VM binary.