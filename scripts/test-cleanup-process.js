"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { promisify } = require("node:util");
const execFile = promisify(require("node:child_process").execFile);
const { runCleanupCommand } = require("../lib/cleanup-process");
const { inventory, planInventory, references } = require("../lib/server-package-cleanup");
const command = "sudo -n k3s crictl ps -a -o json";
const repo = "registry.funcom.com/funcom/self-hosting/seabass-server";
const digest = "sha256:" + "a".repeat(64);
const producer = 'process.stdout.write(JSON.stringify({containers:[{imageRef:"' + digest + '",image:{image:"' + repo + ':2000001-0-shipping"},labels:{other:"x".repeat(18*1024*1024)}}]}))';
(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "a9-test-"));
  const server = http.createServer((req,res) => res.end("ready"));
  await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
  const endpoint = "http://127.0.0.1:" + server.address().port;
  try {
    await assert.rejects(execFile(process.execPath,["-e",producer],{maxBuffer:16*1024*1024}), error => error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
    let finished = false, probes = 0;
    const pending = runCleanupCommand(process.execPath,["-e",producer],{json:true, command, tempRoot}).finally(() => {finished=true;});
    while (!finished) { assert.equal(await (await fetch(endpoint)).text(),"ready"); probes++; await new Promise(resolve => setTimeout(resolve,10)); }
    const large = await pending;
    assert.equal(large.ok,true,large.error);
    assert(references(large.data).refs.has(digest));
    assert(references(large.data).refs.has(repo + ":2000001-0-shipping"));
    assert(JSON.stringify(large.data).length < 1000);
    assert(probes > 1);
    console.log("PASS: reproduced original 16 MiB execFile overflow; streamed >18 MiB JSON, preserved references, HTTP remained responsive (" + probes + " requests).");
    const run = (code,opts={}) => runCleanupCommand(process.execPath,["-e",code],{json:true,command,tempRoot,...opts});
    const capped = await run('process.stdout.write("x".repeat(100000))',{maxBytes:1024});
    assert.equal(capped.ok,false); assert.match(capped.error,/safety limit/); assert.equal(capped.stdout,"");
    const malformed = await run('process.stdout.write("{broken")'); assert.equal(malformed.ok,false);
    const failed = await run('process.stderr.write("failure");process.exit(7)'); assert.equal(failed.code,7); assert.equal(failed.stderr,"failure");
    const timed = await run('setInterval(()=>{},1000)',{timeout:100}); assert.equal(timed.timedOut,true);
    const missing = await runCleanupCommand(path.join(tempRoot,"missing.exe"),[],{tempRoot}); assert.equal(missing.ok,false);
    const stderr = await run('process.stderr.write("e".repeat(200000));process.stdout.write("{}")'); assert.equal(stderr.ok,true); assert(Buffer.byteLength(stderr.stderr)<=65536);
    const df = await run('process.stdout.write("disk 2000 1000 1000 50% /\\n")',{json:false}); assert.equal(df.ok,true);
    await assert.rejects(inventory(async()=>({...capped,command})),/crictl ps|crictl images/);
    const id = n => "sha256:" + String(n).repeat(64);
    const sample = {images:{images:[1,2,3].map(n=>({id:id(n),repoTags:[repo+":"+(2000000+n)+"-0-shipping"],size:"1"}))},containers:{containers:[{imageRef:id(1),image:{image:repo+":2000001-0-shipping"}}]},workloads:{items:[]},battlegroups:{items:[]},disk:{availableBytes:1}};
    // A compacted inventory must make exactly the same retention decision.
    const fromWorker = await run('process.stdout.write('+JSON.stringify(JSON.stringify(sample.containers))+')');
    assert.deepEqual(planInventory(sample),planInventory({...sample,containers:fromWorker.data}));
    const rawWorkloads = {items:[{metadata:{annotations:{revision:"2000001"}},spec:{containers:[{image:repo+"@"+id(1)}]}}]};
    const projected = await run('process.stdout.write('+JSON.stringify(JSON.stringify(rawWorkloads))+')',{command:"sudo -n kubectl get pods,deployments -A -o json"});
    assert.deepEqual([...references(rawWorkloads).refs].sort(),[...references(projected.data).refs].sort());
    assert.deepEqual([...references(rawWorkloads).builds].sort(),[...references(projected.data).builds].sort());
    assert.deepEqual(await fs.readdir(tempRoot),[]);
    console.log("PASS: output cap, invalid JSON, nonzero exit, timeout, spawn error, bounded stderr, text output, diagnostic command, retention equivalence, temporary-file cleanup.");
  } finally { await new Promise(resolve => server.close(resolve)); await fs.rm(tempRoot,{recursive:true,force:true}); }
})().catch(error => {console.error(error);process.exitCode=1;});
