const assert=require('assert/strict'),fs=require('fs'),vm=require('vm');
const {runHealthChecks,healthCommandResult}=require('../lib/health-check-runner');
(async()=>{
 let active=0,peak=0;
 const results=await runHealthChecks(Array.from({length:16},(_,i)=>async()=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,2));active--;if(i===5)throw Error('failure');return i;}));
 assert.equal(peak,4);assert.equal(results[15],15);assert.equal(results[5].ok,false);
 assert.match(healthCommandResult({ok:false,killed:true},10000).error,/10000 ms/);
 assert.match(healthCommandResult({ok:false,errorCode:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'},1).error,/buffer/);
 assert.equal(healthCommandResult({ok:false,stderr:'Permission denied'},1).error,'Permission denied');
 const source=fs.readFileSync(require('path').join(__dirname, '..', 'server.js'),'utf8');let connections=0,calls=[];
 const ctx=vm.createContext({runHealthChecks,healthCommandResult,Date,standardVmSshConnection:async()=>{connections++;return {args:['-o','LogLevel=QUIET','dune@host']};},run:async(_,args)=>{calls.push(args);return {ok:true,stdout:'{}'};},loadConfig:()=>({}),normalizeSelectedBattlegroup:x=>x,vmInfoFast:async()=>({}),databaseHealthSnapshot:async()=>({}),receiverStatus:async()=>({}),marketBotStatus:async()=>({}),buildServerHealthReport:x=>x});
 vm.runInContext(source.slice(source.indexOf('async function serverHealthRemoteCheck'),source.indexOf('function serverHealthSnapshot')),ctx);
 const result=await ctx.runServerHealthScan();assert.equal(connections,1);assert.equal(calls.length,12);assert(calls.every(args=>args.includes('LogLevel=ERROR')&&args.includes('BatchMode=yes')));assert(result.commandResults.pods.ok);
 console.log('PASS bounded concurrency, failure isolation, diagnostic errors, shared SSH discovery and noninteractive SSH');
})().catch(e=>{console.error(e);process.exitCode=1;});
