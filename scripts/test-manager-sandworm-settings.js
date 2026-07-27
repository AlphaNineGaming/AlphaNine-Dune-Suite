const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const managerSource = fs.readFileSync(path.join(root, "manager", "manager-server.py"), "utf8");
const uiSource = fs.readFileSync(path.join(root, "manager", "index.html"), "utf8");

for (const key of [
  "sandwormThreatScale",
  "sandwormMaxThreatScore",
  "sandwormThreatDecayDelay",
  "sandwormThreatDecayRate",
  "sandwormWalkingThreat",
  "sandwormRunningThreat",
  "sandwormSprintingThreat",
  "sandwormVehicleShootingThreat",
  "sandwormMinimumDistance",
  "sandwormDangerZones",
  "sandwormHibernation",
  "giantWormEnabled",
  "giantWormMinimumPlayers"
]) {
assert(uiSource.includes(`key: "${key}"`), `Environmental Rules is missing ${key}.`);
  assert(managerSource.includes(`"${key}"`), `UserGame.ini generator is missing ${key}.`);
}

assert(uiSource.includes("wormAggression: 1, sandwormThreatScale: 1.7"), "Hardcore preset does not use real Sandworm sensitivity.");
assert(uiSource.includes("wormAggression: 1, sandwormThreatScale: 0.5"), "Builder preset does not use real Sandworm sensitivity.");

for (const line of [
  "[/Script/DuneSandbox.SandwormSettings]",
  "ThreatScale={sandworm_threat_scale:.2f}",
  "DefaultMaxThreatScore={sandworm_max_threat:.1f}",
  "ThreatDecreaseCooldownInSeconds={sandworm_threat_decay_delay:.1f}",
  "ThreatDecreasingValuePerSec={sandworm_threat_decay_rate:.1f}",
  "WalkingThreatPerSec={sandworm_walking_threat:.1f}",
  "RunningThreatPerSec={sandworm_running_threat:.1f}",
  "SprintingThreatPerSec={sandworm_sprinting_threat:.1f}",
  "PlayerVehicleShootingThreatFactor={sandworm_vehicle_shooting_threat:.2f}",
  "m_MinDistanceBetweenSandworms={sandworm_min_distance:.1f}",
  "m_bEnableDangerZones={bool_text(sandworm_danger_zones)}",
  "m_bEnableHibernation={bool_text(sandworm_hibernation)}",
  "m_bGiantWormSystemEnabled={bool_text(giant_worm_enabled)}",
  "m_GiantWormMinimumPlayersOnSpiceField={giant_worm_min_players}"
]) {
  assert(managerSource.includes(line), `Generated UserGame.ini template is missing ${line}.`);
}

console.log("Server Management Sandworm Environmental Rules and UserGame.ini generation tests passed.");
