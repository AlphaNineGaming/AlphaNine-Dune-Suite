# AlphaNine Dune Suite v1.3.7 — Local Backup Fix

A backup should still be available if your VM is lost. This update fixes **Create Backup** failing to save a local copy after the Dune server update.

## Fixed: backups created on the VM but not copied to your PC

The updated server saves its database archive in the battlegroup's persistent storage under `Saved/DatabaseDumps`, while the vendor command can still report the old location. This caused the Suite to show:

> The actual VM backup could not be copied locally: The vendor backup artifact could not be statted.

The Suite now resolves the archive through the successful dump operation's own pod and bound storage volume when the reported file is missing, then copies it to your configured local backup folder.

## Verified before reporting success

- Checks that the archive belongs to the correct completed backup operation.
- Keeps stable-file, PostgreSQL archive, full archive-read, and SHA-256 checks.
- Verifies the local copy against the VM archive before marking it usable for restore.
- Preserves support for the previous backup location and reports the underlying file-check error when inspection fails.

**Tested on the affected server:** Create Backup successfully saved a new 7.1 MB archive locally, with a matching SHA-256 and verified restore metadata. Regression tests cover the new storage layout, incorrect ownership, mismatched files, ambiguous mappings, and unbound storage.

## How to use

Install **AlphaNine-Dune-Suite-Setup-1.3.7.exe**, then open **Backup Manager → Create Backup**. Confirm the result shows a local backup path. Your configured backup folder is unchanged.

Previously failed attempts are not automatically recovered. Create a fresh backup after updating. A backup stored on the PC protects against losing the VM; use a separate disk or another machine if you also need protection against losing the host PC.
