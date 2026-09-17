const fs=require('fs'),vm=require('vm'),assert=require('assert/strict'),path=require('path');
const root=path.join(__dirname,'..');
const s=fs.readFileSync(path.join(root,'server.js'),'utf8');
const a=s.indexOf('async function applyBattlegroupControlIntent(control) {');
const source=s.slice(a,s.indexOf('\nasync function waitForBattlegroupStop(',a));
const conflict={ok:false,stderr:'Error from server (Conflict): the object has been modified; please apply your changes to the latest version and try again'};
const control={intent:{generation:'4',operationId:'op',stop:false,action:'update'},target:{name:'bg',namespace:'ns'}};
async function run(results,{superseded=false,newRemote=false}={}) {
 let reads=0,calls=0,checks=0,versions=[];
 const context={BigInt,Promise,setTimeout:f=>f(),shQuote:JSON.stringify,appendAdminAudit:()=>{},
 battlegroupControlJournal:{assertCurrent:()=>{if(superseded&&calls===1)throw Error('superseded');checks++;},append:()=>{},record:()=>({})},
 readBattlegroupControlResource:async()=>({evidence:{resourceVersion:String(++reads),generation:newRemote?'5':(calls&&results[Math.min(calls-1,results.length-1)].ok?'4':'3'),operationId:'op',stop:false}}),
 buildBattlegroupControlMergePatch:(intent,version)=>{versions.push(version);return {};},
 sshCommand:async()=>results[Math.min(calls++,results.length-1)]};
 const fn=vm.runInNewContext('('+source+')',context);
 try{return {value:await fn(control),calls,versions};}catch(error){return {error,calls,versions};}
}
(async()=>{
 let r=await run([conflict,{ok:true}]);assert(r.value.ok);assert.equal(r.calls,2);assert.deepEqual(r.versions,['1','2']);
 r=await run([conflict]);assert(r.error);assert.equal(r.calls,3);
 r=await run([{ok:false,stderr:'permission denied'}]);assert(r.error);assert.equal(r.calls,1);
 r=await run([conflict,{ok:true}],{superseded:true});assert.match(r.error.message,/superseded/);assert.equal(r.calls,1);
 r=await run([{ok:true}],{newRemote:true});assert(r.error);assert.equal(r.calls,0);
 const m=fs.readFileSync(root+'/electron/main.js','utf8');const x=m.indexOf('async function openBattlegroupBatchConsole('),y=m.indexOf('\nfunction generateReceiverToken',x);
 let opened=''; const launch=vm.runInNewContext('('+m.slice(x,y)+')',{path:path.win32,shell:{openPath:async p=>{opened=p;return '';}}});
 await launch('D:\\Steam Library\\battlegroup.bat');assert.equal(opened,'D:\\Steam Library\\battlegroup.bat');
 await assert.rejects(launch('D:\\other.bat'),/invalid/);
 const fail=vm.runInNewContext('('+m.slice(x,y)+')',{path:path.win32,shell:{openPath:async()=> 'Access denied'}});
 await assert.rejects(fail('D:\\battlegroup.bat'),/Access denied/);
 console.log('PASS: conflict retry, retry limit, non-conflict failure, superseded intent, competing remote intent, spaced launcher path, invalid path, launch failure');
})().catch(e=>{console.error(e);process.exitCode=1;});
