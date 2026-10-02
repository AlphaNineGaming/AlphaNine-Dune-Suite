"use strict";
const crypto = require('crypto');
const quote = value => "'" + String(value).replace(/'/g, "''") + "'";
function vmDiskProbeScript(vmName) {
 return `$ErrorActionPreference='Stop'
Import-Module Hyper-V -ErrorAction Stop
$matches=@(Get-VM | Where-Object { $_.Name -eq ${quote(vmName)} })
if($matches.Count -ne 1){throw 'The configured VM was not found uniquely.'}
$vm=$matches[0]
$disks=@(Get-VMHardDiskDrive -VM $vm | ForEach-Object {
 $drive=$_
 if($drive.Path){
  $disk=Get-VHD -Path $drive.Path -ErrorAction Stop
  $shared=@(Get-VM | Get-VMHardDiskDrive | Where-Object { $_.Path -eq $drive.Path -and $_.VMId -ne $vm.Id }).Count
  [pscustomobject]@{path=$disk.Path;fileSize=[long]$disk.FileSize;capacity=[long]$disk.Size;type=[string]$disk.VhdType;parent=[string]$disk.ParentPath;attached=[bool]$disk.Attached;shared=$shared;controller=[string]$drive.ControllerType;number=[int]$drive.ControllerNumber;location=[int]$drive.ControllerLocation}
 }
})
[pscustomobject]@{vmName=[string]$vm.Name;vmId=[string]$vm.Id;state=[string]$vm.State;checkpointCount=@(Get-VMSnapshot -VM $vm).Count;disks=$disks} | ConvertTo-Json -Depth 6 -Compress`;
}
function diskReason(snapshot, disk) {
 if(snapshot.state !== 'Off') return 'Shut down the VM fully first. Running, Saved, and paused VMs cannot be compacted.';
 if(snapshot.checkpointCount !== 0) return 'This VM has checkpoints. Resolve its checkpoints before compacting.';
 if(disk.type !== 'Dynamic' || disk.parent) return 'Only standalone dynamically expanding disks are supported.';
 if(disk.attached) return 'The disk is still attached or mounted. Release it before compacting.';
 if(disk.shared !== 0) return 'This disk is referenced by another VM. Shared disks cannot be compacted here.';
 return '';
}
function assertSnapshot(data) {
 if(!data || !data.vmId || !data.vmName || !data.state || !Number.isInteger(data.checkpointCount) || !Array.isArray(data.disks)) throw Error('Incomplete Hyper-V disk information. Compaction is disabled.');
 for(const disk of data.disks) if(!disk.path || typeof disk.path!=='string' || !['IDE','SCSI'].includes(disk.controller) || !Number.isInteger(disk.number) || disk.number<0 || !Number.isInteger(disk.location) || disk.location<0 || !Number.isSafeInteger(disk.fileSize) || disk.fileSize<0 || !Number.isSafeInteger(disk.capacity) || disk.capacity<=0 || !Number.isInteger(disk.shared) || typeof disk.attached!=='boolean') throw Error('Incomplete disk information. Compaction is disabled.');
 return data;
}
function compactScript(snapshot, disk) {
 return `$ErrorActionPreference='Stop'
Import-Module Hyper-V -ErrorAction Stop
$vm=Get-VM -Id ${quote(snapshot.vmId)} -ErrorAction Stop
if([string]$vm.Name -ne ${quote(snapshot.vmName)} -or [string]$vm.State -ne 'Off'){throw 'VM identity or state changed. Inspect the VM disks again.'}
if(@(Get-VMSnapshot -VM $vm).Count -ne 0){throw 'VM checkpoints changed. Compaction stopped.'}
$drive=@(Get-VMHardDiskDrive -VM $vm | Where-Object { [string]$_.ControllerType -eq ${quote(disk.controller)} -and $_.ControllerNumber -eq ${Number(disk.number)} -and $_.ControllerLocation -eq ${Number(disk.location)} -and $_.Path -eq ${quote(disk.path)} })
if($drive.Count -ne 1){throw 'VM disk attachment changed. Inspect disks again.'}
$disk=Get-VHD -Path $drive[0].Path -ErrorAction Stop
if([string]$disk.VhdType -ne 'Dynamic' -or $disk.ParentPath -or $disk.Attached){throw 'Disk is not an unmounted standalone dynamic disk.'}
if(@(Get-VM | Get-VMHardDiskDrive | Where-Object { $_.Path -eq $disk.Path -and $_.VMId -ne $vm.Id }).Count){throw 'Disk is referenced by another VM.'}
$before=[long]$disk.FileSize
Optimize-VHD -Path $disk.Path -Mode Full -ErrorAction Stop
$after=Get-VHD -Path $disk.Path -ErrorAction Stop
if([long]$after.Size -ne [long]$disk.Size){throw 'Disk capacity changed unexpectedly. Inspect the disk before starting the VM.'}
[pscustomobject]@{ok=$true;path=$after.Path;beforeBytes=$before;afterBytes=[long]$after.FileSize;capacityBytes=[long]$after.Size;vmState=[string](Get-VM -Id $vm.Id).State} | ConvertTo-Json -Compress`;
}
const TRIM_COMMAND = "sudo -n sh -c 'if command -v fstrim >/dev/null 2>&1; then fstrim -v /; elif busybox --list 2>/dev/null | grep -qx fstrim; then busybox fstrim -v /; else echo \"Trim tool is not installed in this VM; no trimming was performed.\" >&2; exit 2; fi'";
function createVmDiskCompaction({ powershell, configuration, now=Date.now }) {
 const previews=new Map();
 const binding=()=>{const cfg=configuration();if(cfg.platform!=='win32'||cfg.serverType!=='local-hyperv'||!cfg.vmName)throw Error('Disk compaction requires a configured local Hyper-V VM on Windows.');return cfg.vmName;};
 async function probe(vmName){const result=await powershell(vmDiskProbeScript(vmName));if(!result.ok)throw Error(result.stderr||result.error||'Hyper-V disk detection failed. Run the Suite as Administrator.');try{return assertSnapshot(JSON.parse(result.stdout.trim()));}catch(error){throw Error('Could not read Hyper-V disk information: '+error.message);}}
 return {
  async inspect(){const vmName=binding(),snapshot=await probe(vmName);const previewId=crypto.randomUUID();for(const[id,p]of previews)if(now()-p.createdAt>600000)previews.delete(id);previews.set(previewId,{snapshot,createdAt:now()});while(previews.size>20)previews.delete(previews.keys().next().value);return {ok:true,previewId,...snapshot,disks:snapshot.disks.map((disk,index)=>({...disk,index,canCompact:!diskReason(snapshot,disk),reason:diskReason(snapshot,disk)}))};},
  async compact({previewId,diskIndex,onProgress=()=>{}}){
   const preview=previews.get(previewId);if(!preview||now()-preview.createdAt>600000)throw Error('Inspect VM disks again: the preview expired.');
   const vmName=binding();if(vmName!==preview.snapshot.vmName)throw Error('Configured VM changed. Inspect its disks again.');
   if(!Number.isInteger(diskIndex)||diskIndex<0||!preview.snapshot.disks[diskIndex])throw Error('Select a detected VM disk.');
   const selected=preview.snapshot.disks[diskIndex],fresh=await probe(vmName);
   const disk=fresh.disks.find(item=>item.path===selected.path&&item.controller===selected.controller&&item.number===selected.number&&item.location===selected.location);
   if(fresh.vmId!==preview.snapshot.vmId||!disk)throw Error('VM identity or disk attachment changed. Inspect disks again.');
   const reason=diskReason(fresh,disk);if(reason)throw Error(reason);
   if(binding()!==vmName)throw Error('Configured VM changed before compaction.');
   previews.delete(previewId);onProgress('Compacting VM disk',disk.path+' · this may take several minutes.');
   const result=await powershell(compactScript(fresh,disk),{longRunning:true});if(!result.ok)throw Error(result.stderr||result.error||'Windows disk compaction failed.');
   let summary;try{summary=JSON.parse(result.stdout.trim());}catch{throw Error('Windows did not return a verified compaction result. Inspect the disk before retrying.');}
   if(summary.ok!==true||typeof summary.path!=='string'||summary.path.toLowerCase()!==disk.path.toLowerCase()||summary.capacityBytes!==disk.capacity||!Number.isSafeInteger(summary.beforeBytes)||!Number.isSafeInteger(summary.afterBytes)||summary.afterBytes<0||summary.vmState!=='Off')throw Error('Disk compaction result could not be verified. Inspect the disk and VM state.');
   onProgress('Compaction complete','Measuring host space reclaimed.');
   return {...summary,freedBytes:Math.max(0,summary.beforeBytes-summary.afterBytes),message:summary.afterBytes<summary.beforeBytes?'VM disk compacted. The VM remains off.':'Compaction finished without reducing the file size. Deleted Linux blocks may need trimming first. The VM remains off.'};
  }
 };
}
module.exports={createVmDiskCompaction,vmDiskProbeScript,compactScript,diskReason,TRIM_COMMAND};
