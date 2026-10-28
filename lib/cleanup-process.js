"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, fork } = require("node:child_process");
const { pipeline } = require("node:stream/promises");
const { Transform } = require("node:stream");

// Parse large inventories away from the HTTP event loop. Return only the fields
// used by the planner; never truncate a reference list or accept partial JSON.
if (process.argv.includes("--cleanup-parser") && process.send) {
  process.once("message", workerData => {
  try {
    let data = JSON.parse(fs.readFileSync(workerData.file, "utf8"));
    if (/\bimages\b/.test(workerData.command) && Array.isArray(data.images)) {
      data = { images: data.images.map(({id, repoTags, repoDigests, size, pinned}) => ({id, repoTags, repoDigests, size, pinned})) };
    } else if (/\bps\b/.test(workerData.command) && Array.isArray(data.containers)) {
      // Preserve every reference recognized by the existing conservative planner.
      const { references } = require("./server-package-cleanup");
      const { refs, builds } = references(data.containers);
      data = { containers: [{ references: [...refs, ...builds] }] };
    } else if (/\bkubectl get\b/.test(workerData.command) && Array.isArray(data.items)) {
      const { references } = require("./server-package-cleanup");
      const { refs, builds } = references(data.items);
      data = { items: [{ references: [...refs, ...builds] }] };
    }
    if (Buffer.byteLength(JSON.stringify(data), "utf8") > workerData.maxProjectedBytes) throw new Error("Projected inventory exceeds the safety limit; cleanup is disabled");
    const metrics={heapUsedBytes:process.memoryUsage().heapUsed,peakRssBytes:process.resourceUsage().maxRSS * 1024};
    process.send({ data, metrics }, () => process.disconnect());
  } catch (error) { process.send({ error: error.message }, () => process.disconnect()); }
  });
} else {
  let parserActive = false;
  function parseInventory(file, command, options) {
    if (parserActive) return Promise.reject(new Error("An inventory parser is already active; retry after it finishes"));
    parserActive = true;
    return new Promise((resolve, reject) => {
      let parser;
      try { parser = fork(__filename, ["--cleanup-parser"], {execArgv:["--max-old-space-size=" + (options.parserMemoryMb ?? 256)], env:{...process.env,ELECTRON_RUN_AS_NODE:"1"},windowsHide:true,serialization:"advanced",stdio:["ignore","ignore","pipe","ipc"]}); }
      catch (error) { parserActive = false; reject(error); return; }
      let settled = false, failure, parsed, stderr=Buffer.alloc(0);
      parser.stderr.on("data",chunk => {stderr=Buffer.concat([stderr,chunk]).subarray(-4096);});
      const finish = (error, data) => { if (settled) return; settled = true; clearTimeout(timer); failure=error;parsed=data;parser.kill("SIGKILL"); };
      const timer = setTimeout(() => finish(new Error("Inventory parsing timed out")), options.parseTimeout ?? 30000);
      parser.once("message", result => finish(result.error ? new Error(result.error) : null, result));
      parser.once("error", error => {finish(error);});
      parser.once("close", code => {
        clearTimeout(timer);parserActive=false;
        if(!settled) failure=new Error(/heap out of memory|heap limit/i.test(stderr.toString()) ? "Inventory parser exceeded its heap budget; cleanup is disabled" : "Inventory parser exited with code " + code);
        failure ? reject(failure) : resolve(parsed);
      });
      parser.send({file,command,projection:options.projection,maxProjectedBytes:options.maxProjectedBytes ?? 8 * 1024 * 1024}, error=>{if(error)finish(error);});
    });
  }

  async function runCleanupCommand(binary, args, options = {}) {
    const command = options.command || args.at(-1) || binary;
    const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    const timeout = options.timeout ?? 60000;
    let directory, child, timer, problem = "", stderr = Buffer.alloc(0), bytes = 0, timedOut = false;
    try {
      directory = await fs.promises.mkdtemp(path.join(options.tempRoot || os.tmpdir(), "a9-cleanup-"));
      const file = path.join(directory, "stdout");
      child = spawn(binary, args, { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
      const stop = message => { if (!problem) problem = message; child.kill("SIGKILL"); };
      const exited = new Promise(resolve => {
        child.once("error", error => { problem = error.message; resolve({code:null}); });
        child.once("close", (code, signal) => resolve({code, signal}));
      });
      child.stderr.on("data", chunk => {
        // Drain all stderr, retain a byte-bounded tail for diagnostics.
        stderr = Buffer.concat([stderr, chunk]).subarray(-65536);
      });
      timer = setTimeout(() => { timedOut = true; stop("Command timed out after " + timeout + " ms"); }, timeout);
      const limiter = new Transform({ transform(chunk, encoding, callback) {
        bytes += chunk.length;
        if (bytes > maxBytes) { stop("Inventory exceeds the " + maxBytes + " byte safety limit; cleanup is disabled"); callback(new Error(problem)); }
        else callback(null, chunk);
      }});
      const streamed = pipeline(child.stdout, limiter, fs.createWriteStream(file, {mode:0o600})).catch(error => stop(error.message));
      const [exit] = await Promise.all([exited, streamed]);
      clearTimeout(timer);
      if (problem || exit.code !== 0) return { ok:false, command, code:exit.code, timedOut, stdoutBytes:bytes, stdout:"", stderr:stderr.toString("utf8"), error:problem || "Command exited with code " + exit.code };
      if (options.json) {
        const parsed=await parseInventory(file, command, options);
        return { ok:true, command, stdoutBytes:bytes, data:parsed.data, parserMetrics:parsed.metrics, stderr:stderr.toString("utf8"), stdout:"" };
      }
      // Non-JSON callers only need df/removal output. Bound that independently.
      if (bytes > 1024 * 1024) throw new Error("Command text output exceeds 1 MiB; cleanup is disabled");
      return { ok:true, command, stdoutBytes:bytes, stdout:await fs.promises.readFile(file,"utf8"), stderr:stderr.toString("utf8") };
    } catch (error) {
      return {ok:false, command, stdoutBytes:bytes, stdout:"", stderr:stderr.toString("utf8"), error:error.message, timedOut};
    } finally {
      clearTimeout(timer);
      if (directory) await fs.promises.rm(directory, {recursive:true, force:true});
    }
  }
  module.exports = { runCleanupCommand };
}
