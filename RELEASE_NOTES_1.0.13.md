# AlphaNine Dune Suite 1.0.13

Market expiration cleanup for manual and automated Market Bot listings.

## What's Changed

- Manual market listings now have the same expiration choices as the game: `1`, `3`, `7`, or `14` days.
- Automated bot restocks now choose a random expiration from those same day options.
- Removed the old long placeholder expiration from Suite market posting and Market Bot buyer/simulation records.
- Bundled a rebuilt AlphaNine Market Bot binary with the expiration fixes.

## Notes

- Existing listings with old long expiration values are not changed automatically. Remove and recreate them from Suite if you want clean expiration times.
- New manual listings should be created with the expiration dropdown in the Market Bot page.
