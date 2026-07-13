const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

function requirePattern(pattern, message) {
  if (!pattern.test(source)) throw new Error(message);
}

requirePattern(/id="progressionSpecializationTrack"[\s\S]*?Crafting[\s\S]*?Gathering[\s\S]*?Exploration[\s\S]*?Combat[\s\S]*?Sabotage/, "Specialization track editor is missing expected tracks.");
requirePattern(/action:"specialization_xp"[\s\S]*?trackType:target\.track[\s\S]*?xpAmount:target\.xpAmount[\s\S]*?level:target\.level/, "Specialization preview payload is incomplete.");
requirePattern(/Specialization editing requires the player to be offline\./, "Specialization writes are not guarded by offline-player validation.");
requirePattern(/from dune\.specialization_tracks[\s\S]*?verify_readback/, "Specialization apply does not perform database read-back verification.");
requirePattern(/does not purchase specialization traits or spend Spice Melange/, "Specialization editor does not explain the trait-purchase boundary.");

console.log("Specialization progression regression checks passed.");
