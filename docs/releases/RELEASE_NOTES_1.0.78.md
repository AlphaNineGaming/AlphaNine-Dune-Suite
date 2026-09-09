# AlphaNine Dune Suite 1.0.78

## Sandworm environmental controls

- Adds confirmed `UserGame.ini` Sandworm sensitivity and threat controls to Server Management → Environmental Rules.
- Supports overall threat sensitivity, maximum threat, decay delay/rate, walking/running/sprinting threat, and vehicle-shooting threat.
- Adds minimum worm separation, danger zones, hibernation, giant-worm enablement, and minimum-player controls.
- Clarifies that the existing Sandworm Enabled control is an on/off gate rather than an aggression multiplier.

## Verification

- Added regression coverage for Environmental Rules wiring and generated `UserGame.ini` field placement.
- Verified representative settings against the generated SandwormSettings section.
