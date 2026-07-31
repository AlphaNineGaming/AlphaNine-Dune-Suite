"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { StorageDepositStore, classifyStorageVerification } = require("../lib/storage-deposits");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alphanine-storage-deposits-"));
const historyPath = path.join(root, "storage-deposits.json");

try {
  const store = new StorageDepositStore(historyPath, { maxHistory: 10 });
  store.add({ receiptId: "storage-1", status: "database-verified", item: { itemIds: ["10"] } });
  store.update("storage-1", { visibility: "confirmed" });
  const reloaded = new StorageDepositStore(historyPath, { maxHistory: 10 });
  assert.equal(reloaded.get("storage-1").visibility, "confirmed");

  assert.deepEqual(
    classifyStorageVerification(
      { stackCount: 1, quantity: 25 },
      { foundStacks: 1, matchingStacks: 1, foundQuantity: 25, duplicateSlots: 0, invalidPositions: 0 }
    ).status,
    "database-verified"
  );
  assert.equal(
    classifyStorageVerification(
      { stackCount: 1, quantity: 25 },
      { foundStacks: 0, matchingStacks: 0, foundQuantity: 0, duplicateSlots: 0, invalidPositions: 0 }
    ).status,
    "runtime-overwrite"
  );
  assert.equal(
    classifyStorageVerification(
      { stackCount: 1, quantity: 25 },
      { foundStacks: 1, matchingStacks: 1, foundQuantity: 25, duplicateSlots: 1, invalidPositions: 0 }
    ).status,
    "integrity-warning"
  );

  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(source, /generate_series\(0, greatest\(t\.max_item_count-1, 0\)\)/);
  assert.match(source, /not exists\(select 1 from dune\.items occupied[\s\S]+occupied\.position_index=free_slot\.position_index\)/);
  assert.match(source, /Storage no longer has enough valid free slots/);
  assert.match(source, /count\(distinct i\.position_index\)=count\(\*\)/);
  assert.match(source, /Storage deposit failed transactional slot and quantity verification[\s\S]+commit;/);
  assert.match(source, /\/api\/admin\/storage-deposits\/recheck/);
  assert.match(source, /protectedStorageBattlegroupRefresh/);
  assert.doesNotMatch(source, /storage[\s\S]{0,80}kubectl delete pod/i);

  console.log("Storage deposit allocation and diagnostics tests passed.");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
