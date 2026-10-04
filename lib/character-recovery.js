"use strict";

const crypto = require("crypto");
const CHARACTER_CLASS = "/Game/Dune/Characters/Player/BP_DunePlayerCharacter.BP_DunePlayerCharacter_C";
const SUCCESS = "Character recovered successfully. The player can now attempt to log in.";
const fingerprint = (body) => crypto.createHash("sha256").update(String(body).trim().replace(/\s+/g, " ")).digest("hex");
// Inspected vendor definitions, not installation-specific destination constants.
const ROUTINES = {
  admin_move_offline_player_to_partition: new Set(["3d82385838b12d34b010ac7dd54520192247dd7ad5059e2e6d417ce4c56031b0"]),
  is_player_offline: new Set(["25a1a4a1ef815f7895ca2847e20b902439c006c86eeabc010c6bc709d24bd5c7"]),
  upgrade_map_name: new Set(["47fe2ad16d2e331e1b3e1f290bf2dfa87fc3ee56e502e2a7d051110a5debe34c", "7877c05d754b0fc51a44893f823412e59bab2e0d3214344e13f99d77e45ea7ce"]),
  decrypt_user_data: new Set(["aa886cc61ca401494957ee33e4de72ae0bdd208cc69e2803dcedfbd7ff281493"])
};
const SCHEMA_SQL = `
 select p.proname, p.prosrc, p.prokind::text, p.prosecdef,
   p.proconfig, l.lanname, p.pronargs,
   case when p.proname = 'admin_move_offline_player_to_partition' then
     p.oid = to_regprocedure('dune.admin_move_offline_player_to_partition(text,bigint,dune.vector)')
     and p.prorettype = 'void'::regtype else true end as signature_ok
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 join pg_language l on l.oid=p.prolang
 where n.nspname='dune' and p.proname=any($1::text[])`;
// Verified against the affected installation: login loads Travel pawns through this loader.
const TRAVEL_LOADER_HASH = "19dd68e6a5baf8b766951589cb687db9c525ce9d0ce0cc43dd4915a04b2cfa74";
const TRAVEL_LOADER_SQL = `select p.prosrc, p.prokind::text, p.prosecdef, p.proconfig,
 p.oid=to_regprocedure('dune.load_full_actors(bigint[])')
 and p.prorettype='dune.actordescription'::regtype and p.proretset as signature_ok
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='dune' and p.proname='load_full_actors'`;
const STORAGE_SQL = `
 select c.relkind::text, c.relrowsecurity, c.relforcerowsecurity,
   exists(select 1 from pg_attribute a where a.attrelid=c.oid
     and a.attname='state' and not a.attisdropped) as has_state,
   exists(select 1 from pg_trigger t where t.tgrelid=c.oid and not t.tgisinternal) as has_triggers,
   exists(select 1 from pg_rewrite r where r.ev_class=c.oid) as has_rules
 from pg_class c where c.oid=to_regclass('dune.actors')`;
const PAWN_SQL = `
 select ps.id::text as row_id, ps.account_id::text as account_id,
   ps.player_pawn_id::text as pawn_id, ps.player_controller_id::text as controller_id,
   ps.player_state_id::text as state_id, ps.character_name, ps.online_status::text,
   ps.home_dimension_index, ps.return_dimension_index,
   ac."user" as fls_id, dune.is_player_offline(ac."user") as database_offline,
   (select count(*)::int from dune.accounts x where x."user"=ac."user") as fls_accounts,
   (select count(*)::int from dune.player_state x where x.player_pawn_id=ps.player_pawn_id) as pawn_links,
   a.id::text as actor_id, a.owner_account_id::text as owner_account_id,
   a.class, a.state::text, a.map, a.partition_id::text, a.dimension_index,
   ((a.transform).location).x as x, ((a.transform).location).y as y,
   ((a.transform).location).z as z,
   to_jsonb((a.transform).rotation)::text as rotation,
   to_jsonb(a)::text as pawn_snapshot,
   (to_jsonb(a)-array['map','partition_id','dimension_index','transform'])::text as protected_pawn
 from dune.player_state ps join dune.accounts ac on ac.id=ps.account_id
 left join dune.actors a on a.id=ps.player_pawn_id
 where ps.account_id=$1::bigint order by ps.id`;
const LINKS_SQL = `
 select jsonb_build_object(
   'account',(select to_jsonb(x) from dune.encrypted_accounts x where x.id=$1::bigint),
   'character',(select to_jsonb(x) from dune.encrypted_player_state x where x.id=$2::bigint),
   'controller',(select to_jsonb(x) from dune.actors x where x.id=$3::bigint),
   'player_state',(select to_jsonb(x) from dune.actors x where x.id=$4::bigint),
   'inventories',(select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]') from dune.inventories x where x.actor_id=$5::bigint),
   'items',(select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]') from dune.items x join dune.inventories i on i.id=x.inventory_id where i.actor_id=$5::bigint),
   'login_travel',(select to_jsonb(x) from dune.player_travel_state x where x.fls_id=$6),
   'travel_return',(select to_jsonb(x) from dune.travel_return_info x where x.player_controller_id=$3::bigint),
   'travel_parents',(select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]') from dune.travel_actor_parent x where x.id=any($7::bigint[]) or x.parent_id=any($7::bigint[])),
   'travel_actors',(select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]') from dune.actors x where x.id<>$5::bigint and x.id in (select t.parent_id from dune.travel_actor_parent t where t.id=any($7::bigint[]) union select t.id from dune.travel_actor_parent t where t.parent_id=any($7::bigint[]))),
   'transfer_import',(select to_jsonb(x) from dune.character_transfer_imports x where x.fls_id=$6)
 )::text as protected_links,
 exists(select 1 from dune.actors x where x.id=any($7::bigint[])
   and ((x.id<>$5::bigint and x.state::text<>'Default')
     or (x.id=$5::bigint and x.state::text not in ('Default','Travel'))))
 or exists(select 1 from dune.travel_actor_parent x where x.id=any($7::bigint[]) or x.parent_id=any($7::bigint[]))
 or exists(select 1 from dune.character_transfer_imports x where x.fls_id=$6) as transfer_blocked,
 exists(select 1 from dune.actors x where x.id=any($7::bigint[])
   and ((x.id<>$5::bigint and x.state::text<>'Default') or (x.id=$5::bigint and x.state::text not in ('Default','Travel'))))
 or exists(select 1 from dune.character_transfer_imports x where x.fls_id=$6) as non_parent_blocked,
 (select login_target_dimension_index from dune.player_travel_state where fls_id=$6) as login_dimension`;
const DESTINATION_SQL = `
 select a.id::text as source_actor_id, a.partition_id::text as partition_id,
   a.dimension_index, to_jsonb(wp)::text as partition_snapshot,
   ((a.transform).location).x as x, ((a.transform).location).y as y,
   ((a.transform).location).z as z
 from dune.actors a join dune.player_state ps on ps.player_pawn_id=a.id
 join dune.world_partition wp on wp.partition_id=a.partition_id
 where a.id=$1::bigint and a.class=$2 and a.state::text='Default'
   and a.owner_account_id=ps.account_id and a.map='HaggaBasin'
   and wp.map in ('Survival_1','HaggaBasin') and dune.upgrade_map_name(wp.map)='HaggaBasin'
   and wp.blocked=false and wp.dimension_index=a.dimension_index
   and (select count(*) from dune.player_state x where x.account_id=ps.account_id)=1
   and (select count(*) from dune.player_state x where x.player_pawn_id=a.id)=1`;
const MANUAL_PARTITION_SQL = `select wp.partition_id::text, wp.dimension_index,
 to_jsonb(wp)::text as partition_snapshot from dune.world_partition wp
 where wp.dimension_index=$1::integer and wp.blocked=false
 and wp.map in ('Survival_1','HaggaBasin') and dune.upgrade_map_name(wp.map)='HaggaBasin'`;
const LOCK_SQL = `LOCK TABLE dune.actors, dune.character_transfer_imports,
 dune.encrypted_accounts, dune.encrypted_player_state, dune.inventories, dune.items,
 dune.player_travel_state, dune.travel_actor_parent, dune.travel_return_info,
 dune.world_partition IN SHARE ROW EXCLUSIVE MODE`;
const DIAGNOSTIC_SQL = `
 select jsonb_build_object(
   'characterRowId',ps.id::text,'accountId',ps.account_id::text,
   'playerName',ps.character_name,'onlineStatus',ps.online_status::text,
   'pawnId',ps.player_pawn_id::text,'controllerId',ps.player_controller_id::text,
   'playerStateId',ps.player_state_id::text,
   'homeDimensionIndex',ps.home_dimension_index,'returnDimensionIndex',ps.return_dimension_index,
   'actors',(select coalesce(jsonb_agg(jsonb_build_object(
     'id',a.id::text,'class',a.class,'ownerAccountId',a.owner_account_id::text,
     'state',a.state::text,'map',a.map,'partitionId',a.partition_id::text,
     'dimensionIndex',a.dimension_index,'transform',to_jsonb(a.transform),'serial',a.serial::text
   ) order by a.id),'[]'::jsonb) from dune.actors a
     where a.id=any(array[ps.player_pawn_id,ps.player_controller_id,ps.player_state_id])),
   'loginTargetDimensionIndex',(select login_target_dimension_index from dune.player_travel_state where fls_id=ac."user"),
   'travelReturn',(select to_jsonb(t) from dune.travel_return_info t where t.player_controller_id=ps.player_controller_id),
   'travelParents',(select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]'::jsonb)
     from dune.travel_actor_parent t where t.id=any(array[ps.player_pawn_id,ps.player_controller_id,ps.player_state_id])
       or t.parent_id=any(array[ps.player_pawn_id,ps.player_controller_id,ps.player_state_id])),
   'transferImport',(select jsonb_build_object('state',t.transfer_state::text,'lastUpdate',t.last_update)
     from dune.character_transfer_imports t where t.fls_id=ac."user")
 ) as evidence
 from dune.player_state ps join dune.accounts ac on ac.id=ps.account_id
 where ps.account_id=$1::bigint order by ps.id`;
const DIAGNOSTIC_ROUTINES_SQL = `select p.oid::regprocedure::text as signature,
 pg_catalog.pg_get_functiondef(p.oid) as definition from pg_catalog.pg_proc p
 join pg_catalog.pg_namespace n on n.oid=p.pronamespace
 where n.nspname='dune' and p.prokind='f'
 and p.proname in ('admin_move_offline_player_to_partition','load_actors','is_player_offline',
 'login_account','get_player_pawn','load_full_actors','get_actor_server_info','save_actors',
 'delete_actor_states_travel','get_traveling_non_player_actor_ids','get_traveling_actor_ids',
 'get_traveling_actor_id_and_types','update_traveling_actor_tree','update_traveling_actor_dependencies')
 order by p.oid::regprocedure::text`;

function dbId(value) {
  const id = String(value || "");
  if (!/^[1-9]\d*$/.test(id) || BigInt(id) > 9223372036854775807n) throw new Error("Invalid selected player identity.");
  return id;
}
function validatePawn(rows, accountId) {
  if (rows.length !== 1) throw new Error("Exactly one authoritative player pawn is required; the pawn is missing or ambiguous.");
  const p = rows[0];
  if (p.account_id !== accountId || !p.actor_id || p.actor_id !== p.pawn_id || !p.fls_id || p.fls_accounts !== 1 || p.pawn_links !== 1) throw new Error("Player account, original FLS identifier or pawn linkage is missing or ambiguous.");
  for (const id of [p.row_id, p.pawn_id, p.controller_id, p.state_id]) dbId(id);
  if (new Set([p.pawn_id, p.controller_id, p.state_id]).size !== 3) throw new Error(`Recovery blocked: pawn ${p.pawn_id}, PlayerController ${p.controller_id} and PlayerState ${p.state_id} must identify three distinct actors.`);
  if (p.class !== CHARACTER_CLASS) throw new Error(`Recovery blocked: pawn ${p.pawn_id} has unsupported character class ${JSON.stringify(p.class)}. Expected ${JSON.stringify(CHARACTER_CLASS)}.`);
  if (p.owner_account_id !== accountId) throw new Error(`Recovery blocked: pawn ${p.pawn_id} belongs to account ${p.owner_account_id ?? "unknown"}; the selected account is ${accountId}. Ownership will not be reassigned.`);
  if (!["Default","Travel"].includes(p.state)) throw new Error(`Recovery blocked: pawn ${p.pawn_id} has unsupported actor state ${JSON.stringify(p.state)}. Only Default or isolated Travel pawns can be relocated; actor state will not be changed.`);
  if (p.online_status !== "Offline" || p.database_offline !== true) throw new Error("The selected player must be offline.");
  if (![p.x,p.y,p.z].every((n) => typeof n === "number" && Number.isFinite(n)) || !p.rotation || !p.protected_pawn) throw new Error("The pawn before-state is incomplete.");
  return p;
}
function sameBefore(a, b) {
  return a.pawn_snapshot === b.pawn_snapshot && a.protected_links === b.protected_links && a.row_id === b.row_id && a.fls_id === b.fls_id;
}
function verifyAfter(before, after, destination) {
  if (before.account_id !== after.account_id || before.row_id !== after.row_id || before.pawn_id !== after.pawn_id || before.fls_id !== after.fls_id || before.owner_account_id !== after.owner_account_id || before.state !== after.state || before.rotation !== after.rotation || before.protected_pawn !== after.protected_pawn || before.protected_links !== after.protected_links) throw new Error("Recovery verification failed: identity, rotation or protected character data changed.");
  if (after.map !== "HaggaBasin" || after.partition_id !== destination.partitionId || after.dimension_index !== destination.dimensionIndex || ["x","y","z"].some((k) => after[k] !== destination.location[k])) throw new Error("Recovery verification failed: map, partition, dimension or location did not match.");
}

function createCharacterRecovery(deps) {
  const previews = new Map();
  let busy = false;
  const query = (client, name, text, values = []) => client.query({ name, text, values });
  async function schema(client, context) {
    const identity = await query(client, "recovery-database", "select pg_catalog.current_database() as database, (pg_catalog.pg_control_system()).system_identifier::text as database_id");
    if (identity.rows[0]?.database !== "dune" || identity.rows[0]?.database_id !== context.databaseId) throw new Error("The recovery connection does not match the safety-backup database.");
    const routines = (await query(client, "recovery-schema", SCHEMA_SQL, [Object.keys(ROUTINES)])).rows;
    for (const [name, allowed] of Object.entries(ROUTINES)) {
      const matches = routines.filter((r) => r.proname === name);
      if (matches.length !== 1 || matches[0].prokind !== "f" || matches[0].prosecdef || matches[0].proconfig || !matches[0].signature_ok || !allowed.has(fingerprint(matches[0].prosrc))) throw new Error("The database recovery function or dependency is unsupported or changed: " + name);
    }
    const storage = (await query(client, "recovery-storage", STORAGE_SQL)).rows;
    if (storage.length !== 1 || storage[0].relkind !== "r" || !storage[0].has_state || storage[0].relrowsecurity || storage[0].relforcerowsecurity || storage[0].has_triggers || storage[0].has_rules) throw new Error("The actor storage layout has unsupported recovery side effects.");
  }
  async function snapshot(client, accountId, override = null) {
    const p = validatePawn((await query(client, "recovery-pawn", PAWN_SQL, [accountId])).rows, accountId);
    if (p.state === "Travel") {
      const loaders=(await query(client,"recovery-travel-loader",TRAVEL_LOADER_SQL)).rows;
      const loader=loaders[0];
      if (loaders.length!==1 || loader.prokind!=="f" || loader.prosecdef || loader.proconfig || !loader.signature_ok || fingerprint(loader.prosrc)!==TRAVEL_LOADER_HASH) throw new Error("Travel pawn recovery is unsupported: the installed full actor loader is missing, ambiguous or changed.");
    }
    const ids = [p.pawn_id,p.controller_id,p.state_id];
    const linked = (await query(client, "recovery-links", LINKS_SQL, [accountId,p.row_id,p.controller_id,p.state_id,p.pawn_id,p.fls_id,ids])).rows[0];
    if (!linked?.protected_links) throw new Error("Travel, migration or protected character linkage is ambiguous.");
    const links = JSON.parse(linked.protected_links);
    const forceParents = override?.forceTravelParents === true && linked.non_parent_blocked === false && Array.isArray(links.travel_parents) && links.travel_parents.length > 0;
    if (linked.transfer_blocked && !forceParents) throw new Error("Travel, migration or protected character linkage is ambiguous.");
    if (!links.account || !links.character || !links.controller || !links.player_state) throw new Error("Required account, PlayerController or PlayerState records are missing.");
    return { ...p, ...linked };
  }
  async function destination(client, pawn, override = null) {
    if (override) {
      const dimensions=[pawn.login_dimension,pawn.home_dimension_index,pawn.return_dimension_index].filter(x=>x!=null);
      if (!dimensions.length || dimensions.some(x=>!Number.isInteger(x)||x<0||x!==dimensions[0])) throw new Error("Manual recovery requires one unambiguous compatible character dimension.");
      const rows=(await query(client,"recovery-manual-partition",MANUAL_PARTITION_SQL,[dimensions[0]])).rows;
      if(rows.length!==1 || !Number.isInteger(rows[0].dimension_index) || rows[0].dimension_index!==dimensions[0]) throw new Error("Manual recovery requires exactly one valid Hagga Basin partition in the character's dimension.");
      return {map:"HaggaBasin",partitionId:dbId(rows[0].partition_id),dimensionIndex:rows[0].dimension_index,location:{...override.location},partitionSnapshot:rows[0].partition_snapshot,source:"administrator-coordinates",verifiedSafe:false,forceTravelParents:override.forceTravelParents===true};
    }
    const candidates = await deps.getVerifiedPresets();
    const valid = [];
    for (const preset of candidates) {
      if (preset.enabled === false || preset.verified !== true || preset.map !== "HaggaBasin" || preset.source !== "online-player-position" || !preset.auditVerified || !/^[1-9]\d*$/.test(String(preset.source_actor_id || "")) || !Number.isFinite(Date.parse(preset.created_at)) || ![preset.x,preset.y,preset.z].every((n) => typeof n === "number" && Number.isFinite(n)) || !deps.withinBounds(preset, "HaggaBasin")) continue;
      const rows = (await query(client, "recovery-destination", DESTINATION_SQL, [preset.source_actor_id, CHARACTER_CLASS])).rows;
      if (rows.length !== 1) continue;
      const r = rows[0];
      if (String(preset.partition_id) !== r.partition_id || !Number.isInteger(r.dimension_index) || ["x","y","z"].some((k) => r[k] !== preset[k]) || [pawn.login_dimension,pawn.home_dimension_index,pawn.return_dimension_index].some((dimension) => dimension != null && dimension !== r.dimension_index)) continue;
      valid.push({ map:"HaggaBasin",partitionId:r.partition_id,dimensionIndex:r.dimension_index,location:{x:r.x,y:r.y,z:r.z},sourceActorId:r.source_actor_id,partitionSnapshot:r.partition_snapshot,presetName:preset.name,createdAt:preset.created_at });
    }
    // Stable documented preference among corroborated safe locations, never an
    // arbitrary partition/player fallback. Client supplies no destination fields.
    valid.sort((a,b) => Date.parse(b.createdAt)-Date.parse(a.createdAt) || a.sourceActorId.localeCompare(b.sourceActorId) || a.presetName.localeCompare(b.presetName));
    if (!valid.length) throw new Error("A verified safe Hagga Basin destination could not be discovered. No character was changed.");
    return valid[0];
  }
  async function read(context, accountId, includeDestination = false, override = null) {
    const client = await deps.openClient(context);
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SET LOCAL search_path = pg_catalog, dune, public, pg_temp");
      await schema(client, context);
      const pawn = await snapshot(client, accountId, override);
      const dest = includeDestination ? await destination(client, pawn, override) : null;
      return { pawn, destination:dest };
    } finally {
      try { await client.query("ROLLBACK"); } finally { await client.end(); }
    }
  }
  async function inspect(accountValue, requestedOverride = null) {
    let override=null;
    if(requestedOverride!==null){
      if(requestedOverride.acceptUnverifiedHeight!==true || requestedOverride.map!=="HaggaBasin" || !["x","y","z"].every(k=>typeof requestedOverride.location?.[k]==="number"&&Number.isFinite(requestedOverride.location[k])) || !deps.withinBounds(requestedOverride.location,"HaggaBasin")) throw new Error("Explicitly acknowledge unverified height and supply finite in-bounds Hagga coordinates.");
      override={location:{x:requestedOverride.location.x,y:requestedOverride.location.y,z:requestedOverride.location.z},forceTravelParents:requestedOverride.forceTravelParents===true};
    }
    const accountId = dbId(accountValue);
    const context = await deps.getContext();
    const { pawn, destination:dest } = await read(context, accountId, true, override);
    const previous = await deps.loadJournal(accountId, context);
    if (previous && ["commit-attempted","committed","unverified"].includes(previous.status)) {
      try { verifyAfter(previous.before, pawn, previous.destination); }
      catch { if (!sameBefore(previous.before, pawn)) throw new Error("A previous recovery has an unverified outcome. Reconcile it before retrying."); }
      await deps.saveJournal(accountId, { ...previous, status:"reconciled", reconciledAt:new Date().toISOString() });
    }
    for (const [id,p] of previews) if (p.expiresAt < Date.now()) previews.delete(id);
    const previewId = crypto.randomBytes(16).toString("hex");
    previews.set(previewId, { accountId,context,before:pawn,destination:dest,override,expiresAt:Date.now()+10*60*1000 });
    return { ok:true,previewId,accountId,playerName:pawn.character_name,currentLocation:pawn.map,current:{map:pawn.map,partitionId:pawn.partition_id,dimensionIndex:pawn.dimension_index,x:pawn.x,y:pawn.y,z:pawn.z},destination:{forceTravelParents:override?.forceTravelParents===true,verifiedSafe:!override,source:override?"administrator-coordinates":"verified-preset",map:"HaggaBasin",partitionId:dest.partitionId,dimensionIndex:dest.dimensionIndex,...dest.location},playerOffline:true };
  }
  async function diagnostics(accountValue) {
    const accountId=dbId(accountValue);
    const context=await deps.getContext();
    const client=await deps.openClient(context);
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SET LOCAL search_path = pg_catalog, dune, public, pg_temp");
      await client.query("SET LOCAL statement_timeout = '20s'");
      await schema(client,context);
      const characters=(await query(client,"recovery-diagnostic",DIAGNOSTIC_SQL,[accountId])).rows.map(r=>r.evidence);
      const routines=(await query(client,"recovery-diagnostic-routines",DIAGNOSTIC_ROUTINES_SQL)).rows;
      return {ok:true,readOnly:true,accountId,collectedAt:new Date().toISOString(),characters,routines,
        message:"Read-only travel diagnostics collected. No character or database records were changed."};
    } finally {
      try {await client.query("ROLLBACK");} finally {await client.end();}
    }
  }
  async function recover(body = {}) {
    if (body.confirmed !== true) throw new Error("Confirm character recovery first.");
    const p = previews.get(String(body.previewId || ""));
    if (!p || p.expiresAt < Date.now()) throw new Error("Recovery preview expired. Select the player again.");
    if(p.override && body.acceptUnverifiedHeight!==true) throw new Error("Confirm the unverified landing height before manual recovery.");
    if(p.override?.forceTravelParents===true && body.forceTravelParents!==true) throw new Error("Confirm Force pawn teleport before recovery. Vehicle and travel links will remain unchanged.");
    if (busy) throw new Error("Another character recovery is in progress.");
    busy = true;
    previews.delete(body.previewId); // A confirmation is single-use, including failure.
    let client, before, journal, transaction = false, commitAttempted = false;
    try {
      const previous = await deps.loadJournal(p.accountId, p.context);
      if (previous && ["commit-attempted","committed","unverified"].includes(previous.status)) throw new Error("A previous recovery must be reconciled before retrying.");
      await deps.assertSafe(p.context);
      const refreshed = await read(p.context,p.accountId,true,p.override);
      if (!sameBefore(p.before,refreshed.pawn) || JSON.stringify(p.destination)!==JSON.stringify(refreshed.destination)) throw new Error("Player or destination changed after confirmation. No character was changed.");
      const backup = await deps.createBackup(p.context);
      if (backup?.ok !== true || backup.verified !== true) throw new Error(backup?.error || "A verified safety backup could not be created.");
      await deps.verifyBackup(backup);
      await deps.assertSafe(p.context);
      const captured = await read(p.context,p.accountId,true,p.override);
      before = captured.pawn;
      if (!sameBefore(p.before,before) || JSON.stringify(p.destination)!==JSON.stringify(captured.destination)) throw new Error("Player or destination changed during backup. No character was changed.");
      journal = { operationId:crypto.randomBytes(16).toString("hex"),status:"prepared",before,destination:p.destination,backup,context:p.context,createdAt:new Date().toISOString() };
      await deps.saveJournal(p.accountId,journal);
      await deps.audit("character_recovery_requested", { operationId:journal.operationId,accountId:p.accountId,pawnId:before.pawn_id,destination:p.destination,backupPath:backup.filePath });
      client = await deps.openClient(p.context);
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      transaction = true;
      await client.query("SET LOCAL search_path = pg_catalog, dune, public, pg_temp");
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '30s'");
      await client.query(LOCK_SQL);
      await schema(client,p.context);
      const locked = await snapshot(client,p.accountId,p.override);
      const dest = await destination(client,locked,p.override);
      if (!sameBefore(before,locked) || JSON.stringify(p.destination)!==JSON.stringify(dest)) throw new Error("Player or destination changed before recovery. Transaction cancelled.");
      await deps.assertHold(p.context);
      await query(client,"recovery-move","select dune.admin_move_offline_player_to_partition($1::text,$2::bigint,row($3::double precision,$4::double precision,$5::double precision)::dune.vector)",[before.fls_id,dest.partitionId,dest.location.x,dest.location.y,dest.location.z]);
      verifyAfter(before,await snapshot(client,p.accountId,p.override),dest);
      await deps.assertHold(p.context);
      await deps.verifyBackup(backup);
      await deps.saveJournal(p.accountId,{...journal,status:"commit-attempted"});
      commitAttempted = true;
      await client.query("COMMIT");
      transaction = false;
      await client.end();
      client = null;
      await deps.saveJournal(p.accountId,{...journal,status:"committed"});
      const final = await read(p.context,p.accountId,false,p.override);
      verifyAfter(before,final.pawn,dest);
      await deps.saveJournal(p.accountId,{...journal,status:"verified",verifiedAt:new Date().toISOString()});
      await deps.audit("character_recovery_verified", { operationId:journal.operationId,accountId:p.accountId,pawnId:before.pawn_id,destination:dest,backupPath:backup.filePath });
      return { ok:true,status:"verified",message:SUCCESS,accountId:p.accountId,backupPath:backup.filePath,current:{map:final.pawn.map,partitionId:final.pawn.partition_id,dimensionIndex:final.pawn.dimension_index,x:final.pawn.x,y:final.pawn.y,z:final.pawn.z} };
    } catch (error) {
      if (transaction && !commitAttempted) { try { await client.query("ROLLBACK"); } catch {} }
      if (journal) {
        try { await deps.saveJournal(p.accountId,{...journal,status:commitAttempted?"unverified":"rolled-back",error:error.message}); } catch {}
      }
      try { await deps.audit(commitAttempted?"character_recovery_unverified":"character_recovery_failed",{accountId:p.accountId,operationId:journal?.operationId,error:error.message}); } catch {}
      if (commitAttempted) {
        const uncertain = new Error("Recovery may have committed, but final verification failed. No post-commit rollback was attempted. Select the player again to reconcile the outcome before retrying. " + error.message);
        uncertain.code = "RECOVERY_UNVERIFIED";
        throw uncertain;
      }
      throw error;
    } finally {
      if (client) { try { await client.end(); } catch {} }
      busy = false;
    }
  }
  return { inspect,recover,diagnostics };
}
module.exports = { createCharacterRecovery,verifyAfter,validatePawn,fingerprint,ROUTINES,CHARACTER_CLASS,SUCCESS,SCHEMA_SQL,STORAGE_SQL,PAWN_SQL,LINKS_SQL,DESTINATION_SQL,LOCK_SQL,TRAVEL_LOADER_SQL,TRAVEL_LOADER_HASH,MANUAL_PARTITION_SQL };
