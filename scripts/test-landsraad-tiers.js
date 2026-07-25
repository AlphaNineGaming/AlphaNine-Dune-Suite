"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

assert(source.includes("from dune.landsraad_task_rewards"), "Tier inspection must use the authoritative Landsraad reward table.");
assert(/group by rewards\.threshold\r?\n\s*order by rewards\.threshold/.test(source), "Tier thresholds must be grouped and ordered by the integer column, not the selected text alias.");
assert(!source.includes("select threshold::text, count(*)::text\n    from dune.landsraad_task_rewards\n    group by threshold\n    order by threshold"), "Tier inspection must not sort the threshold::text output alias lexicographically.");
assert(source.includes("detectedTiers.length === LANDSRAAD_TIER_COUNT"), "Tier inspection must require exactly five distinct thresholds.");
assert(source.includes("tiers = exactTierCount ? detectedTiers.map"), "Tier labels must only be created after the exact-five check.");
assert(source.includes("tiers,\n    detectedTierCount"), "Invalid tier counts must return no editable tier rows while retaining diagnostics.");
assert(source.includes("detectedThresholds"), "Invalid tier-count diagnostics must include every detected threshold.");
assert(source.includes("thresholds[index] <= thresholds[index - 1]"), "Tier validation must reject duplicate or descending thresholds.");
assert(source.includes("Keep all ${expectedCount} detected Landsraad tiers."), "Tier editing must not silently add or remove reward tiers.");
assert(source.includes('progressionBackupPath("landsraad", "tiers", previewId)'), "A full backup must be created before tier writes.");
assert(source.includes('const LANDSRAAD_TIER_CONFIRM_TEXT = "APPLY LANDSRAAD TIERS"'), "Tier writes must require exact typed confirmation.");
assert(source.includes("const currentInspect = await landsraadTierInspect();"), "Apply must re-check the exact-five invariant before opening its write transaction.");
assert(source.includes("lock table dune.landsraad_task_rewards in share row exclusive mode"), "Tier apply must lock the reward table before stale-data validation.");
assert(source.includes("Landsraad tier data changed after preview. No changes were applied."), "Apply must reject stale tier previews.");
assert(source.includes("Landsraad tier verification failed. Transaction rolled back."), "Apply must verify the updated distribution inside the transaction.");
assert(source.includes('url.pathname === "/api/landsraad/tiers"'), "Tier inspection API route is missing.");
assert(source.includes('url.pathname === "/api/landsraad/tiers/preview"'), "Tier preview API route is missing.");
assert(source.includes('url.pathname === "/api/landsraad/tiers/apply"'), "Tier apply API route is missing.");
assert(source.includes('id="landsraad"'), "Landsraad UI view is missing.");
assert(source.includes('class="landsraad-tier-threshold"'), "Editable Landsraad threshold inputs are missing.");
assert(source.includes('id="landsraadTierPreviewButton"'), "The preview button must have an explicit fail-closed disabled state.");
assert(source.includes("Exactly five distinct thresholds"), "The UI policy must state the exact-five requirement.");

function createHarness(initialThresholds) {
  let thresholds = [...initialThresholds];
  let beforeBackup = null;
  const calls = { metadata: 0, distribution: 0, backup: 0, streamed: 0, writes: [], audits: [] };
  const context = {
    crypto,
    Date,
    Error,
    Map,
    LANDSRAAD_TIER_COUNT: 5,
    LANDSRAAD_TIER_CONFIRM_TEXT: "APPLY LANDSRAAD TIERS",
    PROGRESSION_AUDIT_LOG: "progression-audit.log",
    landsraadTierPreviews: new Map(),
    parseDbRows: (rows) => rows,
    requireInteger: (value, label, min, max) => {
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`${label} is invalid.`);
      return number;
    },
    dbQuery: async (sql) => {
      if (sql.includes("information_schema.columns")) {
        calls.metadata += 1;
        return ["task_id", "threshold", "template_id", "amount"].map((column) => ({ column, data_type: column === "template_id" ? "text" : "bigint" }));
      }
      if (sql.includes("select task_id::text")) {
        calls.backup += 1;
        if (beforeBackup) beforeBackup();
        return thresholds.map((threshold, index) => ({ task_id: String(index + 1), threshold: String(threshold), template_id: `reward-${index + 1}`, amount: "1" }));
      }
      if (sql.includes("group by rewards.threshold")) {
        calls.distribution += 1;
        return thresholds.map((threshold) => ({ threshold: String(threshold), rowCount: "1" }));
      }
      throw new Error(`Unexpected query in Landsraad test: ${sql}`);
    },
    dbQueryStreamed: async () => {
      calls.streamed += 1;
      return [];
    },
    progressionBackupPath: () => "landsraad-test-backup.json",
    progressionAudit: (event, details) => calls.audits.push({ event, details }),
    loadConfig: () => ({ progressionEditingEnabled: true }),
    fs: {
      writeFileSync: (file, contents) => calls.writes.push({ file, contents }),
      existsSync: () => true
    }
  };
  vm.createContext(context);
  const start = source.indexOf("async function landsraadTierInspect()");
  const end = source.indexOf("function repairDecodeStats", start);
  assert(start >= 0 && end > start, "Could not isolate Landsraad implementation for behavior tests.");
  const implementation = source.slice(start, end);
  vm.runInContext(`${implementation}
globalThis.landsraadTestApi = {
  inspect: landsraadTierInspect,
  preview: landsraadTierPreview,
  apply: landsraadTierApply,
  previews: landsraadTierPreviews
};`, context);
  return {
    api: context.landsraadTestApi,
    calls,
    setThresholds(next) { thresholds = [...next]; },
    setBeforeBackup(callback) { beforeBackup = callback; }
  };
}

async function run() {
  const validThresholds = [35, 350, 700, 1050, 1400];
  const valid = createHarness(validThresholds);
  const validInspect = await valid.api.inspect();
  assert.equal(validInspect.ok, true, "A valid five-tier configuration must remain editable.");
  assert.deepEqual([...validInspect.tiers.map((row) => row.threshold)], validThresholds, "Valid thresholds must retain ascending tier identity.");
  assert.equal(validInspect.detectedTierCount, 5);
  const validPreview = await valid.api.preview({ thresholds: [40, 400, 800, 1200, 1600] });
  assert.equal(validPreview.ok, true, "A valid five-tier configuration must reach preview.");
  assert.equal(valid.calls.writes.length, 1, "Valid preview must create exactly one backup.");
  assert.equal(valid.api.previews.size, 1, "Valid preview must be retained for protected apply.");
  const validApply = await valid.api.apply({ previewId: validPreview.previewId, confirmText: "APPLY LANDSRAAD TIERS" });
  assert.equal(validApply.ok, true, "A valid five-tier preview must remain applicable.");
  assert.equal(valid.calls.streamed, 1, "Valid apply must reach the protected transaction.");

  const reportedThresholds = [35, 350, 700, 1050, 1400, 3500, 7000, 10500, 14000];
  const ambiguous = createHarness(reportedThresholds);
  const ambiguousInspect = await ambiguous.api.inspect();
  assert.equal(ambiguousInspect.ok, false, "The reported nine-threshold configuration must fail closed.");
  assert.equal(ambiguousInspect.status, "invalid_tier_count");
  assert.equal(ambiguousInspect.detectedTierCount, 9);
  assert.deepEqual([...ambiguousInspect.detectedThresholds], reportedThresholds);
  assert.deepEqual([...ambiguousInspect.tiers], [], "Ambiguous configurations must return no editable tiers.");
  assert.match(ambiguousInspect.reason, /detected 9: 35, 350, 700, 1050, 1400, 3500, 7000, 10500, 14000/);
  const rejectedPreview = await ambiguous.api.preview({ thresholds: validThresholds });
  assert.equal(rejectedPreview.ok, false, "Ambiguous configurations must not reach preview.");
  assert.equal(rejectedPreview.status, "invalid_tier_count");
  assert.equal(ambiguous.calls.backup, 0, "Rejected preview must not read backup rows.");
  assert.equal(ambiguous.calls.writes.length, 0, "Rejected preview must not create a backup.");
  assert.equal(ambiguous.api.previews.size, 0, "Rejected preview must not create an applicable preview token.");
  const rejectedApply = await ambiguous.api.apply({ previewId: "not-created", confirmText: "APPLY LANDSRAAD TIERS" });
  assert.equal(rejectedApply.ok, false, "Ambiguous configurations must not reach apply.");
  assert.equal(ambiguous.calls.streamed, 0, "Rejected apply must not execute database mutation SQL.");

  const changedDuringPreview = createHarness(validThresholds);
  changedDuringPreview.setBeforeBackup(() => changedDuringPreview.setThresholds(reportedThresholds));
  const raceRejected = await changedDuringPreview.api.preview({ thresholds: [40, 400, 800, 1200, 1600] });
  assert.equal(raceRejected.ok, false, "A configuration that becomes ambiguous during preview must fail closed.");
  assert.match(raceRejected.error, /changed during preview/);
  assert.equal(changedDuringPreview.calls.writes.length, 0, "A preview-time ambiguity race must not create a backup.");
  assert.equal(changedDuringPreview.api.previews.size, 0, "A preview-time ambiguity race must not create a preview token.");

  const changedAfterPreview = createHarness(validThresholds);
  const stalePreview = await changedAfterPreview.api.preview({ thresholds: [40, 400, 800, 1200, 1600] });
  changedAfterPreview.setThresholds(reportedThresholds);
  const blockedApply = await changedAfterPreview.api.apply({ previewId: stalePreview.previewId, confirmText: "APPLY LANDSRAAD TIERS" });
  assert.equal(blockedApply.ok, false, "Apply must stop if a formerly valid configuration becomes ambiguous.");
  assert.match(blockedApply.error, /detected 9:/);
  assert.equal(changedAfterPreview.calls.streamed, 0, "Ambiguity detected at apply time must leave every database row unchanged.");

  console.log("Landsraad exact-five inspection, preview, apply, ambiguity, and no-write regression checks passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
