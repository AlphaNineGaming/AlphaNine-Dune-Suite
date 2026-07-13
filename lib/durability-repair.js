"use strict";

const ITEM_DEFAULT_MAX_DURABILITY = 100;

function durabilityNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function allowedRepairMaximum(kind, decayedMaximum) {
  const decayed = durabilityNumber(decayedMaximum);
  if (kind === "item") return decayed !== null && decayed > 0 ? decayed : ITEM_DEFAULT_MAX_DURABILITY;
  if (kind === "vehicle-module") return decayed !== null && decayed > 0 ? decayed : null;
  return null;
}

function durabilityRepairCandidate(kind, currentDurability, decayedMaximum) {
  const current = durabilityNumber(currentDurability);
  const maximum = allowedRepairMaximum(kind, decayedMaximum);
  if (current === null) return { repairable: false, reason: "Durability is not stored for this record.", current, maximum };
  if (maximum === null) return { repairable: false, reason: "The allowed maximum durability is unknown.", current, maximum };
  if (current >= maximum - 0.000001) return { repairable: false, reason: "Already at allowed maximum durability.", current, maximum };
  return { repairable: true, reason: "Current durability can be restored to the allowed maximum.", current, maximum };
}

module.exports = {
  ITEM_DEFAULT_MAX_DURABILITY,
  durabilityNumber,
  allowedRepairMaximum,
  durabilityRepairCandidate
};
