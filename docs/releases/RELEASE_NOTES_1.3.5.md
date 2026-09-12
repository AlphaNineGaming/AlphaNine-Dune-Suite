# AlphaNine Dune Suite v1.3.5 — Blueprint Designer

Build local 3D construction projects from Suite → Blueprints → Open Designer.

- Includes 565 supported native structural piece types, socket snapping, transforms, duplication, and undo/redo.
- Save and reopen editable .a9project files. Export Blueprint JSON for the existing Suite server import flow.
- Open existing blueprint JSON for viewing and copying.
- Fixes first-run startup, window visibility, and focusing an already-open Designer.
- Designer follows all five Suite themes, including live changes, viewport backgrounds, and selection highlights. Changing themes preserves unsaved projects.
- Retains the reward notification features from 1.3.4.

The Designer remains experimental. Its catalog is tied to game build 24654038 and does not include every game object or placeable. One unresolved catalog entry is excluded. Saving/exporting uses new files and does not overwrite existing files.

Validation: 93 Designer regression tests, launcher/startup checks, Suite UI syntax checks, and live desktop checks for all five themes passed. Earlier verification covered the 20-step Designer workflow, all 565 types rendering/exporting and transactional database imports, plus a sample CHOAM room in-game. Gameplay validation does not cover every piece or arrangement.

Install the 1.3.5 Windows installer below, or use Suite's update check.
