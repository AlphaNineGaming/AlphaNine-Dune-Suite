# AlphaNine Dune Suite 1.0.11

This release makes the Market Bot VM fallback more tolerant of different Kubernetes layouts.

## Fixed

- The Market Bot fallback no longer searches only the `dune-market-bot` namespace.
- Suite now searches all Kubernetes namespaces for a running AlphaNine Market Bot pod by label first, then by pod name.
- This fixes reports like:

`Market Bot pod not found in namespace dune-market-bot`

## Notes

- The Market Bot is a standalone AlphaNine service controlled by Suite.
- If Suite still reports that no Market Bot pod exists, the bot is not deployed or is not running on that server VM yet.
