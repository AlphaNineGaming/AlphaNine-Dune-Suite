'use strict';
const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),crypto=require('crypto');
const {createOwnershipRepair,repairPlan,TABLES,SEQUENCE}=require('../lib/database-ownership-repair');
const {operationsConflict}=require('../lib/operations');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'ownership-repair-test-'));
const target={name:'sh-test',namespace:'funcom-seabass-sh-test'};
async function scenario(options={}){
 const calls=[];let applied=false,retried=false,snapshots=0,changedTarget=false;
 const archive=Buffer.from('PGDMP-test-archive'),hash=crypto.createHash('sha256').update(archive).digest('hex');
 const dbName=target.name+'-db-dbdepl';
 const pods=[{metadata:{name:dbName+'-sts-0',uid:'dbpod',labels:{role:'igw-database'}},status:{phase:'Running'}},{metadata:{name:dbName+'-util-abc',uid:'failedpod'},status:{phase:'Failed'}}];
 if(options.active)pods.push({metadata:{name:'map',labels:{role:'igw-server'}},status:{phase:'Running'}});
 const inventory=()=>({databaseOwner:'dune',objects:[...TABLES.map(name=>({name,kind:'r',owner:applied?'dune':'postgres'})),{name:SEQUENCE,kind:'S',owner:applied?'dune':'postgres'}]});
 const sshCommand=async text=>{
  calls.push(text);let stdout='';
  if(text.includes(' get battlegroup '))stdout=JSON.stringify({spec:{stop:false}});
  else if(text.includes(' get databasedeployments ')){snapshots++;stdout=JSON.stringify({items:[{metadata:{name:dbName,uid:'dbdepl'},status:{address:'192.168.1.1:15432',phase:options.healthy||retried?'Ready':'Pending',schema:'new'}}]});}
  else if(text.includes(' get pods '))stdout=JSON.stringify({items:pods});
  else if(text.includes(' logs '))stdout=options.unrelated?'disk full':'must be able to SET ROLE "postgres"';
  else if(text.includes('json_build_object'))stdout=JSON.stringify(inventory());
  else if(text.includes('pg_dump')){if(options.backupFailure)return {ok:false,stderr:'backup failed'};}
  else if(text.includes('sha256sum'))stdout=hash+'  /tmp/archive';
  else if(text.includes('stat -c'))stdout=String(archive.length);
  else if(text.includes('base64')){stdout=(options.corrupt?Buffer.from('bad'):archive).toString('base64');if(options.changeTarget)changedTarget=true;}
  else if(text.includes('BEGIN;'))applied=true;
  else if(text.includes('delete --raw')){assert(text.includes('failedpod'));retried=true;}
  else throw Error('Unexpected command: '+text);
  return {ok:true,stdout};
 };
 const runner=createOwnershipRepair({sshCommand,getTarget:()=>changedTarget?{...target,name:'changed'}:target,directory:path.join(root,crypto.randomUUID()),sleep:async()=>{}});
 try{return {result:await runner.run(),calls,applied,retried};}catch(error){return {error,calls,applied,retried};}
}
(async()=>{
 let r=await scenario({healthy:true});assert(r.result.ok);assert.equal(r.result.changed,false);assert(!r.applied);assert(!r.calls.some(c=>c.includes('pg_dump')));
 r=await scenario({active:true});assert.match(r.error.message,/active/);assert(!r.applied);
 r=await scenario({unrelated:true});assert.match(r.error.message,/supported/);assert(!r.applied);
 r=await scenario({backupFailure:true});assert.match(r.error.message,/backup failed/);assert(!r.applied&&!r.retried);
 r=await scenario({corrupt:true});assert.match(r.error.message,/verification failed/);assert(!r.applied);
 r=await scenario({changeTarget:true});assert.match(r.error.message,/changed/);assert(!r.applied);
 r=await scenario();assert(r.result.ok&&r.result.changed&&r.applied&&r.retried);assert(fs.existsSync(r.result.backupPath));assert.equal(JSON.parse(fs.readFileSync(r.result.reportPath)).status,'complete');
 assert.throws(()=>repairPlan({databaseOwner:'other',objects:[]}),/owner/);
 assert.throws(()=>repairPlan({databaseOwner:'dune',objects:[{name:TABLES[0],owner:'other',kind:'r'}]}),/unexpected owner/);
 assert.throws(()=>repairPlan({databaseOwner:'dune',objects:[{name:'unrelated',owner:'postgres',kind:'r'}]}),/Unexpected/);
 for(const key of ['battlegroup:control','battlegroup:update','database:backup','database:import','vm:control','map:start','repair:other']){assert(operationsConflict('repair:database-ownership',key));assert(operationsConflict(key,'repair:database-ownership'));}
 console.log('PASS: healthy no-op, active-server guard, unrelated failure guard, failed/corrupt backup guard, changed target, successful backup/repair/retry, ownership scope, operation conflicts.');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>fs.rmSync(root,{recursive:true,force:true}));
