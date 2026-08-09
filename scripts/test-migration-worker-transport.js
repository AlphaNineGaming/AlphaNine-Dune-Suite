"use strict";

const assert=require("assert");const fs=require("fs");const os=require("os");const path=require("path");
const {deploySignedWorkerJob,remoteCommand,startWorker}=require("../lib/migration-worker-transport");

async function main(){
  assert.equal(remoteCommand(["sudo","/var/lib/alphanine/migration-worker/alphanine-migration-worker","status","/var/lib/alphanine/migration-worker/jobs/migration-import-1786150000000-a1b2c3d4"]).includes("\n"),false);
  assert.throws(()=>remoteCommand(["sh","-c","echo bad"]),/unsafe/);assert.throws(()=>remoteCommand(["sudo","x;rm"]),/unsafe/);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"a9-worker-transport-"));try{
    const stage=path.join(root,"stage");fs.mkdirSync(stage);for(const file of ["alphanine-migration-worker","job.json","job.json.sha256","job.json.sig","migration-package.a9migration"] )fs.writeFileSync(path.join(stage,file),file);
    const publicKey=path.join(root,"public.hex");fs.writeFileSync(publicKey,"a".repeat(64));const calls=[];
    const prepared={jobId:"migration-import-1786150000000-a1b2c3d4",stagingDir:stage,remoteJobDir:"/var/lib/alphanine/migration-worker/jobs/migration-import-1786150000000-a1b2c3d4",workerIdentity:{sha256:"b".repeat(64)},signingIdentity:{publicKeyPath:publicKey,fingerprint:"c".repeat(64)}};
    const ssh=async(command)=>{calls.push(["ssh",command]);if(command.includes("test -e"))return{ok:false,code:1};if(command.includes("sha256sum /var/lib/alphanine/migration-worker/alphanine-migration-worker.next"))return{ok:true,code:0,stdout:"b".repeat(64)+"  file\n"};if(command.includes(" install /tmp/alphanine-migration-upload-"))return{ok:true,code:0,stdout:"A9_MIGRATION_JOB_INSTALLED\n"};return{ok:true,code:0,stdout:""}};
    const scp=async(source,destination)=>{calls.push(["scp",path.basename(source),destination]);return{ok:true,code:0}};
    const result=await deploySignedWorkerJob({prepared,ssh,scp});assert(result.ok);assert(calls.filter(call=>call[0]==="scp").length===3);assert(calls.every(call=>!call.join(" ").includes("job contents")));assert(calls.some(call=>call[0]==="ssh"&&call[1].includes("alphanine-migration-worker install /tmp/alphanine-migration-upload-")));
    await assert.rejects(()=>deploySignedWorkerJob({prepared:{...prepared,jobId:"migration-import-1786150000001-a1b2c3d4",remoteJobDir:"/var/lib/alphanine/migration-worker/jobs/migration-import-1786150000001-a1b2c3d4"},ssh,upload:async()=>({ok:true,code:0,inputComplete:false})}),/stdin completed/);
    const launched=[];await startWorker({jobId:prepared.jobId,ssh:async(command)=>{launched.push(command);return{ok:true,code:0,stdout:`A9_MIGRATION_WORKER_STARTED ${prepared.jobId} 42\n`}}});assert.equal(launched.length,1);assert(!launched[0].includes("job.json"));
  }finally{fs.rmSync(root,{recursive:true,force:true})}
  console.log("Migration worker transport tests passed.");
}
main().catch(error=>{console.error(error);process.exitCode=1});
