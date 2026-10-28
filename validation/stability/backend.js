"use strict";
// Test-package entry only. Production server.js has no fixture transport hook.
const fs=require("fs"),path=require("path"),Module=require("module"),http=require("http"),cp=require("child_process");
if(process.env.ALPHANINE_CLEANUP_TEST_PACKAGE!=="1")throw Error("Validation backend requires the isolated test package");
const root=process.env.ALPHANINE_STABILITY_ASAR,profile=process.env.ALPHANINE_DATA_DIR;
if(!profile||!path.isAbsolute(profile))throw Error("Isolated profile required");
const statePath=path.join(profile,"fixture-state.json"),fixturePath=path.join(__dirname,"cleanup-validation-fixture.js");
let lifecycleFault="";
const audit={commands:[],blocked:[],parserForks:[],policyInstallCalls:0};
const rawSpawn=cp.spawn,rawFork=cp.fork;
cp.spawn=function(binary,args=[],options){
  if(binary!==process.execPath||args[0]!==fixturePath){audit.blocked.push({kind:"spawn",binary});throw Error("Test package blocks external process execution");}
  return rawSpawn(binary,args,options);
};
cp.fork=function(modulePath,args,options){
  if(!/[/\\]lib[/\\]cleanup-process\.js$/.test(modulePath))throw Error("Test package blocks non-parser fork");
  audit.parserForks.push(modulePath);return rawFork(modulePath,args,options);
};
cp.execFile=function(binary,...args){const cb=args.at(-1);audit.blocked.push({kind:"execFile",binary});if(typeof cb==="function")queueMicrotask(()=>cb(Error("External commands disabled in test package"),"",""));return {kill(){},on(){return this;}};};
cp.execFileSync=cp.spawnSync=cp.execSync=()=>{throw Error("External synchronous commands disabled in test package");};
const net=require("net"),originalConnect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){const values=Array.isArray(args[0])?args[0]:args;const first=values[0],host=typeof first==="object"?first.host:typeof values[1]==="string"?values[1]:undefined;if(host&&!['127.0.0.1','localhost','::1'].includes(host)){audit.blocked.push({kind:"network",host});throw Error("Test package permits loopback networking only");}return originalConnect.apply(this,args);};
const createServer=http.createServer;
http.createServer=function(listener){return createServer((req,res)=>{
  const pathname=new URL(req.url,"http://127.0.0.1").pathname;
  if(pathname==="/__validation/health"){res.end("ready");return;}
  if(pathname==="/__validation/audit"){res.setHeader("content-type","application/json");res.end(JSON.stringify(audit));return;}
  if(pathname==="/__validation/lifecycle-fault"){let body="";req.on("data",c=>body+=c);req.on("end",()=>{lifecycleFault=JSON.parse(body||"{}").fault||"";res.end("ok");});return;}
  if(pathname==="/__validation/mode"){let text="";req.on("data",c=>text+=c);req.on("end",()=>{const input=JSON.parse(text||"{}");if(!["valid","invalid","exit","timeout","oom"].includes(input.mode)){res.statusCode=400;res.end("invalid mode");return;}fs.writeFileSync(statePath,JSON.stringify({mode:input.mode,removed:[]}));res.end("ok");});return;}
  if(pathname.startsWith("/api/")&&!pathname.startsWith("/api/server-packages/")&&!pathname.startsWith("/api/container-gc-lifecycle/")&&!pathname.startsWith("/api/container-gc/")&&pathname!=="/api/operations"){res.writeHead(503,{"content-type":"application/json"});res.end(JSON.stringify({ok:false,error:"Isolated cleanup test: other services are disabled"}));return;}
  listener(req,res);
});};
global.__cleanupTestContext=async()=>({target:"isolated-cleanup-test",execute:async(command,timeout=60000,options={})=>{
  audit.commands.push(command);
  const state=JSON.parse(fs.readFileSync(statePath,"utf8"));
  const result=await require(path.join(root,"lib/cleanup-process")).runCleanupCommand(process.execPath,[fixturePath,statePath,command],{command,json:options.json,projection:options.projection,timeout:state.mode==="timeout"?200:timeout,parserMemoryMb:state.mode==="oom"?16:256});
  audit.lastResult={ok:result.ok,stdoutBytes:result.stdoutBytes,error:result.error,parserMetrics:result.parserMetrics};
  return result;
}});
const serverPath=path.join(root,"server.js");let code=fs.readFileSync(serverPath,"utf8");
const begin=code.indexOf("async function packageCleanupContext()"),end=code.indexOf("function startVmDiskMaintenance(",begin);
if(begin<0||end<0)throw Error("Cleanup context injection anchor missing");
code=code.slice(0,begin)+"async function packageCleanupContext(){return global.__cleanupTestContext();}\n"+code.slice(end);
const targetBegin=code.indexOf("function packageCleanupTarget()"),targetEnd=code.indexOf("async function packageCleanupContext()",targetBegin);
code=code.slice(0,targetBegin)+'function packageCleanupTarget(){return "isolated-cleanup-test";}\n'+code.slice(targetEnd);
const backend=new Module(serverPath,module);backend.filename=serverPath;backend.paths=Module._nodeModulePaths(root);backend._compile(code,serverPath);
