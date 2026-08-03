# Third-party notices

AlphaNine Dune Suite includes third-party libraries under their respective licenses.

## repak 0.2.3

The Windows package includes the `repak` command-line tool by Truman Kilen and contributors. It is used locally and read-only to extract the ten proven heatmap data assets from the user's installed `Tools.pak`. AlphaNine verifies a bundled offline decompressor before invoking repak, so repak's network fallback is not used. The package does not include or download Funcom archives, maps, heatmaps, or other game assets.

Copyright 2024 Truman Kilen, spuds

Licensed under either the MIT License or the Apache License, Version 2.0. The complete license texts are packaged beside `tools/repak/repak.exe`.

## ooz / pyooz offline decompressor

The package includes a locally built compatibility DLL derived from q3k's `pyooz` distribution of the open-source `ooz` Kraken-family decompressor. It is used only to read compressed data from the user's own installed `Tools.pak`. It is not the proprietary RAD Game Tools Oodle DLL and contains no Funcom data or assets.

Copyright 2018 Fabian Giesen, and pyooz contributors.

Licensed under the GNU General Public License, version 3 or later. Complete corresponding source, the AlphaNine ABI shim, build instructions, and the GPL text are packaged in `tools/repak/ooz-source`.

## DST - Dune Server Tool category metadata

The bundled Market Bot category-mask seed is derived from DST - Dune Server Tool:

Copyright 2026 Coastal (Discord: @allcoast)

Project home: https://github.com/coastal-ms/DST-DuneServerTool

Used under the Apache License, Version 2.0. The original project notice is preserved here. This metadata lets Market Bot listings appear in the correct in-game Exchange categories.

## Historical Market Bot attribution

Historical Suite releases contained Market Bot deployment YAML, item-data, and binary assets with lineage to the public IceHunter `dune-awakening-truenas` Market Bot and Dune-Admin projects by Ryan Wilson:

https://github.com/Icehunter/dune-awakening-truenas

Those historical Market Bot assets were removed before the current persistent Market Bot implementation and are not included in AlphaNine Dune Suite 1.0.71.

## Dune-Admin attribution

Portions of the Suite's administration workflow were adapted with reference to Dune-Admin by Ryan Wilson. The accessible upstream repository does not currently provide a root license file or other license grant that was independently documented during the 1.0.71 provenance audit.

This notice preserves factual attribution only; it does not assert an undocumented license.
