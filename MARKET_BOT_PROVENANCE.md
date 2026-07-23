# Market Bot provenance record

This record covers the persistent Market Bot introduced for AlphaNine Dune Suite 1.0.71.

- The current Linux/amd64 daemon, Suite controller, OpenRC installer, preview, target-stock reconciliation, tests, and build integration were created as a replacement for the removed historical Market Bot bundle.
- A read-only comparison against the accessible `Icehunter/dune-awakening-truenas` Market Bot and Dune-Admin source found no meaningful source-code overlap in the replacement. The only longer matches were required Dune database table and column sequences.
- Historical Suite releases contained Market Bot YAML, item-data, and binary assets with IceHunter lineage. Git records those files under `assets/market-bot/` beginning in commit `860fb990b6cb07b6318432d3abc06443204c04b4`.
- Commit `33390b21473a014e53f7a4e8a60051629f8236ac` removed the historical guide, YAML, item-data, and binary. Those historical assets are not part of the 1.0.71 release.
- The 1.0.71 daemon has no third-party Go modules. Its JavaScript controller and build/test scripts use Node.js built-ins only.

This record documents repository provenance and comparison results. It does not make an undocumented license claim for external source or data.
