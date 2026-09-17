const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const s=fs.readFileSync(require('path').join(__dirname,'../server.js'),'utf8');const a=s.indexOf('async function repairDatabaseOwnership(){'),b=s.indexOf('\nasync function openBattlegroupBatch(){',a);const fn=s.slice(a,b);
async function test({duration,status='success',networkFailure=false}){
 let now=0,tick,cleared=false,resolvePost,polls=0;const sleeps=[];
 const nodes={};const node=id=>nodes[id]||(nodes[id]={style:{},attrs:{},setAttribute(k,v){this.attrs[k]=v;}});
 const context={document:{getElementById:node},Date:{now:()=>now},window:{setInterval:f=>(tick=f,1),clearInterval:()=>cleared=true},Number,Math,Promise,setTimeout:(f,ms)=>{sleeps.push(f);},renderOperations:()=>{},playUiSound:()=>{},betterError:e=>e.message,
 getJson:async url=>{if(url.includes('repair-ownership'))return new Promise(r=>resolvePost=r);polls++;if(networkFailure&&polls===1)throw Error('network');return {operations:[{id:'op',key:'repair:database-ownership',status,stage:status==='success'?'Completed':'Failed',detail:'done',error:status==='failed'?'repair failed':'',progress:status==='success'?100:75}]};}};
 const promise=vm.runInNewContext('('+fn+')',context)();
 now=4999;tick();assert.equal(node('databaseRepairProgress').hidden,true);
 if(duration>=5000){now=5000;tick();assert.equal(node('databaseRepairProgress').hidden,false);}
 now=duration;resolvePost({ok:true,operation:{id:'op'}});
 if(networkFailure){await new Promise(resolve=>setImmediate(resolve));assert(sleeps.length);sleeps.shift()();}
 await promise;
 assert(cleared);assert.equal(node('databaseOwnershipRepairButton').disabled,false);
 assert.equal(node('databaseRepairProgress').hidden,duration<5000);
 assert.equal(node('databaseRepairProgressBar').attrs['aria-valuenow'],status==='success'?'100':'75');
 if(status==='failed')assert.match(node('databaseOwnershipRepairStatus').textContent,/repair failed/);
}
(async()=>{await test({duration:4000});await test({duration:6000});await test({duration:6000,status:'failed'});await test({duration:6000,networkFailure:true});console.log('PASS: hidden below 5 seconds, visible at 5 seconds, success completion, failure preserves progress, connection recovery, timer cleanup.');})().catch(e=>{console.error(e);process.exitCode=1;});
