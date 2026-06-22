const HYDRATION_TOOLTIP = "Hydration is readable from player pawn GAS attributes. Refill/write is experimental and disabled until tested safely.";

function asNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function readPath(root, parts) {
  let current = root;
  for (const part of parts) {
    if (!current || typeof current !== "object" || !(part in current)) return null;
    current = current[part];
  }
  return current;
}

function parseGasAttributes(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function gasAttributeNumber(root, attributeName) {
  const value = readPath(root, ["DuneHydrationAttributeSet", attributeName, "CurrentValue"]);
  return asNumberOrNull(value);
}

function currentHydrationBase(root) {
  const value = readPath(root, ["DuneHydrationAttributeSet", "CurrentHydration", "BaseValue"]);
  return asNumberOrNull(value);
}

function extractHydrationFromGasAttributes(gasAttributes, options = {}) {
  const root = parseGasAttributes(gasAttributes);
  const pawnActorId = options.pawnActorId == null ? "" : String(options.pawnActorId);
  const source = {
    table: "dune.actors",
    column: "gas_attributes",
    pawnActorId,
    valuePath: "DuneHydrationAttributeSet.CurrentHydration.CurrentValue",
    baseValuePath: "DuneHydrationAttributeSet.CurrentHydration.BaseValue",
    writable: false
  };
  const unavailable = {
    available: false,
    readOnly: true,
    label: "Water / Hydration",
    value: null,
    rounded: null,
    baseValue: null,
    heatExhaustion: null,
    dehydrationPenalty: null,
    clothingCapturedWater: null,
    maxValue: null,
    source,
    tooltip: HYDRATION_TOOLTIP
  };
  if (!root) return unavailable;
  const value = gasAttributeNumber(root, "CurrentHydration");
  const result = {
    ...unavailable,
    available: value !== null,
    value,
    rounded: value === null ? null : Math.round(value * 10) / 10,
    baseValue: currentHydrationBase(root),
    heatExhaustion: gasAttributeNumber(root, "HeatExhaustion"),
    dehydrationPenalty: gasAttributeNumber(root, "DehydrationPenalty"),
    clothingCapturedWater: gasAttributeNumber(root, "ClothingCapturedWater")
  };
  return result;
}

module.exports = {
  HYDRATION_TOOLTIP,
  extractHydrationFromGasAttributes
};
