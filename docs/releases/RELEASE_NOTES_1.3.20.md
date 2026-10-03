# AlphaNine Dune Suite 1.3.20 — Explicit Recovery Coordinates

The local **Recover Character** panel now offers **Use coordinates instead (unverified height)**. Enter X/Y/Z or copy the Live Map fields, acknowledge the landing-height limitation, preview, and confirm the named character and exact destination.

The Suite automatically resolves one Hagga partition in the character's compatible dimension. Missing or ambiguous partitions block the operation. Manual coordinates are bound to the preview and never become universal release defaults or an automatic fallback.

This explicit option accepts an administrator-chosen unverified height. The offline database function does not resolve safe ground. Normal recovery still requires a verified safe destination.

Recovery continues to use the existing vendor movement function with a stopped server, offline player, verified safety backup, captured before-state, pre-commit verification and fresh read-back. IDs, ownership, rotation, inventory, equipment, progression and actor state remain protected. No travel records or linked player actors are changed.

Update to **AlphaNine-Dune-Suite-Setup-1.3.20.exe**, then use **Players → select player → Recover Character → Use coordinates instead**.

Validation: recovery regressions for explicit height acknowledgement, partition/dimension ambiguity, bound coordinates, rollback, preserved data and UI selection; rendered UI syntax, read-only live partition SQL, installer integrity and packaged-runtime checks.
