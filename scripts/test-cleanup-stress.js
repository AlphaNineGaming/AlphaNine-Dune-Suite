"use strict";
const assert = require("node:assert/strict");
const {performance,monitorEventLoopDelay} = require("node:perf_hooks");
const {runCleanupCommand} = require("../lib/cleanup-process");
const mib=1024*1024;
const command="sudo -n k3s crictl ps -a -o json";
const results=[];
async function measure(name,code,options={}) {
  const initial=process.memoryUsage().rss;let peak=initial;
  const delay=monitorEventLoopDelay({resolution:5});delay.enable();
  const sampler=setInterval(()=>{peak=Math.max(peak,process.memoryUsage().rss);},5);
  const start=performance.now();
  try {
    const result=await runCleanupCommand(process.execPath,["-e",code],{json:true,command,...options});
    const row={name,ok:result.ok,rawMiB:Number((result.stdoutBytes/mib).toFixed(2)),elapsedMs:Math.round(performance.now()-start),initialRssMiB:Math.round(initial/mib),peakRssMiB:Math.round(peak/mib),rssGrowthMiB:Math.round((peak-initial)/mib),parserPeakRssMiB:result.parserMetrics?Math.round(result.parserMetrics.peakRssBytes/mib):null,maxEventLoopDelayMs:Math.round(delay.max/1e6),error:result.error};
    results.push(row);
    assert(peak-initial<128*mib,"Parent exceeded the offline RSS growth budget: "+JSON.stringify(row));
    if(row.parserPeakRssMiB!==null)assert(row.parserPeakRssMiB<384,"Parser exceeded offline RSS budget");
    assert(delay.max/1e6<1000,"Main event loop stalled for over a second");
    return result;
  } finally {clearInterval(sampler);delay.disable();}
}
(async()=>{
  for(const size of [18,48]) {
    const code='process.stdout.write(JSON.stringify({containers:[{imageRef:"sha256:'+"a".repeat(64)+'",labels:{padding:"x".repeat('+size+'*1024*1024)}}]}))';
    assert.equal((await measure(size+" MiB label",code)).ok,true);
  }
  const rows='const row={imageRef:"sha256:'+"b".repeat(64)+'",metadata:{name:"fixture"},labels:{padding:"x".repeat(500)}};process.stdout.write(JSON.stringify({containers:Array.from({length:60000},()=>row)}));';
  assert.equal((await measure("60000 structured containers",rows)).ok,true);
  const unique='const repo="registry.funcom.com/funcom/self-hosting/seabass-server";process.stdout.write(JSON.stringify({containers:Array.from({length:40000},(_,i)=>({imageRef:"sha256:"+i.toString(16).padStart(64,"0"),image:{image:repo+":"+(2000000+i)+"-0-shipping"}}))}));';
  const distinct=await measure("40000 containers with distinct protected references",unique);assert.equal(distinct.ok,true);assert.equal(distinct.data.containers[0].references.length,80000);
  const cap='(async()=>{const {once}=require("events");const part="x".repeat(1024*1024);for(let i=0;i<66;i++)if(!process.stdout.write(part))await once(process.stdout,"drain");})()';
  const exceeded=await measure("default 64 MiB output cap",cap);assert.equal(exceeded.ok,false);assert.match(exceeded.error,/safety limit/);
  const projection=await measure("projection cap",'process.stdout.write(JSON.stringify({containers:[{imageRef:"registry.funcom.com/funcom/self-hosting/"+"x".repeat(10000)}]}))',{maxProjectedBytes:1024});assert.equal(projection.ok,false);assert.match(projection.error,/Projected inventory/);
  const timeout=await measure("worker timeout",rows,{parseTimeout:1});assert.equal(timeout.ok,false);assert.match(timeout.error,/parsing timed out/);
  const workerFailure=await measure("parser heap exhaustion",rows,{parserMemoryMb:16});assert.equal(workerFailure.ok,false);assert.match(workerFailure.error,/memory|heap|exited/i);
  assert.equal((await measure("recovery after worker failures",'process.stdout.write("{\\"containers\\":[]}")')).ok,true);
  console.log(JSON.stringify({passed:true,scope:"Parent RSS sampled every 5ms; parser RSS from its OS peak resource usage. Synthetic producer excluded. Limits are regression budgets, not production guarantees.",results},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
