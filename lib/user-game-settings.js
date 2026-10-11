"use strict";

const USER_GAME_SETTINGS_SCHEMA = Object.freeze([
  { section: "/Script/DuneSandbox.LandsraadSettings", key: "m_TaskGoalAmount", iniKey: "Data", label: "Task goal amount", note: "Edits Landsraad Data.m_TaskGoalAmount. Restart the battlegroup after saving.", group: "Landsraad", type: "integer", min: 0, max: 1000000, step: 1 },
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
  { section: "/Script/DuneSandbox.DuneGameMode", key: "m_GlobalHarvestAmountMultiplier", label: "Harvest amount (effect unverified)", note: "Writing this key is supported by the editor, but its gameplay effect has not been verified. Mining uses separate UserEngine.ini controls: Dune.GlobalMiningOutputMultiplier and Dune.GlobalVehicleMiningOutputMultiplier.", group: "Harvesting", type: "number", min: 0, max: 100, step: 0.05, decimals: 2, unit: "x" },
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
  if (setting.iniKey && (raw === null || typeof raw === "boolean" || !String(raw ?? "").trim())) throw new Error(`${setting.key} must be a number.`);
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

// Find only direct members of an Unreal struct, ignoring commas and names in
// nested structs or quoted asset paths. Keep spans so other bytes survive edits.
function structMembers(raw) {
  const text = String(raw), start = text.indexOf("(");
  if (start < 0 || text.slice(0, start).trim()) throw new Error("Invalid Landsraad Data struct. Reload and check UserGame.ini.");
  let depth = 1, quote = "", memberStart = start + 1;
  const members = [];
  for (let i = memberStart; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (char === "\\") { i += 1; continue; }
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if ((char === "," && depth === 1) || depth === 0) {
      const part = text.slice(memberStart, i);
      const match = part.match(/^(\s*)([^=\s]+)(\s*=\s*)(.*?)(\s*)$/);
      if (match) members.push({ key: match[2], start: memberStart + match[1].length + match[2].length + match[3].length, end: i - match[5].length });
      else if (part.trim()) throw new Error("Invalid Landsraad Data member. No settings changed.");
      memberStart = i + 1;
      if (depth === 0) {
        if (text.slice(i + 1).trim()) throw new Error("Invalid Landsraad Data suffix. No settings changed.");
        return { members, close: i };
      }
    }
  }
  throw new Error("Unclosed Landsraad Data struct. No settings changed.");
}

function structValue(setting, raw) {
  try {
    const matches = structMembers(raw).members.filter(member => member.key === setting.key);
    if (matches.length !== 1) return null;
    return parseValue(setting, raw.slice(matches[0].start, matches[0].end));
  } catch { return null; }
}

function updateStruct(setting, raw, formatted) {
  const { members, close } = structMembers(raw);
  const matches = members.filter(member => member.key === setting.key);
  if (matches.length > 1) throw new Error(`Duplicate ${setting.key} in Landsraad Data. No settings changed.`);
  if (matches.length) {
    const member = matches[0];
    return raw.slice(0, member.start) + formatted + raw.slice(member.end);
  }
  return raw.slice(0, close) + (raw.slice(raw.indexOf("(") + 1, close).trim() ? "," : "") + `${setting.key}=${formatted}` + raw.slice(close);
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
    const structSetting = USER_GAME_SETTINGS_SCHEMA.find(setting => setting.iniKey === key && sameSection(section, setting.section));
    if (structSetting) {
      values[structSetting.key] = structValue(structSetting, settingMatch[2]);
      continue;
    }
    const setting = SCHEMA_BY_KEY.get(key);
    if (!setting || setting.iniKey || !sameSection(section, setting.section)) continue;
    values[key] = parseValue(setting, settingMatch[2]);
  }
  return values;
}

function insertMissingSetting(lines, setting, formatted) {
  const entry = setting.iniKey ? `${setting.iniKey}=(${setting.key}=${formatted})` : `${setting.key}=${formatted}`;
  const header = `[${setting.section}]`;
  const sectionIndex = lines.findIndex((line) => sameSection(line.replace(/^\s*\[|\]\s*$/g, ""), setting.section) && /^\s*\[[^\]]+\]\s*$/.test(line));
  if (sectionIndex < 0) {
    if (lines.length && lines[lines.length - 1] !== "") lines.push("");
    lines.push(header, entry);
    return;
  }
  let insertAt = sectionIndex + 1;
  while (insertAt < lines.length && !/^\s*\[[^\]]+\]\s*$/.test(lines[insertAt])) insertAt += 1;
  lines.splice(insertAt, 0, entry);
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
    const structSetting = USER_GAME_SETTINGS_SCHEMA.find(setting => setting.iniKey === key && sameSection(section, setting.section));
    if (structSetting && validated.has(structSetting.key)) {
      lines[index] = `${settingMatch[1]}${key}=${updateStruct(structSetting, settingMatch[3], formatValue(structSetting, validated.get(structSetting.key)))}`;
      seen.add(structSetting.key);
      continue;
    }
    const setting = SCHEMA_BY_KEY.get(key);
    if (!setting || setting.iniKey || !validated.has(key) || !sameSection(section, setting.section)) continue;
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
