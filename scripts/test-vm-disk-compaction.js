'use strict';
const assert=require('assert/strict');
const {createVmDiskCompaction,vmDiskProbeScript,compactScript,diskReason,TRIM_COMMAND}=require('../lib/vm-disk-compaction');
const {operationsConflict}=require('../lib/operations');
const original=()=>({vmName:'dune-awakening',vmId:'11111111-1111-1111-1111-111111111111',state:'Off',checkpointCount:0,disks:[{path:'D:\\VM Folder\\dune-server.vhdx',fileSize:130000000000,capacity:150000000000,type:'Dynamic',parent:'',attached:false,shared:0,controller:'SCSI',number:0,location:0}]});
function fixture(){let snapshot=original(),cfg={platform:'win32',serverType:'local-hyperv',vmName:'dune-awakening'},time=0;const calls=[];let failed=false,unchanged=false;
 const service=createVmDiskCompaction({configuration:()=>cfg,now:()=>time,powershell:async(script,options)=>{calls.push({script,options});if(script.includes('Optimize-VHD')){if(failed)return{ok:false,stderr:'Disk is locked'};return {ok:true,stdout:JSON.stringify({ok:true,path:snapshot.disks[0].path,beforeBytes:130000000000,afterBytes:unchanged?130000000000:43000000000,capacityBytes:150000000000,vmState:'Off'})};}return {ok:true,stdout:JSON.stringify(snapshot)};}});
 return{service,calls,get snapshot(){return snapshot},set snapshot(value){snapshot=value},cfg,setTime:value=>time=value,setFail:()=>failed=true,setUnchanged:()=>unchanged=true};}
(async()=>{
 let f=fixture(),scan=await f.service.inspect();assert.equal(scan.disks[0].path,'D:\\VM Folder\\dune-server.vhdx');assert.equal(scan.disks[0].canCompact,true);
 const result=await f.service.compact({previewId:scan.previewId,diskIndex:0});assert.equal(result.freedBytes,87000000000);assert.equal(result.capacityBytes,150000000000);assert.equal(f.calls.at(-1).options.longRunning,true);assert.match(f.calls[0].script,/Get-VMHardDiskDrive/);assert.match(f.calls.at(-1).script,/Optimize-VHD -Path \$disk.Path -Mode Full/);assert.doesNotMatch(f.calls.at(-1).script,/Stop-VM|Start-VM|Resize-VHD|Remove-VMSnapshot/);await assert.rejects(f.service.compact({previewId:scan.previewId,diskIndex:0}),/expired/);
 for(const mutate of [s=>s.state='Running',s=>s.state='Saved',s=>s.state='Paused',s=>s.state='Unknown',s=>s.checkpointCount=1,s=>s.disks[0].type='Fixed',s=>s.disks[0].type='Differencing',s=>s.disks[0].parent='base.vhdx',s=>s.disks[0].attached=true,s=>s.disks[0].shared=1]){
 f=fixture();scan=await f.service.inspect();mutate(f.snapshot);await assert.rejects(f.service.compact({previewId:scan.previewId,diskIndex:0}));assert(!f.calls.some(c=>c.script.includes('Optimize-VHD')));}
 f=fixture();scan=await f.service.inspect();f.snapshot.disks[0].path='D:\\replacement.vhdx';await assert.rejects(f.service.compact({previewId:scan.previewId,diskIndex:0}),/attachment changed/);
 f=fixture();scan=await f.service.inspect();f.snapshot.vmId='new-vm';await assert.rejects(f.service.compact({previewId:scan.previewId,diskIndex:0}),/identity/);
 f=fixture();scan=await f.service.inspect();f.cfg.vmName='other';await assert.rejects(f.service.compact({previewId:scan.previewId,diskIndex:0}),/Configured VM changed/);
 f=fixture();scan=await f.service.inspect();f.setTime(600001);await assert.rejects(f.service.compact({previewId:scan.previewId,diskIndex:0}),/expired/);
 f=fixture();scan=await f.service.inspect();await assert.rejects(f.service.compact({previewId:scan.previewId,diskIndex:'0'}),/Select a detected/);
 f=fixture();f.cfg.platform='linux';await assert.rejects(f.service.inspect(),/Windows/);
 f=fixture();f.cfg.serverType='remote';await assert.rejects(f.service.inspect(),/local Hyper-V/);
 f=fixture();scan=await f.service.inspect();f.setFail();await assert.rejects(f.service.compact({previewId:scan.previewId,diskIndex:0}),/Disk is locked/);
 f=fixture();scan=await f.service.inspect();f.setUnchanged();const unchanged=await f.service.compact({previewId:scan.previewId,diskIndex:0});assert.equal(unchanged.freedBytes,0);assert.match(unchanged.message,/without reducing/);
 f=fixture();f.snapshot.disks[0].attached=undefined;await assert.rejects(f.service.inspect(),/Incomplete/);
 f=fixture();f.snapshot.disks=[];scan=await f.service.inspect();assert.equal(scan.disks.length,0);
 const quoted=vmDiskProbeScript("VM's name");assert.match(quoted,/VM''s name/);assert.match(quoted,/\.Name -eq/);
 assert.match(TRIM_COMMAND,/fstrim -v \/|busybox fstrim/);assert.doesNotMatch(TRIM_COMMAND,/apk add|apt|dd |rm /);
 for(const operation of ['maintenance:vm-disk-trim','maintenance:vm-disk-compact'])for(const other of ['vm:control','battlegroup:control','battlegroup:update','database:backup','cleanup:server-packages','migration:export','maintenance:mode']){assert(operationsConflict(operation,other));assert(operationsConflict(other,operation));}
 console.log('PASS: automatic attached-disk discovery, escaped names, Off-only compaction, changed identity/path/configuration, checkpoints, shared/fixed/attached disks, preview expiry, failures, unchanged size, capacity preservation, and conflicting operations.');
})().catch(error=>{console.error(error);process.exitCode=1;});
