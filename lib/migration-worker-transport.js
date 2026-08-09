"use strict";

const fs=require("fs");
const path=require("path");
const {REMOTE_ROOT,REMOTE_SIGNING_PUBLIC_KEY,REMOTE_WORKER,fixedLaunchCommand,fixedStatusCommand,parseWorkerState}=require("./migration-destination-worker");

const SAFE=/^[A-Za-z0-9_./:+@=-]+$/;
function safe(value,label){const text=String(value||"");if(!SAFE.test(text)||text.includes(".."))throw new Error(`${label} is unsafe.`);return text;}
function remoteCommand(argv){if(!Array.isArray(argv)||!argv.length)throw new Error("Remote command is empty.");return argv.map((value)=>safe(value,"Remote worker argument")).join(" ");}
function requireOk(result,purpose){if(!result||result.ok!==true||result.code!==0){const error=new Error(`${purpose} failed.`);error.code="migration_worker_transport";error.details={purpose,exitCode:Number.isInteger(result?.code)?result.code:null,timedOut:result?.timedOut===true,stderr:String(result?.stderr||result?.error||"").trim().slice(0,1024)};throw error}return result;}

function tarOctal(buffer,offset,length,value){const text=Math.trunc(value).toString(8).padStart(length-1,"0")+"\0";buffer.write(text,offset,length,"ascii")}
function createJobBundle(stagingDir,bundlePath){
  const files=fs.readdirSync(stagingDir).sort();const fd=fs.openSync(bundlePath,"wx",0o600);
  try{for(const leaf of files){safe(leaf,"Worker bundle filename");const body=fs.readFileSync(path.join(stagingDir,leaf));const header=Buffer.alloc(512);header.write(leaf,0,100,"ascii");tarOctal(header,100,8,0o600);tarOctal(header,108,8,0);tarOctal(header,116,8,0);tarOctal(header,124,12,body.length);tarOctal(header,136,12,0);header.fill(0x20,148,156);header[156]="0".charCodeAt(0);header.write("ustar\0",257,6,"ascii");header.write("00",263,2,"ascii");let sum=0;for(const byte of header)sum+=byte;const checksum=sum.toString(8).padStart(6,"0");header.write(checksum,148,6,"ascii");header[154]=0;header[155]=0x20;fs.writeSync(fd,header);fs.writeSync(fd,body);const padding=(512-(body.length%512))%512;if(padding)fs.writeSync(fd,Buffer.alloc(padding));}fs.writeSync(fd,Buffer.alloc(1024));fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
  return files;
}

async function deploySignedWorkerJob(options={}){
  const prepared=options.prepared;if(!prepared?.jobId||!prepared?.stagingDir)throw new Error("Prepared worker job is missing.");
  const jobId=safe(prepared.jobId,"Worker job ID");const uploadDir=`/tmp/alphanine-migration-upload-${jobId}`;const remoteJob=prepared.remoteJobDir;
  requireOk(await options.ssh(remoteCommand(["mkdir","-m","0700",uploadDir])),"Create restrictive upload staging directory");
  let deployed=false;
  const bundlePath=path.join(path.dirname(prepared.stagingDir),"job-bundle.tar");
  try{
    const files=fs.readdirSync(prepared.stagingDir).sort();
    createJobBundle(prepared.stagingDir,bundlePath);
    const upload=options.upload||options.scp;if(typeof upload!=="function")throw new Error("Bounded migration-worker upload transport is unavailable.");
    const workerUpload=await upload(path.join(prepared.stagingDir,"alphanine-migration-worker"),`${uploadDir}/alphanine-migration-worker`);requireOk(workerUpload,"Upload pinned migration worker");if(workerUpload.inputComplete===false)throw new Error("Migration-worker upload ended before stdin completed.");
    const bundleUpload=await upload(bundlePath,`${uploadDir}/job-bundle.tar`);requireOk(bundleUpload,"Upload signed durable job bundle");if(bundleUpload.inputComplete===false)throw new Error("Job-bundle upload ended before stdin completed.");
    const publicLeaf=path.basename(prepared.signingIdentity.publicKeyPath);const keyUpload=await upload(prepared.signingIdentity.publicKeyPath,`${uploadDir}/${publicLeaf}`);requireOk(keyUpload,"Upload Suite job-signing public key");if(keyUpload.inputComplete===false)throw new Error("Signing-key upload ended before stdin completed.");
    requireOk(await options.ssh(remoteCommand(["sudo","install","-d","-m","0700",REMOTE_ROOT,`${REMOTE_ROOT}/jobs`])),"Create persistent worker directories");
    const keyExists=await options.ssh(remoteCommand(["sudo","test","-e",REMOTE_SIGNING_PUBLIC_KEY]));
    if(keyExists?.ok===true){requireOk(await options.ssh(remoteCommand(["sudo","cmp","-s",`${uploadDir}/${publicLeaf}`,REMOTE_SIGNING_PUBLIC_KEY])),"Verify pinned Suite signing key");}
    else{requireOk(await options.ssh(remoteCommand(["sudo","install","-m","0600",`${uploadDir}/${publicLeaf}`,`${REMOTE_SIGNING_PUBLIC_KEY}.next`])),"Stage Suite signing key");requireOk(await options.ssh(remoteCommand(["sudo","mv","-f",`${REMOTE_SIGNING_PUBLIC_KEY}.next`,REMOTE_SIGNING_PUBLIC_KEY])),"Publish Suite signing key atomically");}
    requireOk(await options.ssh(remoteCommand(["sudo","install","-m","0755",`${uploadDir}/alphanine-migration-worker`,`${REMOTE_WORKER}.next`])),"Stage pinned migration worker");
    const workerHash=requireOk(await options.ssh(remoteCommand(["sudo","sha256sum",`${REMOTE_WORKER}.next`])),"Hash staged migration worker").stdout.trim().split(/\s+/)[0];
    if(workerHash!==prepared.workerIdentity.sha256)throw new Error("Remote migration worker hash differs from the bundled pin.");
    requireOk(await options.ssh(remoteCommand(["sudo","mv","-f",`${REMOTE_WORKER}.next`,REMOTE_WORKER])),"Publish migration worker atomically");
    const installed=requireOk(await options.ssh(remoteCommand(["sudo",REMOTE_WORKER,"install",`${uploadDir}/job-bundle.tar`,remoteJob])),"Install and verify signed durable job bundle");
    if(String(installed.stdout||"").trim()!=="A9_MIGRATION_JOB_INSTALLED")throw new Error("Durable worker did not return its fixed installation marker.");
    deployed=true;return {ok:true,jobId,remoteJobDir:remoteJob,workerSha256:prepared.workerIdentity.sha256,signingKeyFingerprint:prepared.signingIdentity.fingerprint};
  }finally{fs.rmSync(bundlePath,{force:true});await options.ssh(remoteCommand(["rm","-rf",uploadDir])).catch(()=>{});if(!deployed){await options.ssh(remoteCommand(["sudo","rm","-f",`${REMOTE_WORKER}.next`,`${REMOTE_SIGNING_PUBLIC_KEY}.next`])).catch(()=>{});await options.ssh(remoteCommand(["sudo","rm","-rf",remoteJob,`${remoteJob}.next`])).catch(()=>{});}}
}

async function startWorker(options={}){const argv=fixedLaunchCommand(options.jobId);const result=requireOk(await options.ssh(remoteCommand(argv)),"Start durable migration worker");if(!String(result.stdout||"").startsWith("A9_MIGRATION_WORKER_STARTED "))throw new Error("Migration worker did not return its fixed start marker.");return result;}
async function readWorkerStatus(options={}){const result=requireOk(await options.ssh(remoteCommand(fixedStatusCommand(options.jobId))),"Read durable migration worker status");return parseWorkerState(result.stdout,options.jobId);}

module.exports={createJobBundle,deploySignedWorkerJob,readWorkerStatus,remoteCommand,startWorker};
