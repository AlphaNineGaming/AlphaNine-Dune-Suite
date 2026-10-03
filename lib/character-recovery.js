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
   'transfer_import',(select to_jsonb(x) from dune.character_transfer_imports x where x.fls_id=$6)
 )::text as protected_links,
 exists(select 1 from dune.actors x where x.id=any($7::bigint[]) and x.state::text<>'Default')
 or exists(select 1 from dune.travel_actor_parent x where x.id=any($7::bigint[]) or x.parent_id=any($7::bigint[]))
 or exists(select 1 from dune.character_transfer_imports x where x.fls_id=$6) as transfer_blocked,
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
const LOCK_SQL = `LOCK TABLE dune.actors, dune.character_transfer_imports,
 dune.encrypted_accounts, dune.encrypted_player_state, dune.inventories, dune.items,
 dune.player_travel_state, dune.travel_actor_parent, dune.travel_return_info,
 dune.world_partition IN SHARE ROW EXCLUSIVE MODE`;

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
  if (new Set([p.pawn_id, p.controller_id, p.state_id]).size !== 3 || p.class !== CHARACTER_CLASS || p.owner_account_id !== accountId || p.state !== "Default") throw new Error("The authoritative PlayerCharacter identity, ownership or actor state could not be verified.");
  if (p.online_status !== "Offline" || p.database_offline !== true) throw new Error("The selected player must be offline.");
  if (![p.x,p.y,p.z].every((n) => typeof n === "number" && Number.isFinite(n)) || !p.rotation || !p.protected_pawn) throw new Error("The pawn before-state is incomplete.");
  return p;
}
function sameBefore(a, b) {
  return a.pawn_snapshot === b.pawn_snapshot && a.protected_links === b.protected_links && a.row_id === b.row_id && a.fls_id === b.fls_id;
}
function verifyAfter(before, after, destination) {
  if (before.account_id !== after.account_id || before.row_id !== after.row_id || before.pawn_id !== after.pawn_id || before.fls_id !== after.fls_id || before.owner_account_id !== after.owner_account_id || before.rotation !== after.rotation || before.protected_pawn !== after.protected_pawn || before.protected_links !== after.protected_links) throw new Error("Recovery verification failed: identity, rotation or protected character data changed.");
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
  async function snapshot(client, accountId) {
    const p = validatePawn((await query(client, "recovery-pawn", PAWN_SQL, [accountId])).rows, accountId);
    const ids = [p.pawn_id,p.controller_id,p.state_id];
    const linked = (await query(client, "recovery-links", LINKS_SQL, [accountId,p.row_id,p.controller_id,p.state_id,p.pawn_id,p.fls_id,ids])).rows[0];
    if (!linked?.protected_links || linked.transfer_blocked) throw new Error("Travel, migration or protected character linkage is ambiguous.");
    const links = JSON.parse(linked.protected_links);
    if (!links.account || !links.character || !links.controller || !links.player_state) throw new Error("Required account, PlayerController or PlayerState records are missing.");
    return { ...p, ...linked };
  }
  async function destination(client, pawn) {
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
  async function read(context, accountId, includeDestination = false) {
    const client = await deps.openClient(context);
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SET LOCAL search_path = pg_catalog, dune, public, pg_temp");
      await schema(client, context);
      const pawn = await snapshot(client, accountId);
      const dest = includeDestination ? await destination(client, pawn) : null;
      return { pawn, destination:dest };
    } finally {
      try { await client.query("ROLLBACK"); } finally { await client.end(); }
    }
  }
  async function inspect(accountValue) {
    const accountId = dbId(accountValue);
    const context = await deps.getContext();
    const { pawn, destination:dest } = await read(context, accountId, true);
    const previous = await deps.loadJournal(accountId, context);
    if (previous && ["commit-attempted","committed","unverified"].includes(previous.status)) {
      try { verifyAfter(previous.before, pawn, previous.destination); }
      catch { if (!sameBefore(previous.before, pawn)) throw new Error("A previous recovery has an unverified outcome. Reconcile it before retrying."); }
      await deps.saveJournal(accountId, { ...previous, status:"reconciled", reconciledAt:new Date().toISOString() });
    }
    for (const [id,p] of previews) if (p.expiresAt < Date.now()) previews.delete(id);
    const previewId = crypto.randomBytes(16).toString("hex");
    previews.set(previewId, { accountId,context,before:pawn,destination:dest,expiresAt:Date.now()+10*60*1000 });
    return { ok:true,previewId,accountId,playerName:pawn.character_name,currentLocation:pawn.map,current:{map:pawn.map,partitionId:pawn.partition_id,dimensionIndex:pawn.dimension_index,x:pawn.x,y:pawn.y,z:pawn.z},destination:{map:"HaggaBasin",partitionId:dest.partitionId,dimensionIndex:dest.dimensionIndex,...dest.location},playerOffline:true };
  }
  async function recover(body = {}) {
    if (body.confirmed !== true) throw new Error("Confirm character recovery first.");
    const p = previews.get(String(body.previewId || ""));
    if (!p || p.expiresAt < Date.now()) throw new Error("Recovery preview expired. Select the player again.");
    if (busy) throw new Error("Another character recovery is in progress.");
    busy = true;
    previews.delete(body.previewId); // A confirmation is single-use, including failure.
    let client, before, journal, transaction = false, commitAttempted = false;
    try {
      const previous = await deps.loadJournal(p.accountId, p.context);
      if (previous && ["commit-attempted","committed","unverified"].includes(previous.status)) throw new Error("A previous recovery must be reconciled before retrying.");
      await deps.assertSafe(p.context);
      const refreshed = await read(p.context,p.accountId,true);
      if (!sameBefore(p.before,refreshed.pawn) || JSON.stringify(p.destination)!==JSON.stringify(refreshed.destination)) throw new Error("Player or destination changed after confirmation. No character was changed.");
      const backup = await deps.createBackup(p.context);
      if (backup?.ok !== true || backup.verified !== true) throw new Error(backup?.error || "A verified safety backup could not be created.");
      await deps.verifyBackup(backup);
      await deps.assertSafe(p.context);
      const captured = await read(p.context,p.accountId,true);
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
      const locked = await snapshot(client,p.accountId);
      const dest = await destination(client,locked);
      if (!sameBefore(before,locked) || JSON.stringify(p.destination)!==JSON.stringify(dest)) throw new Error("Player or destination changed before recovery. Transaction cancelled.");
      await deps.assertHold(p.context);
      await query(client,"recovery-move","select dune.admin_move_offline_player_to_partition($1::text,$2::bigint,row($3::double precision,$4::double precision,$5::double precision)::dune.vector)",[before.fls_id,dest.partitionId,dest.location.x,dest.location.y,dest.location.z]);
      verifyAfter(before,await snapshot(client,p.accountId),dest);
      await deps.assertHold(p.context);
      await deps.verifyBackup(backup);
      await deps.saveJournal(p.accountId,{...journal,status:"commit-attempted"});
      commitAttempted = true;
      await client.query("COMMIT");
      transaction = false;
      await client.end();
      client = null;
      await deps.saveJournal(p.accountId,{...journal,status:"committed"});
      const final = await read(p.context,p.accountId);
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
  return { inspect,recover };
}
module.exports = { createCharacterRecovery,verifyAfter,validatePawn,fingerprint,ROUTINES,CHARACTER_CLASS,SUCCESS,SCHEMA_SQL,STORAGE_SQL,PAWN_SQL,LINKS_SQL,DESTINATION_SQL,LOCK_SQL };
