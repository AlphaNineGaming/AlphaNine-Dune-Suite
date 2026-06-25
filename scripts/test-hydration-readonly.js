const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractHydrationFromGasAttributes } = require("../lib/hydration");

const sample = {
  DuneHydrationAttributeSet: {
    HeatExhaustion: { BaseValue: 0, CurrentValue: 0 },
    CurrentHydration: { BaseValue: 88.417304, CurrentValue: 88.417304 },
    DehydrationPenalty: { BaseValue: 0, CurrentValue: 0 },
    ClothingCapturedWater: { BaseValue: 0, CurrentValue: 0 }
  }
};

{
  const hydration = extractHydrationFromGasAttributes(JSON.stringify(sample), { pawnActorId: 6 });
  assert.equal(hydration.available, true);
  assert.equal(hydration.readOnly, true);
  assert.equal(hydration.value, 88.417304);
  assert.equal(hydration.rounded, 88.4);
  assert.equal(hydration.baseValue, 88.417304);
  assert.equal(hydration.heatExhaustion, 0);
  assert.equal(hydration.dehydrationPenalty, 0);
  assert.equal(hydration.clothingCapturedWater, 0);
  assert.equal(hydration.maxValue, null);
  assert.equal(hydration.source.table, "dune.actors");
  assert.equal(hydration.source.column, "gas_attributes");
  assert.equal(hydration.source.valuePath, "DuneHydrationAttributeSet.CurrentHydration.CurrentValue");
}

{
  const hydration = extractHydrationFromGasAttributes(null, { pawnActorId: 6 });
  assert.equal(hydration.available, false);
  assert.equal(hydration.value, null);
  assert.equal(hydration.rounded, null);
}

{
  const hydration = extractHydrationFromGasAttributes("{not json", { pawnActorId: 6 });
  assert.equal(hydration.available, false);
  assert.equal(hydration.value, null);
}

{
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.doesNotMatch(server, /update\s+dune\.actors[\s\S]{0,300}gas_attributes/i);
  assert.doesNotMatch(server, /set\s+gas_attributes/i);
  assert.doesNotMatch(server, /jsonb_set\s*\(\s*gas_attributes/i);
  assert.doesNotMatch(server, /api\/admin\/refill-water/i);
  assert.doesNotMatch(server, /Refill Water/i);
}

console.log("Hydration read-only tests passed.");
