const REQUIRED_TABLES = [
  "building_blueprints",
  "building_blueprint_instances",
  "building_blueprint_placeables",
  "building_blueprint_pentashields",
  "items",
  "inventories",
  "player_state"
];

const STRUCTURAL_BUILDING_TYPES = new Set([
  "Atreides_Outpost_Column", "Atreides_Outpost_Column_Corner", "Atreides_Outpost_Foundation",
  "Atreides_Outpost_Foundation_Round_Corner", "Atreides_Outpost_Foundation_Wedge",
  "Atreides_Outpost_Pillar_Bottom", "Atreides_Outpost_Pillar_Middle", "Atreides_Outpost_Pillar_Top",
  "Choam_Level2_Column", "Choam_Level2_Foundation", "Choam_Level2_Pillar_Bottom",
  "Choam_Shelter_Column_Corner_New", "Choam_Shelter_Column_New", "Harkonnen_Outpost_Column",
  "Harkonnen_Outpost_Foundation", "MTX_Neut_DesertMechanic_Center_Column",
  "MTX_Neut_DesertMechanic_Corner_Column", "MTX_Neut_DesertMechanic_Foundation",
  "MTX_Neut_DesertMechanic_Foundation_Wedge", "MTX_Neut_Gunner_Foundation", "MTX_Smug_Foundation",
  "MTX_Smug_Foundation_Full", "MTX_Smug_Foundation_Half", "MTX_Smug_Foundation_Quarter",
  "MTX_Smug_Foundation_Round_Corner", "MTX_Smug_Foundation_Wedge", "MTX_Smug_Pillar_Bottom",
  "MTX_Smug_Pillar_Middle", "MTX_Smug_Pillar_Top", "MTX_Smug_Column", "MTX_Smug_Corner_Column",
  "Watershippers_Foundation", "Watershippers_Foundation_Round_Corner", "Watershippers_Pillar_Bottom",
  "Watershippers_Pillar_Middle", "Watershippers_Pillar_Top", "Atre_Foundation_Full",
  "Hark_Foundation_Full", "Choam_Foundation_Full"
]);

function sqlString(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

function parseJsonOutput(output, fallback = null) {
  const lines = String(output || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return fallback;
  try { return JSON.parse(lines[lines.length - 1]); }
  catch { throw new Error("The database returned an unreadable blueprint response."); }
}

function requireId(value, label = "Blueprint ID") {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) throw new Error(`${label} must be a positive whole number.`);
  const id = Number(text);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error(`${label} must be a positive whole number.`);
  return id;
}

function playerTargetCte(playerRef) {
  const ref = String(playerRef || "").trim();
  if (!ref) throw new Error("Choose a player first.");
  const value = sqlString(ref);
  return `target as (
    select ps.player_pawn_id::bigint as pawn_id,
           coalesce(ps.character_name, ps.account_id::text, ps.player_pawn_id::text) as character_name,
           coalesce(ps.online_status::text, 'unknown') as online_status
    from dune.player_state ps
    where ps.account_id::text = ${value}
       or ps.player_controller_id::text = ${value}
       or ps.player_pawn_id::text = ${value}
       or ps.player_state_id::text = ${value}
       or lower(coalesce(ps.character_name, '')) = lower(${value})
    order by case when lower(coalesce(ps.character_name, '')) = lower(${value}) then 0 else 1 end,
             ps.player_state_id
    limit 1
  )`;
}

function sanitizeBlueprintName(value, fallback = "Imported Blueprint") {
  const normalized = String(value || "").replace(/[_\.\\]/g, " ").trim().replace(/\s+/g, " ");
  return (normalized || fallback).slice(0, 160);
}

function importName(blueprint, fileName = "") {
  const fileFallback = String(fileName || "").replace(/\.json$/i, "");
  const raw = blueprint.name || blueprint.Name || blueprint.blueprint_name || fileFallback || blueprint.instances?.[0]?.building_type || "Imported Blueprint";
  return sanitizeBlueprintName(raw);
}

function requireArrayField(blueprint, field) {
  if (blueprint[field] === undefined || blueprint[field] === null) return [];
  if (!Array.isArray(blueprint[field])) throw new Error(`Blueprint ${field} must be an array.`);
  return blueprint[field];
}

function finiteNumber(value, label, fallback) {
  if ((value === undefined || value === null || value === "") && fallback !== undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > 1e9) throw new Error(`${label} must be a finite number.`);
  return number;
}

function buildingType(value, label) {
  const type = String(value || "").trim();
  if (!type || type.length > 512 || /[\x00-\x1f\x7f]/.test(type)) throw new Error(`${label} has an invalid building_type.`);
  return type;
}

function resolveIds(rows, key, label) {
  const sourceIds = rows.map((row) => {
    if (row[key] === undefined || row[key] === null || row[key] === "") return null;
    const id = Number(row[key]);
    if (!Number.isInteger(id) || id < 0 || id > 2147483646) throw new Error(`${label} ID must be a non-negative whole number.`);
    return id;
  });
  const offset = sourceIds.includes(0) ? 1 : 0;
  const reserved = new Set();
  const sourceToId = new Map();
  for (const sourceId of sourceIds) {
    if (sourceId === null) continue;
    const resolved = sourceId + offset;
    if (reserved.has(resolved)) throw new Error(`Blueprint contains duplicate ${label} ID ${sourceId}.`);
    reserved.add(resolved);
    sourceToId.set(sourceId, resolved);
  }
  let nextId = 1;
  const ids = sourceIds.map((sourceId) => {
    if (sourceId !== null) return sourceId + offset;
    while (reserved.has(nextId)) nextId += 1;
    const resolved = nextId++;
    reserved.add(resolved);
    return resolved;
  });
  return { ids, sourceToId };
}

function normalizeBlueprint(blueprint, fileName = "") {
  if (!blueprint || typeof blueprint !== "object" || Array.isArray(blueprint)) throw new Error("Blueprint JSON must contain an object.");
  const instances = requireArrayField(blueprint, "instances");
  const placeables = requireArrayField(blueprint, "placeables");
  const pentashields = requireArrayField(blueprint, "pentashields");
  if (!instances.length && !placeables.length && !pentashields.length) throw new Error("Blueprint has no instances, placeables, or pentashields.");
  if (instances.length + placeables.length + pentashields.length > 25000) throw new Error("Blueprint contains more than 25,000 records.");

  const instanceIds = resolveIds(instances, "instance_id", "instance");
  const normalizedInstances = instances.map((row, index) => {
    const type = buildingType(row?.building_type, `Instance ${index + 1}`);
    return {
      id: instanceIds.ids[index], type,
      x: finiteNumber(row.x, `Instance ${index + 1} x`), y: finiteNumber(row.y, `Instance ${index + 1} y`),
      z: finiteNumber(row.z, `Instance ${index + 1} z`), rotation: finiteNumber(row.rotation, `Instance ${index + 1} rotation`, 0),
      stability: row.provides_stability == null ? STRUCTURAL_BUILDING_TYPES.has(type) : Boolean(row.provides_stability)
    };
  });
  const placeableIds = resolveIds(placeables, "placeable_id", "placeable");
  const normalizedPlaceables = placeables.map((row, index) => ({
    id: placeableIds.ids[index], type: buildingType(row?.building_type, `Placeable ${index + 1}`),
    x: finiteNumber(row.x, `Placeable ${index + 1} x`), y: finiteNumber(row.y, `Placeable ${index + 1} y`),
    z: finiteNumber(row.z, `Placeable ${index + 1} z`), rx: finiteNumber(row.rx, `Placeable ${index + 1} rx`, 0),
    ry: finiteNumber(row.ry, `Placeable ${index + 1} ry`, 0), rz: finiteNumber(row.rz, `Placeable ${index + 1} rz`, 0)
  }));
  const normalizedPentashields = pentashields.map((row, index) => {
    if (!Array.isArray(row?.scale) || row.scale.length < 3) throw new Error(`Pentashield ${index + 1} must have a three-value scale array.`);
    const sourceId = Number(row.placeable_id);
    if (!Number.isInteger(sourceId) || sourceId < 0) throw new Error(`Pentashield ${index + 1} has an invalid placeable_id.`);
    const scale = row.scale.slice(0, 3).map((value, scaleIndex) => {
      const number = finiteNumber(value, `Pentashield ${index + 1} scale ${scaleIndex + 1}`);
      if (!Number.isInteger(number) || number < -32768 || number > 32767) throw new Error(`Pentashield ${index + 1} scale values must fit a small integer.`);
      return number;
    });
    return { placeableId: placeableIds.sourceToId.get(sourceId) ?? sourceId, scale };
  });
  return { name: importName(blueprint, fileName), instances: normalizedInstances, placeables: normalizedPlaceables, pentashields: normalizedPentashields };
}

function createBlueprintService({ query, audit = () => {} }) {
  if (typeof query !== "function") throw new Error("Blueprint service requires a database query function.");

  async function capabilities() {
    const tableList = REQUIRED_TABLES.map(sqlString).join(",");
    const output = await query(`
      with required(name) as (values ${REQUIRED_TABLES.map((name) => `(${sqlString(name)})`).join(",")}),
      present as (
        select required.name, to_regclass('dune.' || required.name) is not null as available from required
      )
      select json_build_object(
        'supported', bool_and(available),
        'missing', coalesce(json_agg(name order by name) filter (where not available), '[]'::json)
      )::text from present`, 15000);
    const result = parseJsonOutput(output, { supported: false, missing: REQUIRED_TABLES });
    result.required = tableList ? REQUIRED_TABLES : [];
    return result;
  }

  async function list(playerRef = "") {
    const ref = String(playerRef || "").trim();
    const target = ref ? `with ${playerTargetCte(ref)}` : "";
    const where = ref ? "where coalesce(bb.player_id, inv.actor_id) = (select pawn_id from target limit 1)" : "";
    const output = await query(`
      ${target}
      select coalesce(json_agg(row_to_json(result) order by result.id desc), '[]'::json)::text
      from (
        select bb.id::int as id,
               coalesce(bb.player_id, inv.actor_id)::text as owner_id,
               coalesce(ps.character_name, '') as owner_name,
               coalesce(bb.item_id, 0)::bigint as item_id,
               (select count(*)::int from dune.building_blueprint_instances bi where bi.building_blueprint_id = bb.id) as pieces,
               (select count(*)::int from dune.building_blueprint_placeables bp where bp.building_blueprint_id = bb.id) as placeables,
               coalesce(i.stats->'FBuildingBlueprintItemStats'->1->>'BuildingBlueprintName', '') as name
        from dune.building_blueprints bb
        left join dune.items i on i.id = bb.item_id
        left join dune.inventories inv on inv.id = i.inventory_id
        left join dune.player_state ps on ps.player_pawn_id = coalesce(bb.player_id, inv.actor_id)
        ${where}
      ) result`, 30000);
    return parseJsonOutput(output, []);
  }

  async function existingNames(playerRef) {
    const output = await query(`
      with ${playerTargetCte(playerRef)}
      select coalesce(json_agg(name), '[]'::json)::text from (
        select coalesce(i.stats->'FBuildingBlueprintItemStats'->1->>'BuildingBlueprintName', '') as name
        from dune.building_blueprints bb
        join dune.items i on i.id = bb.item_id
        left join dune.inventories inv on inv.id = i.inventory_id
        where coalesce(bb.player_id, inv.actor_id) = (select pawn_id from target limit 1)
      ) names`, 15000);
    return parseJsonOutput(output, []);
  }

  async function importBlueprint(playerRef, input, fileName = "") {
    const blueprint = normalizeBlueprint(input, fileName);
    const names = new Set((await existingNames(playerRef)).map((name) => String(name).toLowerCase()));
    const baseName = blueprint.name.replace(/\s*\(\d+\)\s*$/, "").trim() || "Imported Blueprint";
    let name = baseName;
    let suffix = 1;
    while (names.has(name.toLowerCase())) name = `${baseName} (${++suffix})`;

    // Native Solido copies are owned through their inventory item. The linked
    // blueprint row keeps player_id NULL, and its item stats must not include
    // PlayerBaseBackupId (that field describes a different in-game payload).

    const instanceSql = blueprint.instances.length ? `inserted_instances as (
      insert into dune.building_blueprint_instances
        (building_blueprint_id, instance_id, building_type, transform, hologram, provides_stability, health)
      select bp.id, v.instance_id, v.building_type, v.transform, true, v.stability, 0
      from inserted_blueprint bp
      cross join (values ${blueprint.instances.map((row) => `(${row.id},${sqlString(row.type)},${sqlString(`[0:3]={${row.x},${row.y},${row.z},${row.rotation}}`)}::real[],${row.stability ? "true" : "false"})`).join(",")})
        v(instance_id, building_type, transform, stability)
      returning 1
    )` : "inserted_instances as (select 1 as marker where false)";
    const placeableSql = blueprint.placeables.length ? `inserted_placeables as (
      insert into dune.building_blueprint_placeables
        (building_blueprint_id, placeable_id, building_type, transform, hologram)
      select bp.id, v.placeable_id, v.building_type, v.transform, true
      from inserted_blueprint bp
      cross join (values ${blueprint.placeables.map((row) => `(${row.id},${sqlString(row.type)},${sqlString(`[0:5]={${row.x},${row.y},${row.z},${row.rx},${row.ry},${row.rz}}`)}::real[])`).join(",")})
        v(placeable_id, building_type, transform)
      returning 1
    )` : "inserted_placeables as (select 1 as marker where false)";
    const pentashieldSql = blueprint.pentashields.length ? `inserted_pentashields as (
      insert into dune.building_blueprint_pentashields (building_blueprint_id, placeable_id, scale)
      select bp.id, v.placeable_id, v.scale
      from inserted_blueprint bp
      cross join (values ${blueprint.pentashields.map((row) => `(${row.placeableId},${sqlString(`[0:2]={${row.scale.join(",")}}`)}::smallint[])`).join(",")})
        v(placeable_id, scale)
      returning 1
    )` : "inserted_pentashields as (select 1 as marker where false)";
    const output = await query(`
      with ${playerTargetCte(playerRef)},
      inventory as materialized (
        select inv.id, coalesce(inv.max_item_count, 40)::int as max_item_count
        from dune.inventories inv
        where inv.actor_id = (select pawn_id from target limit 1) and inv.inventory_type = 0
        order by inv.id limit 1 for update
      ),
      inventory_usage as (
        select count(*)::int as used_slots, coalesce(max(position_index), -1) + 1 as next_position
        from dune.items where inventory_id = (select id from inventory limit 1)
      ),
      inserted_item as (
        insert into dune.items (inventory_id, stack_size, position_index, template_id, quality_level, stats)
        select inventory.id, 1, inventory_usage.next_position, 'BuildingBlueprint_CopyDevice', 0,
          jsonb_build_object(
            'FCustomizationStats', jsonb_build_array('[]'::jsonb, '{}'::jsonb),
            'FBuildingBlueprintItemStats', jsonb_build_array('[]'::jsonb, jsonb_build_object('PlayerBlueprintId', '!!bbp#0')),
            'FItemStackAndDurabilityStats', jsonb_build_array('[]'::jsonb, jsonb_build_object('DecayedMaxDurability', 0.0))
          )
        from inventory, inventory_usage
        where inventory.max_item_count <= 0 or inventory_usage.used_slots < inventory.max_item_count
        returning id, inventory_id
      ),
      inserted_blueprint as (
        insert into dune.building_blueprints (item_id, player_id, building_blueprint_map)
        select inserted_item.id, null::bigint, '' from inserted_item
        returning id, item_id
      ),
      updated_item as (
        update dune.items i set stats = jsonb_build_object(
          'FCustomizationStats', jsonb_build_array('[]'::jsonb, '{}'::jsonb),
          'FBuildingBlueprintItemStats', jsonb_build_array('[]'::jsonb, jsonb_build_object('PlayerBlueprintId', '!!bbp#' || bp.id::text, 'BuildingBlueprintName', ${sqlString(name)})),
          'FItemStackAndDurabilityStats', jsonb_build_array('[]'::jsonb, jsonb_build_object('DecayedMaxDurability', 0.0))
        ) from inserted_blueprint bp where i.id = bp.item_id returning i.id
      ),
      ${instanceSql},
      ${placeableSql},
      ${pentashieldSql}
      select json_build_object(
        'status', case
          when not exists(select 1 from target) then 'player_not_found'
          when not exists(select 1 from inventory) then 'inventory_not_found'
          when not exists(select 1 from inserted_item) then 'inventory_full'
          else 'inserted' end,
        'blueprintId', coalesce((select id from inserted_blueprint limit 1), 0),
        'itemId', coalesce((select item_id from inserted_blueprint limit 1), 0),
        'playerName', coalesce((select character_name from target limit 1), ''),
        'online', lower(coalesce((select online_status from target limit 1), '')) = 'online',
        'pieces', (select count(*) from inserted_instances),
        'placeables', (select count(*) from inserted_placeables),
        'pentashields', (select count(*) from inserted_pentashields)
      )::text`, 120000);
    const result = parseJsonOutput(output, {});
    if (result.status === "player_not_found") throw new Error(`Player was not found: ${playerRef}`);
    if (result.status === "inventory_not_found") throw new Error("The selected player does not have a backpack inventory.");
    if (result.status === "inventory_full") throw new Error("The selected player's backpack is full.");
    if (result.status !== "inserted") throw new Error(`Blueprint import failed: ${result.status || "unknown status"}.`);
    const response = { ok: true, ...result, blueprintName: name, warning: result.online ? "The player must relog before the blueprint appears in-game." : "" };
    audit("blueprints.import", { playerRef: String(playerRef), fileName: String(fileName || ""), ...response });
    return response;
  }

  async function exportBlueprint(idValue) {
    const id = requireId(idValue);
    const output = await query(`
      select coalesce((
        select json_build_object(
          'name', coalesce(i.stats->'FBuildingBlueprintItemStats'->1->>'BuildingBlueprintName', ''),
          'instances', coalesce((select json_agg(json_build_object(
            'instance_id', bi.instance_id, 'building_type', bi.building_type,
            'x', coalesce(bi.transform[array_lower(bi.transform,1)],0),
            'y', coalesce(bi.transform[array_lower(bi.transform,1)+1],0),
            'z', coalesce(bi.transform[array_lower(bi.transform,1)+2],0),
            'rotation', coalesce(bi.transform[array_lower(bi.transform,1)+3],0), 'provides_stability', bi.provides_stability
          ) order by bi.instance_id) from dune.building_blueprint_instances bi where bi.building_blueprint_id = bb.id), '[]'::json),
          'placeables', coalesce((select json_agg(json_build_object(
            'placeable_id', bp.placeable_id, 'building_type', bp.building_type,
            'x', coalesce(bp.transform[array_lower(bp.transform,1)],0),
            'y', coalesce(bp.transform[array_lower(bp.transform,1)+1],0),
            'z', coalesce(bp.transform[array_lower(bp.transform,1)+2],0),
            'rx', coalesce(bp.transform[array_lower(bp.transform,1)+3],0),
            'ry', coalesce(bp.transform[array_lower(bp.transform,1)+4],0),
            'rz', coalesce(bp.transform[array_lower(bp.transform,1)+5],0)
          ) order by bp.placeable_id) from dune.building_blueprint_placeables bp where bp.building_blueprint_id = bb.id), '[]'::json),
          'pentashields', coalesce((select json_agg(json_build_object(
            'placeable_id', ps.placeable_id, 'scale', ps.scale
          ) order by ps.placeable_id) from dune.building_blueprint_pentashields ps where ps.building_blueprint_id = bb.id), '[]'::json)
        )
        from dune.building_blueprints bb left join dune.items i on i.id = bb.item_id where bb.id = ${id}
      ), 'null'::json)::text`, 30000);
    const result = parseJsonOutput(output, null);
    if (!result) throw new Error("Blueprint not found.");
    return result;
  }

  async function deleteBlueprint(idValue) {
    const id = requireId(idValue);
    const output = await query(`
      with target as (select item_id from dune.building_blueprints where id = ${id}),
      deleted_pentashields as (delete from dune.building_blueprint_pentashields where building_blueprint_id = ${id} returning 1),
      deleted_placeables as (delete from dune.building_blueprint_placeables where building_blueprint_id = ${id} and (select count(*) from deleted_pentashields) >= 0 returning 1),
      deleted_instances as (delete from dune.building_blueprint_instances where building_blueprint_id = ${id} and (select count(*) from deleted_placeables) >= 0 returning 1),
      deleted_blueprint as (delete from dune.building_blueprints where id = ${id} and (select count(*) from deleted_instances) >= 0 returning item_id),
      deleted_item as (delete from dune.items where id = (select item_id from deleted_blueprint limit 1) returning 1)
      select json_build_object(
        'ok', exists(select 1 from deleted_blueprint),
        'pieces', (select count(*) from deleted_instances),
        'placeables', (select count(*) from deleted_placeables),
        'pentashields', (select count(*) from deleted_pentashields),
        'itemDeleted', exists(select 1 from deleted_item)
      )::text`, 30000);
    const result = parseJsonOutput(output, { ok: false });
    if (result.ok) audit("blueprints.delete", { blueprintId: id, ...result });
    return result;
  }

  return { capabilities, list, importBlueprint, exportBlueprint, deleteBlueprint };
}

module.exports = {
  REQUIRED_TABLES,
  createBlueprintService,
  importName,
  normalizeBlueprint,
  parseJsonOutput,
  requireId,
  sanitizeBlueprintName
};
