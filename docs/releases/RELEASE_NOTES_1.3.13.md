# AlphaNine Dune Suite 1.3.13 — VM Storage Cleanup & Disk Compaction

Server updates can leave older copies of the Dune server software cached in the VM. This release adds **Clean Old Server Packages** under **Server Control → Maintenance** to inspect and remove eligible older packages.

## New cleanup controls

- Scan the VM to see unused package versions, retained versions, estimated package sizes, and current free space.
- Preserve packages referenced by containers (including stopped containers), Kubernetes workloads, and server configuration, plus the two newest cached versions of each supported Funcom server package.
- Preserve pinned packages and images shared with repositories outside the supported cleanup scope.
- Confirm the cleanup in the local Suite. Every package is checked again before removal through the container runtime.
- Allow up to two minutes for each removal. If the runtime reports a timeout, check whether the package actually disappeared before treating it as failed; deletion commands are never automatically replayed.
- Follow progress in the Suite and Operations. Cleanup is blocked while conflicting Suite updates, server controls, database maintenance, or migrations are active.
- Report verified removals, skipped packages, errors, and the measured change in VM free space. A failed removal stops further cleanup.

Cleanup targets older Funcom shipping server packages. Game saves, databases, backups, and unrelated packages are outside its scope. Referenced old packages are retained, even if that limits the space recovered.

## New: Compact VM Disk

Open **Server Control → VM Actions → Compact VM Disk**. The Suite reads the disk paths directly from the configured local Hyper-V VM. No path entry is required. If several disks are attached, select one from the detected list.

1. While the VM is running, use **Prepare Free Space** to trim unused Linux root-filesystem blocks when a supported trim tool is already installed. Missing or unsupported trim tools are reported; nothing is installed automatically.
2. Shut down the VM fully using the normal VM controls. Its actual Hyper-V state must be **Off**; Saved and paused VMs are blocked.
3. Select **Detect VM Disks**, review the detected path and file size, then **Compact Detected Disk**.

Compaction verifies the VM identity, disk attachment, disk type, checkpoint state, and sharing before calling Windows. It blocks fixed-size, differencing, mounted, shared, and checkpoint disks. Disk capacity stays the same; the VM remains off until you start it manually. Windows compaction runs without the general command timeout and appears in Operations. The result shows the before and after file sizes and actual host space reclaimed. A successful run may reclaim zero bytes.

Keep a current backup before disk maintenance. The feature is available only in the local Windows Suite for a configured local Hyper-V VM.

## Step-by-step: reclaim space

1. Open the local Suite as Administrator on your Hyper-V host and keep a current backup.
2. Start the VM. Open **Server Control → Maintenance → Clean Old Server Packages**.
3. Review the scan, select **Clean Unused Packages**, confirm, and wait for completion. Read the measured VM free space.
4. With the VM still running, open **Server Control → VM Actions → Compact VM Disk**. Select **Prepare Free Space**, confirm, and wait for success. If trimming fails or is unavailable, review its error before continuing.
5. Stop the game server normally, then select **Stop VM**. Wait until Hyper-V shows **Off**, not Saved or paused.
6. Select **Detect VM Disks**. The Suite finds the attached disk path automatically. Review the path and select the intended disk if more than one is listed.
7. Select **Compact Detected Disk**, confirm, and keep the VM off until completion. Follow progress in **Operations**.
8. Review the before/after file sizes and **Reclaimed on PC**, then select **Start VM** and start the server normally if needed.

Cleanup frees space inside Linux; compaction may shrink the file on your PC. If compaction reports zero reclaimed space, the Linux free space is still usable. If you skipped preparation, run steps 4–7 in order. Do not repeatedly compact after a failed trim without reviewing its error.

[Full walkthrough and troubleshooting](https://github.com/AlphaNineGaming/AlphaNine-Dune-Suite/blob/v1.3.13/docs/VM_STORAGE_CLEANUP_GUIDE.md).

## Validation

Cleanup tests cover retained versions, shipping tag formats, stopped containers, desired workloads, configuration revisions, pinned and shared packages, conflicting operations, expired previews, changed VM targets, packages that become referenced during cleanup, failed removals, extended removal timeouts, delayed completion after a cancelled RPC, failed verification, and measured free space. Disk compaction tests cover automatic disk detection, exact VM names, Off-only operation, changed VM identity and attachment, checkpoints, shared/fixed/mounted disks, preview expiry, unchanged file size, capacity preservation, and operation conflicts. Rendered UI, remote-access, and packaged-runtime checks also pass.

A read-only scan on the affected VM identified 37 eligible packages with approximately 35 GB of listed package sizes and retained 22 packages. A subsequent user-run cleanup freed 31 GB before a removal RPC timed out. A read-only follow-up verified that the timed-out package had disappeared; the Suite now reconciles this outcome instead of reporting an unverified failure.
