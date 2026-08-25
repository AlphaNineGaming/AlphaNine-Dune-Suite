const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const backendStart = source.indexOf("function playerInventoryTargetCtes");
const backendEnd = source.indexOf("function playerDiagnosticLines", backendStart);
const backend = source.slice(backendStart, backendEnd);
const uiStart = source.indexOf("function playerInventoryCatalogItem");
const uiEnd = source.indexOf("function renderPlayers", uiStart);
const ui = source.slice(uiStart, uiEnd);

assert(backendStart >= 0 && backendEnd > backendStart, "Player inventory backend functions are missing.");
assert(uiStart >= 0 && uiEnd > uiStart, "Player inventory UI functions are missing.");

assert(source.includes('id="playerInventoryRows"'), "Players view is missing the inventory table.");
assert(source.includes('id="playerInventorySearch"'), "Players view is missing inventory search.");
assert(source.includes('class="danger" data-player-inventory-delete'), "Inventory rows are missing direct delete actions.");
assert(source.includes('url.pathname === "/api/admin/player-inventory" && req.method === "GET"'), "Inventory list API route is missing.");
assert(source.includes('url.pathname === "/api/admin/player-inventory/delete" && req.method === "POST"'), "Inventory delete API route is missing.");

assert.match(backend, /inv\.actor_id = \(select actor_id::bigint from target_player limit 1\)/, "Backpack discovery must be scoped to the selected player's actor.");
assert.match(backend, /inv\.inventory_type = 0/, "Backpack discovery must prefer inventory type 0.");
assert.match(backend, /i\.id = \$\{itemId\}[\s\S]*i\.inventory_id = \(select id from selected_player_inventory limit 1\)/, "Delete target must require the exact item inside the selected player's backpack.");
assert.match(backend, /delete from dune\.items i[\s\S]*using player_inventory_delete_target t[\s\S]*i\.id = t\.id and i\.inventory_id = t\.inventory_id/, "Delete must use the captured item and inventory identity.");
assert.match(backend, /output = await dbQueryStreamed\(/, "Inventory deletion must stream its transaction instead of placing the full SQL payload on the SSH command line.");
assert.doesNotMatch(backend, /select inv\.id[\s\S]*for update/, "Inventory deletion must not take a broad inventory-row lock that can stall behind the live game server.");
assert.match(backend, /recoveredAfterTransportInterruption/, "Inventory deletion must verify the final state after an interrupted SSH response.");
assert.match(backend, /appendAdminAudit\("player_inventory_item_deleted"/, "Successful deletes must be audited.");
assert.doesNotMatch(backend, /backupPath|create.*backup|confirmed\s*!==/, "Simple inventory deletion must not require preview, backup, or a confirmation field.");

assert.match(ui, /appConfirm\("Delete Inventory Item"/, "The direct delete button should use one standard confirmation dialog.");
assert.match(ui, /JSON\.stringify\(\{playerId:player\.id,itemId:row\.id\}\)/, "The UI must send both player and item identity.");
assert.match(ui, /await refreshPlayerInventory\(\)/, "The inventory list must refresh after deletion.");

console.log("Player inventory display and direct-delete checks passed.");
