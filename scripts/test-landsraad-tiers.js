"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

assert(source.includes("from dune.landsraad_task_rewards"), "Tier inspection must use the authoritative Landsraad reward table.");
assert(/group by rewards\.threshold\r?\n\s*order by rewards\.threshold/.test(source), "Tier thresholds must be grouped and ordered by the integer column, not the selected text alias.");
assert(!source.includes("select threshold::text, count(*)::text\n    from dune.landsraad_task_rewards\n    group by threshold\n    order by threshold"), "Tier inspection must not sort the threshold::text output alias lexicographically.");
assert(source.includes("label: `Tier ${index + 1}`"), "Unnamed database thresholds must receive stable ascending Tier labels.");
assert(source.includes("thresholds[index] <= thresholds[index - 1]"), "Tier validation must reject duplicate or descending thresholds.");
assert(source.includes("Keep all ${expectedCount} detected Landsraad tiers."), "Tier editing must not silently add or remove reward tiers.");
assert(source.includes('progressionBackupPath("landsraad", "tiers", previewId)'), "A full backup must be created before tier writes.");
assert(source.includes('const LANDSRAAD_TIER_CONFIRM_TEXT = "APPLY LANDSRAAD TIERS"'), "Tier writes must require exact typed confirmation.");
assert(source.includes("lock table dune.landsraad_task_rewards in share row exclusive mode"), "Tier apply must lock the reward table before stale-data validation.");
assert(source.includes("Landsraad tier data changed after preview. No changes were applied."), "Apply must reject stale tier previews.");
assert(source.includes("Landsraad tier verification failed. Transaction rolled back."), "Apply must verify the updated distribution inside the transaction.");
assert(source.includes('url.pathname === "/api/landsraad/tiers"'), "Tier inspection API route is missing.");
assert(source.includes('url.pathname === "/api/landsraad/tiers/preview"'), "Tier preview API route is missing.");
assert(source.includes('url.pathname === "/api/landsraad/tiers/apply"'), "Tier apply API route is missing.");
assert(source.includes('id="landsraad"'), "Landsraad UI view is missing.");
assert(source.includes('class="landsraad-tier-threshold"'), "Editable Landsraad threshold inputs are missing.");

console.log("Landsraad tier display and protected editing regression checks passed.");
