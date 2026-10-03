# AlphaNine Dune Suite 1.3.21 — Clear Recovery Previews

Manual Character Recovery now clears the old safe-destination error when coordinates change and displays **Previewing coordinates…** while validating the destination. A successful preview explicitly tells you to click **Recover to Hagga Basin** to confirm.

Fixed a race where an earlier automatic destination lookup could overwrite a newer manual preview. Editing coordinates or closing recovery invalidates pending previews, preventing stale confirmations.

The protected recovery operation is unchanged: offline player, stopped server, verified backup, original pawn identity, pre-commit verification and final read-back. Manual height acknowledgement remains required.

Validation: all 96 recovery tests passed, including delayed automatic lookup success/failure, preview progress/error feedback and invalidated confirmations. Rendered UI syntax and packaged-runtime checks passed.
