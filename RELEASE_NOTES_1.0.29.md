# AlphaNine Dune Suite 1.0.29

Critical updater recovery release for the 1.0.28 version-detection loop.

## Fixed

- Fixed the Suite reporting version 1.0.27 after successfully installing 1.0.28.
- Stops the updater from repeatedly detecting and reinstalling the same update.
- The running Suite now reads its version directly from the packaged `package.json` instead of a separate hard-coded value.
- Includes the Market Bot VM-IP synchronization improvements introduced in 1.0.28.

## What To Do

- Install 1.0.29 once when the Suite offers the update.
- After installation, the Suite should display version 1.0.29 and report that it is current.
- No Market Bot reinstall or configuration reset is required.
