const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createVmStatusProbe } = require('../lib/vm-status-probe');
const source = fs.readFileSync(require('path').join(__dirname, '..', 'receivers', 'dune-live-give-receiver.js'), 'utf8');
function receiver(env = {}, output = '', error = null) {
  const calls = [];
  const app = { use() {}, get() {}, post() {}, listen() {} };
  const express = () => app;
  express.json = () => {};
  const context = vm.createContext({
    require(name) {
      if (name === 'express') return express;
      if (name === 'fs') return { existsSync: p => p === 'test-key' };
      if (name === 'child_process') return { execFile(command, args, options, callback) {
        calls.push({ command, args, options });
        callback(error, output, '');
      }};
      return require(name);
    },
    __dirname: path.resolve('work/app-inspect/source/receivers'),
    process: { env: { DUNE_RECEIVER_SSH_HOST: 'test-host', DUNE_RECEIVER_SSH_KEY: 'test-key', ...env } },
    console: { log() {}, error() {} }, Buffer, setTimeout, clearTimeout
  });
  vm.runInContext(source, context);
  return { resolve: () => context.resolveMqTarget(), calls };
}
async function main() {
  const bg = { DUNE_RECEIVER_BG_NAMESPACE: 'game-ns', DUNE_RECEIVER_BG_NAME: 'bg' };
  let r = receiver(bg, 'game-ns bg-mq-game-sts-0 Running\nother-ns other-mq-game-sts-0 Running\n');
  assert.equal((await r.resolve()).pod, 'bg-mq-game-sts-0');
  assert.match(r.calls[0].args.at(-1), /get pods -n 'game-ns' --no-headers -o custom-columns=/);
  assert.doesNotMatch(r.calls[0].args.at(-1), /-o json/);
  // The old query serializes unneeded pod annotations larger than its 4 MiB cap.
  const bloatedPod = { metadata: {namespace:'game-ns', name:'bg-mq-game-sts-0', annotations: {noise:'x'.repeat(5*1024*1024)}}, status:{phase:'Running'} };
  assert(JSON.stringify(bloatedPod).length > r.calls[0].options.maxBuffer);
  r = receiver(bg, `${bloatedPod.metadata.namespace} ${bloatedPod.metadata.name} ${bloatedPod.status.phase}\n`);
  assert.equal((await r.resolve()).pod, 'bg-mq-game-sts-0');
  r = receiver({}, 'one a-mq-game Running\ntwo b-mq-game Running\n');
  await assert.rejects(r.resolve(), /Multiple running/);
  r = receiver(bg, 'game-ns bg-mq-game-sts-0 Pending\n');
  await assert.rejects(r.resolve(), /running Dune/);
  r = receiver(bg, '');
  await assert.rejects(r.resolve(), /running Dune/);
  r = receiver(bg, 'not a valid pod row');
  await assert.rejects(r.resolve(), /parse compact/);
  r = receiver(bg, '', new Error('SSH connection failed'));
  await assert.rejects(r.resolve(), /SSH connection failed/);
  r = receiver({DUNE_RECEIVER_MQ_NAMESPACE:'explicit',DUNE_RECEIVER_MQ_POD:'explicit-pod'});
  assert.equal((await r.resolve()).pod, 'explicit-pod');
  assert.equal(r.calls.length, 0);
  console.log('PASS receiver: compact output despite large annotations, namespace isolation, explicit target, ambiguity, stopped/missing pods, malformed output, SSH errors');

  let reads = 0, finish, clock = 0;
  const probe = createVmStatusProbe({
    read: key => { reads++; return new Promise(resolve => { finish = result => resolve({name:key,...result}); }); },
    fallback: message => ({state:'Unknown',message}), now: () => clock, ttlMs:10
  });
  const initial = await Promise.all([probe.get('vm1', 2), probe.get('vm1', 2)]);
  assert.equal(reads, 1);
  assert(initial.every(v => v.state === 'Unknown'));
  finish({state:'Running'});
  await Promise.resolve();
  assert.equal((await probe.get('vm1', 2)).state, 'Running');
  assert.equal(reads, 1);
  clock = 11;
  assert.equal((await probe.get('vm1', 2)).state, 'Unknown');
  assert.equal(reads, 2);
  const oldFinish = finish;
  probe.invalidate();
  const newer = probe.get('vm1', 100);
  await Promise.resolve();
  oldFinish({state:'Running'});
  finish({state:'Stopped'});
  assert.equal((await newer).state, 'Stopped');
  assert.equal((await probe.get('vm1', 2)).state, 'Stopped');
  const different = probe.get('vm2', 100);
  await Promise.resolve();
  finish({state:'Unknown',error:'Access denied'});
  assert.equal((await different).error, 'Access denied');
  assert.equal(reads, 4);
  let fail = true;
  const errors = createVmStatusProbe({read:async()=>{if(fail)throw new Error('failed');return {state:'Running'};},fallback:()=>({state:'Unknown'})});
  await assert.rejects(errors.get('vm',10), /failed/);
  fail=false;
  assert.equal((await errors.get('vm',10)).state,'Running');
  console.log('PASS VM probe: overlapping polls, late completion retained, expiry, action invalidation, old-read isolation, changed VM, genuine errors, recovery');
}
main().catch(error => {console.error(error);process.exitCode=1;});
