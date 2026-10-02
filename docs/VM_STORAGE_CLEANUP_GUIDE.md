# Clean old server packages and compact the VM disk

Available in AlphaNine Dune Suite 1.3.13 and later. These steps use the local Windows Suite on the Hyper-V host, with your local Hyper-V VM configured in Settings and a working VM connection.

Updates can leave older server software packages in the VM. Removing those packages increases free space inside Linux. Shrinking the VHDX file on your PC is a separate step: prepare the free space, shut down the VM, then compact the detected disk.

## Before you begin

1. Install the latest Suite and open it as Administrator on the Hyper-V host.
2. Keep a current backup before disk maintenance.
3. Open **Server Control**. Finish any update, backup, or other maintenance already running.
4. Schedule time for the server to be offline during disk compaction.

## Part 1: Remove unused server packages

1. Under **VM Actions**, select **Start VM** if the VM is off. Wait for it to boot and connect.
2. Under **Maintenance**, select **Clean Old Server Packages**. This scans the VM first.
3. Review the unused packages and retained packages. Packages used by containers or server configuration, pinned/shared packages, and the two newest versions of each supported package are kept. Saves, databases, and backups are outside the cleanup scope.
4. Select **Clean Unused Packages**, then confirm **Clean Packages**.
5. Wait for completion. Follow progress in the panel or **Operations**. Each removal may take up to two minutes.
6. Read the measured space freed and the VM free space. The listed package sizes are estimates because packages can share files.

If no eligible packages remain, proceed to Part 2 if you want to reclaim space on the PC. If cleanup stops with an error, read the details and scan again before retrying. Completed removals are retained; the Suite checks whether a timed-out removal actually finished before reporting failure.

## Part 2: Prepare free space inside the running VM

1. Keep the VM running.
2. Under **Server Control → VM Actions**, select **Compact VM Disk** to open the disk maintenance panel. Opening the panel detects disks; it does not start compaction.
3. Select **Prepare Free Space**, then confirm.
4. Wait for the success message. This asks Linux to mark unused root-filesystem blocks as reclaimable; it does not delete files.
5. If preparation reports a missing trim tool or unsupported trimming, stop here and review the error. The Suite does not install a trim tool automatically. Compaction may otherwise reclaim zero bytes.

## Part 3: Shut down and compact the detected disk

1. Stop the game server normally using **Stop Server** and wait for it to stop.
2. Select **Stop VM** and wait for shutdown. Hyper-V must show the VM as **Off**. A Saved or paused VM cannot be compacted.
3. In the disk maintenance panel, select **Detect VM Disks** again.
4. Review the detected disk path and current file size. The Suite reads the path from your configured Hyper-V VM; you do not need to enter it. If multiple disks are attached, select the intended disk from **Detected disk**.
5. Select **Compact Detected Disk**, then confirm **Compact Disk**.
6. Keep the VM off and wait for the operation to finish. Do not start it from Hyper-V or another application while compaction runs. Follow the operation in **Operations**.
7. Review **Before**, **After**, and **Reclaimed on PC**. The maximum disk capacity remains unchanged. A completed operation can reclaim zero bytes.
8. Select **Start VM** when finished. Wait for the VM connection, then start the server normally if needed and check its health.

## If the disk does not shrink

- If you skipped **Prepare Free Space**, start the VM and complete Parts 2 and 3 in that order.
- If preparation fails, copy its error for troubleshooting. Repeating compaction alone may give the same result.
- If preparation succeeds but compaction reclaims zero bytes, Windows could not reclaim additional blocks. Free space inside the VM is still available for future updates.
- If compaction is blocked, read the reason shown in the panel. Fixed-size, differencing, mounted, shared, and checkpoint disks are not supported by this feature. Do not manually delete VHDX or checkpoint files.
- If the scan expired or the VM configuration changed, select **Detect VM Disks** again.

Cleaning packages can be repeated after future updates. Compacting the disk requires downtime and is useful when you need to reclaim host PC storage.
