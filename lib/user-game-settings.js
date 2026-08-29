"use strict";

const USER_GAME_SETTINGS_SCHEMA = Object.freeze([
  { section: "/Script/DuneSandbox.PvpPveSettings", key: "m_bShouldForceEnablePvpOnAllPartitions", label: "Force PvP on all partitions", group: "PvP and security", type: "boolean" },
  { section: "/Script/DuneSandbox.SecurityZonesSubsystem", key: "m_bAreSecurityZonesEnabled", label: "Security zones enabled", group: "PvP and security", type: "boolean" },
  { section: "/DeteriorationSystem.ItemDeteriorationConstants", key: "UpdateRateInSeconds", label: "Item deterioration update rate", group: "World rules", type: "number", min: 0, max: 10, step: 0.1, decimals: 2, unit: "s" },
  { section: "/Script/DuneSandbox.SandStormConfig", key: "m_bCoriolisAutoSpawnEnabled", label: "Coriolis storm enabled", group: "World rules", type: "boolean" },
  { section: "/Script/DuneSandbox.BuildingSettings", key: "m_MaxNumLandclaimSegments", label: "Maximum landclaim segments", group: "Building", type: "integer", min: 1, max: 64, step: 1 },
  { section: "/Script/DuneSandbox.BuildingSettings", key: "m_BuildingBlueprintMaxExtensions", label: "Blueprint maximum extensions", group: "Building", type: "integer", min: 0, max: 128, step: 1 },
  { section: "/Script/DuneSandbox.BuildingSettings", key: "m_BaseBackupMaxExtensions", label: "Base-backup maximum extensions", group: "Building", type: "integer", min: 0, max: 256, step: 1 },
  { section: "/Script/DuneSandbox.BuildingSettings", key: "m_bBuildingRestrictionLimitsEnabled", label: "Building restriction limits", group: "Building", type: "boolean" },
  { section: "/Script/DuneSandbox.DuneGameMode", key: "m_GlobalXPMultiplier", label: "XP multiplier", group: "Progression and economy", type: "number", min: 0, max: 100, step: 0.05, decimals: 2, unit: "x" },
  { section: "/Script/DuneSandbox.DuneGameMode", key: "m_GlobalFameMultiplier", label: "Fame multiplier", group: "Progression and economy", type: "number", min: 0, max: 100, step: 0.05, decimals: 2, unit: "x" },
  { section: "/Script/DuneSandbox.DuneGameMode", key: "m_GlobalProgressionSpeedMultiplier", label: "Progression-speed multiplier", group: "Progression and economy", type: "number", min: 0, max: 100, step: 0.05, decimals: 2, unit: "x" },
  { section: "/Script/DuneSandbox.DuneGameMode", key: "m_GuildCreationCost", label: "Guild creation cost", group: "Progression and economy", type: "integer", min: 0, max: 1000000000, step: 100 },
  { section: "/Script/DuneSandbox.DuneGameMode", key: "SellOrderPricePercentageFee", label: "Sell-order fee", group: "Progression and economy", type: "number", min: 0, max: 100, step: 0.25, decimals: 2, unit: "%" },
  { section: "/Script/DuneSandbox.DuneGameMode", key: "SpiceTaxAmount", label: "Spice tax amount", group: "Progression and economy", type: "number", min: 0, max: 100, step: 0.05, decimals: 2 },
  { section: "/Script/DuneSandbox.DuneGameMode", key: "SpiceTaxInterval", label: "Spice tax interval", group: "Progression and economy", type: "integer", min: 0, max: 604800, step: 60, unit: "s" },
  { section: "/Script/DuneSandbox.DuneGameMode", key: "m_GlobalHarvestAmountMultiplier", label: "Harvest-amount multiplier", group: "Harvesting", type: "number", min: 0, max: 100, step: 0.05, decimals: 2, unit: "x" },
  { section: "/Script/DuneSandbox.DuneGameMode", key: "m_GlobalHarvestHealthMultiplier", label: "Harvest-node health multiplier", group: "Harvesting", type: "number", min: 0, max: 100, step: 0.05, decimals: 2, unit: "x" },
  { section: "/Script/DuneSandbox.DuneGameMode", key: "CutterayHemMultiplierPerNodeTierTable", label: "Cutteray HEM multiplier", group: "Harvesting", type: "number", min: 0, max: 100, step: 0.05, decimals: 2, unit: "x" }
]);

const SCHEMA_BY_KEY = new Map(USER_GAME_SETTINGS_SCHEMA.map((setting) => [setting.key, setting]));

function sameSection(left, right) {
  return String(left || "").trim().toLowerCase() === String(right || "").trim().toLowerCase();
}

function parseValue(setting, raw) {
  const text = String(raw ?? "").trim();
  if (setting.type === "boolean") {
    if (/^true$/i.test(text)) return true;
    if (/^false$/i.test(text)) return false;
    return null;
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function validateValue(setting, raw) {
  if (setting.type === "boolean") {
    if (typeof raw === "boolean") return raw;
    if (/^true$/i.test(String(raw))) return true;
    if (/^false$/i.test(String(raw))) return false;
    throw new Error(`${setting.key} must be True or False.`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${setting.key} must be a number.`);
  if (setting.type === "integer" && !Number.isInteger(value)) throw new Error(`${setting.key} must be a whole number.`);
  if (value < setting.min || value > setting.max) throw new Error(`${setting.key} must be between ${setting.min} and ${setting.max}.`);
  return value;
}

function formatValue(setting, value) {
  if (setting.type === "boolean") return value ? "True" : "False";
  if (setting.type === "integer") return String(value);
  return Number(value).toFixed(setting.decimals ?? 2);
}

function parseUserGameIni(content) {
  const values = {};
  let section = "";
  for (const line of String(content || "").split(/\r?\n/)) {
    const sectionMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      continue;
    }
    const settingMatch = line.match(/^\s*([^;#][^=]*?)\s*=\s*(.*?)\s*$/);
    if (!settingMatch) continue;
    const key = settingMatch[1].trim();
    const setting = SCHEMA_BY_KEY.get(key);
    if (!setting || !sameSection(section, setting.section)) continue;
    values[key] = parseValue(setting, settingMatch[2]);
  }
  return values;
}

function insertMissingSetting(lines, setting, formatted) {
  const header = `[${setting.section}]`;
  const sectionIndex = lines.findIndex((line) => sameSection(line.replace(/^\s*\[|\]\s*$/g, ""), setting.section) && /^\s*\[[^\]]+\]\s*$/.test(line));
  if (sectionIndex < 0) {
    if (lines.length && lines[lines.length - 1] !== "") lines.push("");
    lines.push(header, `${setting.key}=${formatted}`);
    return;
  }
  let insertAt = sectionIndex + 1;
  while (insertAt < lines.length && !/^\s*\[[^\]]+\]\s*$/.test(lines[insertAt])) insertAt += 1;
  lines.splice(insertAt, 0, `${setting.key}=${formatted}`);
}

function updateUserGameIni(content, requestedValues) {
  const updates = requestedValues && typeof requestedValues === "object" && !Array.isArray(requestedValues) ? requestedValues : {};
  const unknown = Object.keys(updates).filter((key) => !SCHEMA_BY_KEY.has(key));
  if (unknown.length) throw new Error(`Unsupported UserGame.ini setting: ${unknown.join(", ")}`);

  const validated = new Map();
  for (const [key, raw] of Object.entries(updates)) {
    const setting = SCHEMA_BY_KEY.get(key);
    validated.set(key, validateValue(setting, raw));
  }

  const newline = String(content || "").includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = /\r?\n$/.test(String(content || ""));
  const lines = String(content || "").split(/\r?\n/);
  if (trailingNewline) lines.pop();
  const seen = new Set();
  let section = "";

  for (let index = 0; index < lines.length; index += 1) {
    const sectionMatch = lines[index].match(/^\s*\[([^\]]+)\]\s*$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      continue;
    }
    const settingMatch = lines[index].match(/^(\s*)([^;#][^=]*?)\s*=\s*(.*?)\s*$/);
    if (!settingMatch) continue;
    const key = settingMatch[2].trim();
    const setting = SCHEMA_BY_KEY.get(key);
    if (!setting || !validated.has(key) || !sameSection(section, setting.section)) continue;
    lines[index] = `${settingMatch[1]}${key}=${formatValue(setting, validated.get(key))}`;
    seen.add(key);
  }

  for (const [key, value] of validated) {
    if (!seen.has(key)) insertMissingSetting(lines, SCHEMA_BY_KEY.get(key), formatValue(SCHEMA_BY_KEY.get(key), value));
  }

  const nextContent = lines.join(newline) + (trailingNewline ? newline : "");
  const before = parseUserGameIni(content);
  const changedKeys = [...validated].filter(([key, value]) => before[key] !== value).map(([key]) => key);
  return { content: nextContent, values: parseUserGameIni(nextContent), changedKeys };
}

module.exports = {
  USER_GAME_SETTINGS_SCHEMA,
  parseUserGameIni,
  updateUserGameIni,
  validateValue
};
