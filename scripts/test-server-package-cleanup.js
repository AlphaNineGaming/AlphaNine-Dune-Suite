"use strict";
const assert = require('assert/strict');
const { planInventory, createPackageCleanup } = require('../lib/server-package-cleanup');
const { operationsConflict } = require('../lib/operations');
const repo='registry.funcom.com/funcom/self-hosting/seabass-server';
const id=n=>'sha256:'+n.toString(16).padStart(64,'0');
const image=n=>({id:id(n),repoTags:[repo+':'+(2000000+n)+'-0-shipping'],repoDigests:[repo+'@'+id(n)],size:'1000',pinned:false});
const fixture=()=>({images:{images:[1,2,3,4,5].map(image)},containers:{containers:[]},workloads:{items:[]},battlegroups:{items:[]},disk:{availableBytes:1000000}});
function candidates(f){return planInventory(f).candidates.map(row=>row.id);}
assert.deepEqual(candidates(fixture()),[id(1),id(2),id(3)]);
let f=fixture();f.containers.containers=[{imageRef:repo+'@'+id(1),image:{image:repo+':2000002-0-shipping'}}];assert.deepEqual(candidates(f),[id(3)]);
f=fixture();f.workloads.items=[{spec:{template:{spec:{initContainers:[{image:repo+':2000001-0-shipping'}]}}}}];assert.deepEqual(candidates(f),[id(2),id(3)]);
f=fixture();f.battlegroups.items=[{spec:{revision:2000001}}];assert.deepEqual(candidates(f),[id(2),id(3)]);
f=fixture();f.images.images[0].pinned=true;assert.deepEqual(candidates(f),[id(2),id(3)]);
f=fixture();f.images.images[0].repoTags.push('other.registry/server:old');assert.deepEqual(candidates(f),[id(2),id(3)]);
f=fixture();f.images.images[0].repoTags.push(repo+':2000005-0-shipping');assert.deepEqual(candidates(f),[id(2),id(3)]);
assert.throws(()=>planInventory({...fixture(),workloads:{}}),/Incomplete/);
for(const key of ['battlegroup:control','vm:control','battlegroup:update','repair:database-ownership','maintenance:mode','migration:export']){assert(operationsConflict('cleanup:server-packages',key),key);assert(operationsConflict(key,'cleanup:server-packages'),key);}
function remote(f,{failRemoval=false,onRemoval=()=>{}}={}){
 const calls=[];
 return {calls,execute:async cmd=>{
  calls.push(cmd);
  if(cmd.includes(' images '))return {ok:true,stdout:JSON.stringify(f.images)};
  if(cmd.includes(' ps '))return {ok:true,stdout:JSON.stringify(f.containers)};
  if(cmd.includes('get pods,'))return {ok:true,stdout:JSON.stringify(f.workloads)};
  if(cmd.includes('get igwbg,'))return {ok:true,stdout:JSON.stringify(f.battlegroups)};
  if(cmd.includes(' df '))return {ok:true,stdout:'Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/root 2000 1000 '+(1000+calls.filter(c=>c.includes(' rmi ')).length*10)+' 50% /\n'};
  if(cmd.includes(' rmi ')){if(failRemoval)return {ok:false,stderr:'Runtime refused removal'};f.images.images=f.images.images.filter(row=>!cmd.endsWith(row.id));onRemoval();return {ok:true,stdout:'Deleted'};}
  throw Error('Unexpected command '+cmd);
 }};
}
(async()=>{
 let f=fixture(),r=remote(f),service=createPackageCleanup();let preview=await service.scan({...r,target:'vm-a'});
 // A package that became referenced after the scan must be skipped.
 f.workloads.items=[{spec:{containers:[{image:repo+':2000001-0-shipping'}]}}];
 const result=await service.clean({...r,target:'vm-a',previewId:preview.previewId});
 assert.equal(result.ok,true);assert.equal(result.removed.length,2);assert.equal(result.skipped.length,1);assert.equal(result.freedBytes,20480);assert(!r.calls.some(c=>c.includes(' rmi ')&&c.endsWith(id(1))));
 await assert.rejects(service.clean({...r,target:'vm-a',previewId:preview.previewId}),/Scan again/);
 f=fixture();r=remote(f,{onRemoval:()=>{f.containers.containers=[{imageRef:id(2)}];}});service=createPackageCleanup();preview=await service.scan({...r,target:'a'});
 const raced=await service.clean({...r,target:'a',previewId:preview.previewId});assert.equal(raced.skipped.length,1);assert(!r.calls.some(c=>c.includes(' rmi ')&&c.endsWith(id(2))));
 f=fixture();r=remote(f,{failRemoval:true});service=createPackageCleanup();preview=await service.scan({...r,target:'a'});const failure=await service.clean({...r,target:'a',previewId:preview.previewId});assert.equal(failure.ok,false);assert.equal(failure.removed.length,0);assert.equal(failure.errors.length,1);
 // An RPC timeout is success only after absence is independently verified.
 f=fixture();r=remote(f);service=createPackageCleanup({pause:async()=>{}});let removalTimeouts=[];
 const completedExecute=async(cmd,timeout)=>{if(cmd.includes(' rmi ')){removalTimeouts.push(timeout);const result=await r.execute(cmd);if(cmd.endsWith(id(1)))return {ok:false,stderr:'DeadlineExceeded stream terminated by RST_STREAM CANCEL'};return result;}return r.execute(cmd);};
 preview=await service.scan({execute:completedExecute,target:'a'});const completed=await service.clean({execute:completedExecute,target:'a',previewId:preview.previewId});assert.equal(completed.ok,true);assert.equal(completed.removed.length,3);assert(removalTimeouts.every(value=>value===180000));assert(r.calls.filter(c=>c.includes(' rmi ')).every(c=>c.includes('--timeout=120s')));
 // A delayed runtime completion is checked again, without another delete.
 f=fixture();r=remote(f);let polls=0;const delays=[];service=createPackageCleanup({pause:async ms=>delays.push(ms)});
 const delayedExecute=async(cmd,timeout)=>{if(cmd.includes(' rmi ')&&cmd.endsWith(id(1)))return {ok:false,timedOut:true,stderr:'DeadlineExceeded'};if(cmd.includes('--timeout=30s images')&&++polls===2)f.images.images=f.images.images.filter(row=>row.id!==id(1));return r.execute(cmd,timeout);};
 preview=await service.scan({execute:delayedExecute,target:'a'});const delayed=await service.clean({execute:delayedExecute,target:'a',previewId:preview.previewId});assert.equal(delayed.ok,true);assert.equal(delayed.removed.length,3);assert.deepEqual(delays,[1000]);
 // A still-present package stops cleanup and keeps previous removals verified.
 f=fixture();r=remote(f,{failRemoval:true});const stoppedDelays=[];service=createPackageCleanup({pause:async ms=>stoppedDelays.push(ms)});
 const unfinishedExecute=async(cmd,timeout)=>{const result=await r.execute(cmd,timeout);if(cmd.includes(' rmi '))return {...result,stderr:'DeadlineExceeded'};return result;};
 preview=await service.scan({execute:unfinishedExecute,target:'a'});const unfinished=await service.clean({execute:unfinishedExecute,target:'a',previewId:preview.previewId});assert.equal(unfinished.ok,false);assert.equal(unfinished.removed.length,0);assert.match(unfinished.error,/still present/);assert.deepEqual(stoppedDelays,[1000,3000,5000]);assert.equal(r.calls.filter(c=>c.includes(' rmi ')).length,1);
 // Verification failures must never be accepted as a completed removal.
 f=fixture();r=remote(f);service=createPackageCleanup({pause:async()=>{}});
 const unverifiableExecute=async(cmd,timeout)=>{if(cmd.includes(' rmi '))return {ok:false,stderr:'DeadlineExceeded'};if(cmd.includes('--timeout=30s images'))return {ok:false,stderr:'Runtime unavailable'};return r.execute(cmd,timeout);};
 preview=await service.scan({execute:unverifiableExecute,target:'a'});const unknown=await service.clean({execute:unverifiableExecute,target:'a',previewId:preview.previewId});assert.equal(unknown.ok,false);assert.match(unknown.error,/could not be verified/);
 let time=0;service=createPackageCleanup({now:()=>time});preview=await service.scan({...r,target:'a'});await assert.rejects(service.clean({...r,target:'b',previewId:preview.previewId}),/target changed/);time=600001;await assert.rejects(service.clean({...r,target:'a',previewId:preview.previewId}),/expired/);
 await assert.rejects(createPackageCleanup().scan({execute:async()=>({ok:false,stderr:'Permission denied'}),target:'a'}),/Permission denied/);
 console.log('PASS: retained versions, stopped containers, pending workloads, configuration revisions, pinned/shared packages, operation conflicts, target/expiry guards, race checks, partial failure, extended timeouts, verified delayed completion and measured free space.');
})().catch(error=>{console.error(error);process.exitCode=1;});
