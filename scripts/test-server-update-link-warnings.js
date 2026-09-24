"use strict";
const assert = require("node:assert/strict");
const { reconcileServerUpdateResult, runServerUpdateLifecycle } = require("../lib/server-update");

const selection = { namespace: "funcom-seabass-example", battlegroup: "example" };
const revision = "2118731-0-shipping";
const metadata = { ...selection, downloadedRevision: revision, deployedRevisions: [revision] };
const result = {
  ok: false, code: 1, signal: "", timedOut: false,
  stdout: `Success! App '4754530' fully installed.\nBattlegroup: example updated to ${revision}\nFinished updating battlegroup to version ${revision}\n`,
  stderr: "ln: /home/dune/.steam/root: No such file or directory\nln: /home/dune/.steam/steam: No such file or directory\nsteamcmd.sh[21069]: Starting  /home/dune/.local/share/Steam/steamcmd/linux32/steamcmd\nln: /home/dune/.dune/bin/battlegroup: File exists\nln: /home/dune/.dune/bin/bg-util: File exists\n"
};

(async () => {
  const recovered = await reconcileServerUpdateResult(result, selection, async () => metadata);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.code, 1, "Keep the vendor exit code for diagnostics");
  assert.equal(recovered.stderr, result.stderr);
  assert.match(recovered.warning, /applied and verified/);
  const steamError = "Error! App '4754530' state is 0x2A6 after update job";
  for (const stream of ["stdout", "stderr"]) {
    for (const code of [0, 1, 8]) {
      let verified = false;
      const failed = await reconcileServerUpdateResult({
        ...result, code, ok: code === 0, [stream]: result[stream] + steamError + "\n"
      }, selection, async () => { verified = true; return metadata; });
      assert.equal(failed.ok, false, "Steam failure must survive vendor completion messages and matching revisions");
      assert.equal(failed.underlyingError, steamError);
      assert.equal(verified, false);
      const outcome = await runServerUpdateLifecycle({ execute: async () => failed });
      assert.equal(outcome.ok, false);
      assert.equal(outcome.failure.underlyingError, steamError);
    }
  }
  for (const change of [
    { code: 255 }, { code: null }, { timedOut: true }, { signal: "SIGTERM" },
    { stdout: "" },
    { stdout: result.stdout + "Error: image import failed\n" },
    { stdout: result.stdout.replace("Battlegroup: example", "Battlegroup: other") },
    { stdout: result.stdout.replace("Finished updating", "Not finished updating") },
    { stderr: result.stderr + "Error: migration failed\n" },
    { stderr: "ln: /home/dune/.dune/bin/bg-util: Permission denied\n" }
  ]) {
    const failed = { ...result, ...change };
    assert.equal(await reconcileServerUpdateResult(failed, selection, () => { throw new Error("Should not verify"); }), failed);
  }
  for (const change of [
    { namespace: "other" }, { battlegroup: "other" }, { downloadedRevision: "old" },
    { deployedRevisions: [] }, { deployedRevisions: ["old", revision] }, { deployedRevisions: ["old"] }
  ]) assert.equal(await reconcileServerUpdateResult(result, selection, async () => ({ ...metadata, ...change })), result);
  assert.equal(await reconcileServerUpdateResult(result, {}, async () => metadata), result);
  assert.equal(await reconcileServerUpdateResult(result, selection, async () => { throw new Error("SSH unavailable"); }), result);
  let status = "running";
  const lifecycle = await runServerUpdateLifecycle({
    execute: () => reconcileServerUpdateResult(result, selection, async () => metadata),
    onSuccess: () => { status = "success"; },
    onFailure: () => { status = "failed"; }
  });
  assert.equal(lifecycle.ok, true);
  assert.equal(status, "success");
  console.log("Server update link warning recovery and failure preservation checks passed.");
})().catch(error => { console.error(error); process.exitCode = 1; });
