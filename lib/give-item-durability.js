"use strict";

const SET_DURABILITY_VALUE = 200;
const DURABILITY_JSON_PATH = ["FItemStackAndDurabilityStats", "1", "CurrentDurability"];
const DURABILITY_SQL_PATH = "{FItemStackAndDurabilityStats,1,CurrentDurability}";
const MAXIMUM_DURABILITY_JSON_PATH = ["FItemStackAndDurabilityStats", "1", "DecayedMaxDurability"];
const MAXIMUM_DURABILITY_SQL_PATH = "{FItemStackAndDurabilityStats,1,DecayedMaxDurability}";

const DURABLE_UTILITY_TYPES = new Set([
  "bloodtools",
  "buildingtools",
  "cartographytools",
  "compactor",
  "cutteray",
  "powerpack",
  "suspensor",
  "watertools"
]);

const DURABLE_UNTYPED_UTILITY_ID = /(?:vehiclebackuptool|repairtool|weldingtorch|handheldtorch|portablelight|holtzmanshield)/i;

function text(value) {
  return String(value || "").trim();
}

function key(value) {
  return text(value).toLowerCase().replace(/[\s_-]+/g, "");
}

function requestedDurability(value) {
  return value === true || value === "true";
}

function durabilityEligibility(item = null) {
  if (!item || !text(item.id)) {
    return {
      applicable: false,
      kind: "non-durable",
      reason: "Durability not applicable: the exact template is not present in the authoritative item catalog."
    };
  }
  const category = key(item.category);
  const type = key(item.type || item.subtype);
  const id = text(item.id);

  if (["schematics", "resources", "consumables", "augment", "customization", "customizations", "decorations", "misc", "items", "vehicle"].includes(category)) {
    return {
      applicable: false,
      kind: "non-durable",
      reason: `Durability not applicable: ${text(item.category) || "this item class"} is not an authoritative durable inventory class.`
    };
  }

  if (["weapons", "rangedweapons", "meleeweapons", "weapon"].includes(category)) {
    if (["ammunition", "utility"].includes(type)) {
      return { applicable: false, kind: "non-durable", reason: "Durability not applicable: ammunition and weapon supplies are non-durable." };
    }
    return { applicable: true, kind: "weapon", reason: "Eligible weapon inventory item." };
  }
  if (["garment", "clothes", "clothing", "armor", "armour"].includes(category)) {
    return { applicable: true, kind: "armor", reason: "Eligible armor or wearable equipment item." };
  }
  if (["vehicles", "equipment"].includes(category)) {
    return { applicable: true, kind: "equipment", reason: "Eligible equipment or vehicle-module inventory item." };
  }
  if (["utility", "tools", "tool"].includes(category)) {
    if (DURABLE_UTILITY_TYPES.has(type) || (!type && DURABLE_UNTYPED_UTILITY_ID.test(id))) {
      return { applicable: true, kind: type === "powerpack" || type === "suspensor" ? "equipment" : "tool", reason: "Eligible tool or equipment inventory item." };
    }
    return { applicable: false, kind: "non-durable", reason: "Durability not applicable: this utility subtype is a consumable or is not proven durable." };
  }
  return {
    applicable: false,
    kind: "non-durable",
    reason: "Durability not applicable: this catalog class is not proven to support item durability."
  };
}

function durabilityExpectation(item, requested) {
  const eligibility = durabilityEligibility(item);
  const selected = requestedDurability(requested);
  const applied = selected && eligibility.applicable;
  return {
    option: "Give at full durability — 200 / 200",
    requested: selected,
    applicable: eligibility.applicable,
    applied,
    kind: eligibility.kind,
    currentDurability: applied ? SET_DURABILITY_VALUE : null,
    maximumDurability: applied ? SET_DURABILITY_VALUE : null,
    display: eligibility.applicable
      ? (applied ? "Full durability ON: 200 current / 200 maximum" : "Default durability: not forced")
      : "Durability not applicable",
    reason: eligibility.reason,
    field: `stats.${DURABILITY_JSON_PATH[0]}[1].${DURABILITY_JSON_PATH[2]}`,
    maximumField: `stats.${MAXIMUM_DURABILITY_JSON_PATH[0]}[1].${MAXIMUM_DURABILITY_JSON_PATH[2]}`,
    encoding: "JSON number"
  };
}

function itemStatsForGrant(expectation) {
  const durability = expectation?.applied
    ? { CurrentDurability: SET_DURABILITY_VALUE, DecayedMaxDurability: SET_DURABILITY_VALUE }
    : {};
  return {
    FCustomizationStats: [[], {}],
    FItemStackAndDurabilityStats: [[], durability]
  };
}

function itemStatsJsonForGrant(expectation) {
  return JSON.stringify(itemStatsForGrant(expectation));
}

function classifyDurabilityReadBack(expectation, observed = {}) {
  const found = Math.max(0, Number(observed.foundStacks) || 0);
  const numeric = Math.max(0, Number(observed.numericDurabilityStacks) || 0);
  const exact = Math.max(0, Number(observed.exactDurabilityStacks) || 0);
  const present = Math.max(0, Number(observed.durabilityPresentStacks) || 0);
  const maximumNumeric = Math.max(0, Number(observed.numericMaximumDurabilityStacks) || 0);
  const maximumExact = Math.max(0, Number(observed.exactMaximumDurabilityStacks) || 0);
  const maximumPresent = Math.max(0, Number(observed.maximumDurabilityPresentStacks) || 0);
  if (expectation?.applied) {
    if (found === 0) return { ok: false, status: "runtime-overwrite", message: "The granted item rows disappeared before durability could be rechecked." };
    if (numeric !== found || exact !== found || maximumNumeric !== found || maximumExact !== found) {
      return { ok: false, status: "durability-mismatch", message: "Durability read-back did not remain exactly 200 current and 200 maximum on every granted item row." };
    }
  } else if ((expectation?.applicable === false || !expectation?.applied) && (present > 0 || maximumPresent > 0)) {
    return { ok: false, status: "fabricated-durability", message: "A non-durable or unselected grant unexpectedly contains fabricated durability data." };
  }
  return { ok: true, status: "database-verified", message: expectation?.applied
    ? "Every granted item row retains exactly 200 current and 200 maximum durability."
    : (expectation?.applicable === false ? "Durability not applicable; no durability data was written." : "Durability was not requested for this eligible item; no durability data was written.") };
}

function buildDurabilityInvestigationSql(templateSqlLiteral) {
  return `
    with schema_evidence as (
      select coalesce(max(c.data_type), '') data_type,
             coalesce(max(c.udt_name), '') udt_name
      from information_schema.columns c
      where c.table_schema='dune' and c.table_name='items' and c.column_name='stats'
    ), composite_evidence as (
      select coalesce(max(format_type(a.atttypid,a.atttypmod)), '') stats_type
      from pg_type t
      join pg_class cls on cls.oid=t.typrelid
      join pg_namespace n on n.oid=cls.relnamespace
      join pg_attribute a on a.attrelid=cls.oid and a.attnum>0 and not a.attisdropped
      where n.nspname='dune' and t.typname='inventoryitem' and a.attname='stats'
    ), production_shapes as (
      select count(*) filter (where i.stats #> '${DURABILITY_SQL_PATH}' is not null)::text current_rows,
             count(*) filter (where jsonb_typeof(i.stats #> '${DURABILITY_SQL_PATH}')='number')::text numeric_rows,
             count(*) filter (where i.stats #> '${MAXIMUM_DURABILITY_SQL_PATH}' is not null)::text maximum_rows,
             count(*) filter (where jsonb_typeof(i.stats #> '${MAXIMUM_DURABILITY_SQL_PATH}')='number')::text maximum_numeric_rows,
             count(*) filter (where lower(i.template_id)=lower(${templateSqlLiteral}) and i.stats #> '${DURABILITY_SQL_PATH}' is not null)::text selected_current_rows,
             count(*) filter (where lower(i.template_id)=lower(${templateSqlLiteral}) and jsonb_typeof(i.stats #> '${DURABILITY_SQL_PATH}')='number')::text selected_numeric_rows,
             count(*) filter (where lower(i.template_id)=lower(${templateSqlLiteral}) and i.stats #> '${MAXIMUM_DURABILITY_SQL_PATH}' is not null)::text selected_maximum_rows,
             count(*) filter (where lower(i.template_id)=lower(${templateSqlLiteral}) and jsonb_typeof(i.stats #> '${MAXIMUM_DURABILITY_SQL_PATH}')='number')::text selected_maximum_numeric_rows
      from dune.items i
    )
    select s.data_type, s.udt_name, c.stats_type, p.current_rows, p.numeric_rows, p.maximum_rows, p.maximum_numeric_rows,
           p.selected_current_rows, p.selected_numeric_rows, p.selected_maximum_rows, p.selected_maximum_numeric_rows
    from schema_evidence s cross join composite_evidence c cross join production_shapes p
  `;
}

module.exports = {
  SET_DURABILITY_VALUE,
  DURABILITY_JSON_PATH,
  DURABILITY_SQL_PATH,
  MAXIMUM_DURABILITY_JSON_PATH,
  MAXIMUM_DURABILITY_SQL_PATH,
  durabilityEligibility,
  durabilityExpectation,
  itemStatsForGrant,
  itemStatsJsonForGrant,
  classifyDurabilityReadBack,
  buildDurabilityInvestigationSql,
  requestedDurability
};
