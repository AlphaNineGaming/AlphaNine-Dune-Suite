"use strict";

const crypto = require("crypto");
const path = require("path");
const { FORMAT_VERSION, assertDigest, canonicalJson, parseDecimalSize } = require("./migration-package");
const { parsePgRestoreToc } = require("./database-backup");
const { validateSourceMarketEvidence } = require("./migration-destination-market");

const PACKAGE_FORMAT = "alphanine-server-migration";
const VERIFICATION_QUERY_VERSION = "4";
const REQUIRED_EXTENSIONS = Object.freeze([
  Object.freeze({ name: "pgcrypto", version: "1.3" }),
  Object.freeze({ name: "pg_trgm", version: "1.6" })
]);
const MARKET_BOT_TABLES = Object.freeze([
  "alphanine_market_bot_listings",
  "alphanine_market_bot_cycles",
  "alphanine_market_bot_audit",
  "alphanine_market_bot_cycle_evidence"
]);
const MARKET_BOT_OWNED_SEQUENCES = Object.freeze(["alphanine_market_bot_audit_id_seq"]);
const CODEX_BACKUP_ARTIFACTS = Object.freeze([
  "da_codex_current_faction_backup_20260624",
  "da_codex_faction_allids_backup_20260624",
  "da_codex_faction_rep_backup_20260624",
  "da_codex_story_gate_backup_20260624"
]);
const CODEX_BACKUP_SEQUENCES = Object.freeze(CODEX_BACKUP_ARTIFACTS.map((name) => `${name}_backup_id_seq`));
const INCLUDED_BOUNDARIES = Object.freeze(["postgresql-schema:dune-with-approved-exclusions"]);
const EXCLUDED_BOUNDARIES = Object.freeze([
  "all-public-schema-objects-including-alphanine-market-bot",
  "positively-proven-dune-da-codex-backup-artifacts",
  "postgresql-system-catalogs",
  "destination-suite-configuration",
  "server-user-settings",
  "server-generated-config",
  "logs-crashes-caches",
  "historical-database-dumps",
  "kubernetes-hyperv-infrastructure"
]);
// A schema-filtered custom dump includes every dune-owned table, data record,
// sequence/state, type, routine, trigger, view, constraint, index, and partition
// attachment. Owner and ACL records are destination infrastructure, so they are
// deliberately omitted. Extensions are compatibility requirements verified by
// name/version and are not copied as infrastructure by this dump.
const DUMP_FLAGS = Object.freeze([
  "--format=custom",
  "--no-owner",
  "--no-privileges",
  "--schema=dune"
]);

const MIGRATION_AUTHORITATIVE_OFFLINE_PHASES = new Set(["stopped", "offline"]);
const MIGRATION_OFFLINE_COMPONENT_STATES = new Set(["stopped", "offline", "suspended"]);

function classifyMigrationOfflineStatus(summary = {}, pods = {}) {
  const battlegroupPhase = String(summary.phase || summary.status || "missing").trim().toLowerCase();
  const componentStates = {
    servergroup: String(summary.servergroup || battlegroupPhase).trim().toLowerCase(),
    gateway: String(summary.gateway || "missing").trim().toLowerCase(),
    director: String(summary.director || "missing").trim().toLowerCase()
  };
  const authoritativePhaseOffline = MIGRATION_AUTHORITATIVE_OFFLINE_PHASES.has(battlegroupPhase);
  const componentsOffline = authoritativePhaseOffline
    && Object.values(componentStates).every((value) => MIGRATION_OFFLINE_COMPONENT_STATES.has(value));
  const runningGamePods = (Array.isArray(pods.items) ? pods.items : []).filter((pod) =>
    String(pod.status?.phase || "") === "Running"
      && (pod.spec?.containers || []).some((container) => /(?:^|\/)seabass-server(?::|@)/i.test(String(container.image || "")))
  ).length;
  return {
    offline: componentsOffline && runningGamePods === 0,
    runningGamePods: String(runningGamePods),
    battlegroupPhase,
    authoritativePhaseOffline,
    componentsOffline,
    componentStates
  };
}

class StructuredOfflineEvidenceError extends Error {
  constructor(message, code = "migration_structured_offline_evidence") {
    super(message);
    this.name = "StructuredOfflineEvidenceError";
    this.code = code;
  }
}

function requiredObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new StructuredOfflineEvidenceError(`${label} is missing or malformed.`);
  return value;
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new StructuredOfflineEvidenceError(`${label} is missing or malformed.`);
  return value.trim().toLowerCase();
}

function podTemplateContainers(resource) {
  if (resource?.kind === "Pod") return resource?.spec?.containers;
  return resource?.spec?.template?.spec?.containers;
}

function isGameResource(resource) {
  const containers = podTemplateContainers(resource);
  if (!Array.isArray(containers)) return false;
  return containers.some((container) => /(?:^|\/)seabass-server(?::|@)/i.test(String(container?.image || "")));
}

function classifyStructuredMigrationOfflineSample(input = {}, expectedTarget = {}) {
  const battlegroup = requiredObject(input.battlegroup, "Battlegroup JSON");
  const workloads = requiredObject(input.workloads, "Kubernetes workload JSON");
  const metadata = requiredObject(battlegroup.metadata, "Battlegroup metadata");
  if (expectedTarget.namespace && metadata.namespace !== expectedTarget.namespace) throw new StructuredOfflineEvidenceError("Battlegroup namespace conflicts with the selected destination.", "migration_offline_target_conflict");
  if (expectedTarget.name && metadata.name !== expectedTarget.name) throw new StructuredOfflineEvidenceError("Battlegroup identity conflicts with the selected destination.", "migration_offline_target_conflict");
  const status = requiredObject(battlegroup.status, "Battlegroup status");
  const utilities = requiredObject(status.utilities, "Battlegroup utility status");
  const battlegroupPhase = requiredString(status.phase, "Battlegroup phase");
  const componentStates = {
    servergroup: requiredString(status.serverGroupPhase, "Server-group phase"),
    gateway: requiredString(requiredObject(utilities.serverGateway, "Gateway status").phase, "Gateway phase"),
    director: requiredString(requiredObject(utilities.director, "Director status").phase, "Director phase")
  };
  if (!Array.isArray(workloads.items)) throw new StructuredOfflineEvidenceError("Kubernetes workload items are missing or malformed.");
  let runningGamePods = 0;
  let desiredGameReplicas = 0;
  for (const resource of workloads.items) {
    if (!isGameResource(resource)) continue;
    if (resource.kind === "Pod") {
      const phase = requiredString(resource?.status?.phase, "Game pod phase");
      if (["running", "pending", "unknown"].includes(phase)) runningGamePods += 1;
      else if (!["succeeded", "failed"].includes(phase)) throw new StructuredOfflineEvidenceError("Game pod phase is unknown.");
      continue;
    }
    if (["Deployment", "StatefulSet", "ReplicaSet"].includes(resource.kind)) {
      const replicas = resource?.spec?.replicas;
      if (!Number.isSafeInteger(replicas) || replicas < 0) throw new StructuredOfflineEvidenceError("Game workload replica state is missing or malformed.");
      desiredGameReplicas += replicas;
    }
  }
  const authoritativePhaseOffline = MIGRATION_AUTHORITATIVE_OFFLINE_PHASES.has(battlegroupPhase);
  const componentsOffline = authoritativePhaseOffline
    && Object.values(componentStates).every((value) => MIGRATION_OFFLINE_COMPONENT_STATES.has(value));
  return {
    offline: componentsOffline && runningGamePods === 0 && desiredGameReplicas === 0,
    runningGamePods: String(runningGamePods),
    desiredGameReplicas: String(desiredGameReplicas),
    battlegroupPhase,
    authoritativePhaseOffline,
    componentsOffline,
    componentStates,
    target: { namespace: String(metadata.namespace || ""), name: String(metadata.name || "") }
  };
}

function assertStableStructuredMigrationOfflineSamples(samples) {
  if (!Array.isArray(samples) || samples.length !== 2) throw new StructuredOfflineEvidenceError("Exactly two structured offline samples are required.", "migration_offline_samples_missing");
  const comparable = (sample) => ({
    battlegroupPhase: sample.battlegroupPhase,
    componentStates: sample.componentStates,
    runningGamePods: sample.runningGamePods,
    desiredGameReplicas: sample.desiredGameReplicas,
    target: sample.target
  });
  if (JSON.stringify(comparable(samples[0])) !== JSON.stringify(comparable(samples[1]))) throw new StructuredOfflineEvidenceError("Structured offline evidence changed between samples.", "migration_offline_samples_inconsistent");
  if (samples.some((sample) => sample.offline !== true)) throw new StructuredOfflineEvidenceError("The battlegroup is not authoritatively stopped with zero game workloads.", "migration_destination_online");
  return { ...samples[1], samples: samples.map(comparable) };
}

function migrationRollbackOfflineComparable(value, expectedTarget = {}) {
  const evidence = requiredObject(value, "Structured rollback-backup offline evidence");
  const componentStates = requiredObject(evidence.componentStates, "Structured rollback-backup component states");
  const target = requiredObject(evidence.target, "Structured rollback-backup target");
  const normalized = {
    battlegroupPhase: requiredString(evidence.battlegroupPhase, "Rollback-backup battlegroup phase"),
    componentStates: {
      servergroup: requiredString(componentStates.servergroup, "Rollback-backup server-group phase"),
      gateway: requiredString(componentStates.gateway, "Rollback-backup gateway phase"),
      director: requiredString(componentStates.director, "Rollback-backup director phase")
    },
    runningGamePods: String(evidence.runningGamePods ?? ""),
    desiredGameReplicas: String(evidence.desiredGameReplicas ?? ""),
    target: {
      namespace: String(target.namespace || ""),
      name: String(target.name || "")
    }
  };
  if (!normalized.target.namespace || !normalized.target.name) throw new StructuredOfflineEvidenceError("Rollback-backup destination identity is missing or malformed.", "migration_offline_target_missing");
  if (expectedTarget.namespace && normalized.target.namespace !== expectedTarget.namespace) throw new StructuredOfflineEvidenceError("Rollback-backup namespace conflicts with the approved destination.", "migration_offline_target_conflict");
  if (expectedTarget.name && normalized.target.name !== expectedTarget.name) throw new StructuredOfflineEvidenceError("Rollback-backup battlegroup conflicts with the approved destination.", "migration_offline_target_conflict");
  if (normalized.battlegroupPhase !== "stopped" || normalized.componentStates.servergroup !== "stopped") throw new StructuredOfflineEvidenceError("Rollback-backup requires the battlegroup and server group to be Stopped.", "migration_destination_online");
  if (!["suspended", "offline"].includes(normalized.componentStates.gateway) || !["suspended", "offline"].includes(normalized.componentStates.director)) throw new StructuredOfflineEvidenceError("Rollback-backup requires the gateway and director to be Suspended or Offline.", "migration_destination_online");
  if (normalized.runningGamePods !== "0" || normalized.desiredGameReplicas !== "0") throw new StructuredOfflineEvidenceError("Rollback-backup requires zero running game pods and zero desired game replicas.", "migration_destination_online");
  return normalized;
}

function buildMigrationRollbackOfflineCheckpoint(evidence, expectedTarget = {}) {
  if (!Array.isArray(evidence.samples) || evidence.samples.length !== 2) throw new StructuredOfflineEvidenceError("Rollback-backup requires exactly two structured offline samples.", "migration_offline_samples_missing");
  const current = migrationRollbackOfflineComparable(evidence, expectedTarget);
  const samples = evidence.samples.map((sample) => migrationRollbackOfflineComparable(sample, current.target));
  if (evidence.offline !== true) throw new StructuredOfflineEvidenceError("Rollback-backup structured evidence is not authoritatively offline.", "migration_destination_online");
  if (canonicalJson(samples[0]) !== canonicalJson(samples[1])) throw new StructuredOfflineEvidenceError("Rollback-backup structured evidence changed between samples.", "migration_offline_samples_inconsistent");
  if (canonicalJson(current) !== canonicalJson(samples[1])) throw new StructuredOfflineEvidenceError("Rollback-backup normalized evidence conflicts with its final sample.", "migration_offline_samples_inconsistent");
  return { ...current, offline: true, samples };
}

function assertMigrationRollbackOfflineCheckpoint(expected, current) {
  const approved = buildMigrationRollbackOfflineCheckpoint(expected, expected?.target || {});
  const revalidated = buildMigrationRollbackOfflineCheckpoint(current, approved.target);
  if (canonicalJson(approved) !== canonicalJson(revalidated)) throw new StructuredOfflineEvidenceError("Rollback-backup structured evidence does not match the approved import checkpoint.", "migration_import_checkpoint_drift");
  return revalidated;
}

// Fingerprints are filled from the approved, read-only reference server using the
// canonical queries below. A mismatch is never treated as a compatible variant.
const SUPPORTED_PROFILE = Object.freeze({
  id: "dune-2051294-pg17-profile-1",
  gameBuild: "2051294-0-shipping",
  postgresMajor: "17",
  dumpToolMajor: "17",
  extensions: REQUIRED_EXTENSIONS,
  foreignKeyCount: "137",
  sequenceCount: "40",
  appliedPatchSha256: "f5fac723c19c2ac34131f67919261999b15b18573163ed9dd95934a2ea5ad210",
  sourcePortableSchemaSha256: "7e856adc532ce12ceac6439fa0657335369a7fc9f3bc775d33d185994cb50a9d",
  restoredPortableSchemaSha256: "529bf0fb4172de29972be2e825d6ad6c2089179ca98dfd7c1c6eda9b9c0f2fd7",
  freshDestinationSchemaSha256: "00ab81294372490cbb7bad54df9edc5adc5d95fe4cb833e4e587284613b109b8"
});

const CODEX_BACKUP_ARTIFACT_SQL = String.raw`
WITH expected(name,sequence_name) AS (VALUES
  ('da_codex_current_faction_backup_20260624','da_codex_current_faction_backup_20260624_backup_id_seq'),
  ('da_codex_faction_allids_backup_20260624','da_codex_faction_allids_backup_20260624_backup_id_seq'),
  ('da_codex_faction_rep_backup_20260624','da_codex_faction_rep_backup_20260624_backup_id_seq'),
  ('da_codex_story_gate_backup_20260624','da_codex_story_gate_backup_20260624_backup_id_seq')
), inspected AS (
  SELECT e.name,e.sequence_name,c.oid,c.relkind,c.relpersistence,
    (SELECT count(*) FROM pg_constraint con
      WHERE con.contype='f' AND (con.conrelid=c.oid OR con.confrelid=c.oid)) AS foreign_keys,
    (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal) AS user_triggers,
    (SELECT count(*) FROM pg_class seq JOIN pg_depend dep ON dep.objid=seq.oid
      WHERE seq.relkind='S' AND dep.refobjid=c.oid AND dep.deptype IN ('a','i')) AS owned_sequences
    ,(SELECT count(*) FROM pg_class seq JOIN pg_namespace ns ON ns.oid=seq.relnamespace
      JOIN pg_depend dep ON dep.objid=seq.oid
      WHERE seq.relkind='S' AND ns.nspname='dune' AND seq.relname=e.sequence_name
        AND dep.refobjid=c.oid AND dep.deptype IN ('a','i')) AS expected_owned_sequences
  FROM expected e LEFT JOIN pg_class c ON c.relname=e.name
    AND c.relnamespace=(SELECT oid FROM pg_namespace WHERE nspname='dune')
)
SELECT jsonb_build_object(
  'count',count(*) FILTER (WHERE oid IS NOT NULL)::text,
  'safe',bool_and(oid IS NOT NULL AND relkind='r' AND relpersistence='p'
    AND foreign_keys=0 AND user_triggers=0 AND owned_sequences=1 AND expected_owned_sequences=1),
  'names',COALESCE(jsonb_agg(name ORDER BY name) FILTER (WHERE oid IS NOT NULL),'[]'::jsonb)
)::text FROM inspected;
`;

const ENTITY_TABLES = Object.freeze({
  accounts: "accounts",
  actorFglEntities: "actor_fgl_entities",
  actors: "actors",
  buildingInstances: "building_instances",
  buildings: "buildings",
  encryptedPlayerState: "encrypted_player_state",
  exchangeOrders: "dune_exchange_orders",
  exchangeSellOrders: "dune_exchange_sell_orders",
  exchanges: "dune_exchanges",
  fglEntities: "fgl_entities",
  guildMembers: "guild_members",
  guilds: "guilds",
  inventories: "inventories",
  items: "items",
  landsraadRewards: "landsraad_task_rewards",
  landsraadTasks: "landsraad_tasks",
  landsraadTerms: "landsraad_decree_term",
  parties: "parties",
  placeables: "placeables",
  playerFaction: "player_faction",
  playerReputation: "player_faction_reputation",
  playerState: "player_state",
  playerVirtualCurrency: "player_virtual_currency_balances",
  specializationTracks: "specialization_tracks",
  vehicleModules: "vehicle_modules",
  vehicles: "vehicles"
});

const SCHEMA_CATALOG_SQL = String.raw`
WITH catalog_rows AS (
  SELECT 'relation' AS kind,
         c.oid::regclass::text AS identity,
         jsonb_build_object('relkind', c.relkind, 'persistence', c.relpersistence,
           'partition', pg_get_expr(c.relpartbound, c.oid, true)) AS definition
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='dune' AND c.relkind IN ('r','p','v','m','S','f')
    AND c.relname <> ALL(ARRAY['da_codex_current_faction_backup_20260624','da_codex_faction_allids_backup_20260624','da_codex_faction_rep_backup_20260624','da_codex_story_gate_backup_20260624',
      'da_codex_current_faction_backup_20260624_backup_id_seq','da_codex_faction_allids_backup_20260624_backup_id_seq','da_codex_faction_rep_backup_20260624_backup_id_seq','da_codex_story_gate_backup_20260624_backup_id_seq'])
  UNION ALL
  SELECT 'column', format('%I.%I.%I', n.nspname,c.relname,a.attname),
         jsonb_build_object('position',a.attnum,'type',format_type(a.atttypid,a.atttypmod),
           'notNull',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,
           'default',pg_get_expr(ad.adbin,ad.adrelid,true),'collation',coll.collname)
  FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  LEFT JOIN pg_attrdef ad ON ad.adrelid=a.attrelid AND ad.adnum=a.attnum
  LEFT JOIN pg_collation coll ON coll.oid=a.attcollation AND a.attcollation<>0
  WHERE n.nspname='dune' AND a.attnum>0 AND NOT a.attisdropped
    AND c.relname <> ALL(ARRAY['da_codex_current_faction_backup_20260624','da_codex_faction_allids_backup_20260624','da_codex_faction_rep_backup_20260624','da_codex_story_gate_backup_20260624'])
  UNION ALL
  SELECT 'constraint', format('%I.%I',n.nspname,con.conname),
         jsonb_build_object('type',con.contype,'validated',con.convalidated,'definition',pg_get_constraintdef(con.oid,true))
  FROM pg_constraint con JOIN pg_namespace n ON n.oid=con.connamespace LEFT JOIN pg_class rc ON rc.oid=con.conrelid
  WHERE n.nspname='dune' AND (rc.oid IS NULL OR rc.relname <> ALL(ARRAY['da_codex_current_faction_backup_20260624','da_codex_faction_allids_backup_20260624','da_codex_faction_rep_backup_20260624','da_codex_story_gate_backup_20260624']))
  UNION ALL
  SELECT 'index', format('%I.%I',n.nspname,c.relname), to_jsonb(pg_get_indexdef(c.oid))
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_index ix ON ix.indexrelid=c.oid JOIN pg_class parent ON parent.oid=ix.indrelid
  WHERE n.nspname='dune' AND c.relkind='i'
    AND parent.relname <> ALL(ARRAY['da_codex_current_faction_backup_20260624','da_codex_faction_allids_backup_20260624','da_codex_faction_rep_backup_20260624','da_codex_story_gate_backup_20260624'])
  UNION ALL
  SELECT 'view', format('%I.%I',n.nspname,c.relname), to_jsonb(pg_get_viewdef(c.oid,true))
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='dune' AND c.relkind IN ('v','m')
  UNION ALL
  SELECT 'sequence', format('%I.%I',n.nspname,c.relname),
         jsonb_build_object('start',s.seqstart::text,'minimum',s.seqmin::text,'maximum',s.seqmax::text,
           'increment',s.seqincrement::text,'cycle',s.seqcycle,'cache',s.seqcache::text,'type',format_type(s.seqtypid,NULL))
  FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='dune'
    AND c.relname <> ALL(ARRAY['da_codex_current_faction_backup_20260624_backup_id_seq','da_codex_faction_allids_backup_20260624_backup_id_seq','da_codex_faction_rep_backup_20260624_backup_id_seq','da_codex_story_gate_backup_20260624_backup_id_seq'])
  UNION ALL
  SELECT 'routine', format('%I.%I(%s)',n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)),
         jsonb_build_object('kind',p.prokind,'language',l.lanname,'volatility',p.provolatile,
           'parallel',p.proparallel,'securityDefiner',p.prosecdef,'definition',pg_get_functiondef(p.oid))
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
  WHERE n.nspname='dune'
  UNION ALL
  SELECT 'trigger', format('%I.%I.%I',n.nspname,c.relname,t.tgname), to_jsonb(pg_get_triggerdef(t.oid,true))
  FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='dune' AND NOT t.tgisinternal
    AND c.relname <> ALL(ARRAY['da_codex_current_faction_backup_20260624','da_codex_faction_allids_backup_20260624','da_codex_faction_rep_backup_20260624','da_codex_story_gate_backup_20260624'])
  UNION ALL
  SELECT 'type', format('%I.%I',n.nspname,t.typname),
         jsonb_build_object('typeKind',t.typtype,'category',t.typcategory,'base',format_type(t.typbasetype,t.typtypmod))
  FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
  WHERE n.nspname='dune' AND t.typtype IN ('c','d','e','r','m')
    AND NOT (t.typtype='c' AND EXISTS(SELECT 1 FROM pg_class tc WHERE tc.oid=t.typrelid
      AND tc.relname = ANY(ARRAY['da_codex_current_faction_backup_20260624','da_codex_faction_allids_backup_20260624','da_codex_faction_rep_backup_20260624','da_codex_story_gate_backup_20260624'])))
)
SELECT COALESCE(jsonb_agg(jsonb_build_array(kind,identity,definition) ORDER BY kind,identity,definition::text),'[]'::jsonb)::text FROM catalog_rows;
`;

const PATCH_CATALOG_SQL = String.raw`
SELECT COALESCE(jsonb_agg(name ORDER BY name),'[]'::jsonb)::text FROM dune.applied_patches;
`;

const EXTENSION_SQL = String.raw`
SELECT COALESCE(jsonb_agg(jsonb_build_object('name',extname,'version',extversion) ORDER BY extname),'[]'::jsonb)::text
FROM pg_extension WHERE extname IN ('pgcrypto','pg_trgm');
`;

const DATABASE_FACTS_SQL = String.raw`
SELECT jsonb_build_object(
  'database',current_database(),
  'databaseBytes',pg_database_size(current_database())::text,
  'serverVersion',current_setting('server_version'),
  'serverVersionNum',current_setting('server_version_num'),
  'reachable',true
)::text;
`;

const ACTIVE_WRITERS_SQL = String.raw`
SELECT jsonb_build_object(
  'unexpectedActiveClients',count(*)::text,
  'openTransactions',count(*) FILTER (WHERE backend_xid IS NOT NULL OR state LIKE 'idle in transaction%')::text
)::text
FROM pg_stat_activity
WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'
  AND (state='active' OR state LIKE 'idle in transaction%' OR backend_xid IS NOT NULL);
`;

async function collectIndependentWriterSamples(sample, delay = async () => {}) {
  if (typeof sample !== "function") throw new TypeError("A writer-sample function is required.");
  if (typeof delay !== "function") throw new TypeError("A writer-sample delay function is required.");
  const first = await sample(0);
  await delay();
  const second = await sample(1);
  return [first, second];
}

function evaluateIndependentWriterSamples(samples) {
  const normalized = Array.isArray(samples) ? samples.map((sample) => ({
    unexpectedActiveClients: String(sample?.unexpectedActiveClients ?? ""),
    openTransactions: String(sample?.openTransactions ?? "")
  })) : [];
  return {
    ok: normalized.length === 2 && normalized.every((sample) => sample.unexpectedActiveClients === "0" && sample.openTransactions === "0"),
    samples: normalized
  };
}

// v1 destinations do not install Market Bot. Every authoritative player/world/
// economy row remains a hard failure; static catalog and patch tables are
// compatibility evidence instead.
const FRESH_DESTINATION_SQL = String.raw`
SELECT jsonb_build_object(
  'authoritativeRows',(
    (SELECT count(*) FROM dune.accounts) +
    (SELECT count(*) FROM dune.actors) +
    (SELECT count(*) FROM dune.actor_fgl_entities) +
    (SELECT count(*) FROM dune.building_instances) +
    (SELECT count(*) FROM dune.encrypted_player_state) +
    (SELECT count(*) FROM dune.dune_exchange_orders) +
    (SELECT count(*) FROM dune.dune_exchange_sell_orders) +
    (SELECT count(*) FROM dune.guild_members) + (SELECT count(*) FROM dune.guilds) +
    (SELECT count(*) FROM dune.inventories) + (SELECT count(*) FROM dune.items) +
    (SELECT count(*) FROM dune.parties) + (SELECT count(*) FROM dune.placeables) +
    (SELECT count(*) FROM dune.player_faction) + (SELECT count(*) FROM dune.player_faction_reputation) +
    (SELECT count(*) FROM dune.player_state) + (SELECT count(*) FROM dune.player_virtual_currency_balances) +
    (SELECT count(*) FROM dune.specialization_tracks) +
    (SELECT count(*) FROM dune.vehicle_modules) + (SELECT count(*) FROM dune.vehicles)
  )::text,
  'relationalInvalidity','0',
  'marketBotTablesPresent',(SELECT count(*)::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relname LIKE 'alphanine_market_bot_%')
)::text;
`;

const RELATIONSHIP_SQL = String.raw`
WITH rows AS (
  SELECT con.conname, con.convalidated, pg_get_constraintdef(con.oid,true) AS definition
  FROM pg_constraint con JOIN pg_namespace n ON n.oid=con.connamespace
  WHERE n.nspname='dune' AND con.contype='f'
), payload AS (
  SELECT count(*)::text AS count,
         count(*) FILTER (WHERE NOT convalidated)::text AS invalid,
         COALESCE(jsonb_agg(jsonb_build_array(conname,definition) ORDER BY conname,definition),'[]'::jsonb)::text AS canonical
  FROM rows
)
SELECT jsonb_build_object('foreignKeyCount',count,'invalidForeignKeys',invalid,'sha256Input',canonical)::text FROM payload;
`;

const SEQUENCE_SQL = String.raw`
WITH rows AS (
  SELECT sequencename,start_value,min_value,max_value,increment_by,cycle,cache_size,last_value
  FROM pg_sequences WHERE schemaname='dune'
    AND sequencename <> ALL(ARRAY['da_codex_current_faction_backup_20260624_backup_id_seq','da_codex_faction_allids_backup_20260624_backup_id_seq','da_codex_faction_rep_backup_20260624_backup_id_seq','da_codex_story_gate_backup_20260624_backup_id_seq'])
), payload AS (
  SELECT count(*)::text AS count,
         COALESCE(jsonb_agg(jsonb_build_array(sequencename,start_value::text,min_value::text,max_value::text,
           increment_by::text,cycle,cache_size::text,last_value::text) ORDER BY sequencename),'[]'::jsonb)::text AS canonical
  FROM rows
)
SELECT jsonb_build_object('sequenceCount',count,'sha256Input',canonical)::text FROM payload;
`;

function entityCountsSql(tables = ENTITY_TABLES) {
  const pairs = Object.entries(tables);
  return `SELECT jsonb_build_object(${pairs.map(([key, table]) => `'${key}',(SELECT count(*)::text FROM dune.${table})`).join(",")})::text;`;
}

function marketBotTableCountsSql(tables = MARKET_BOT_TABLES) {
  return `SELECT jsonb_build_object(${tables.map((table) => `'${table}',(SELECT count(*)::text FROM public.${table})`).join(",")})::text;`;
}

function validateMarketBotEvidence(value, label = "marketBot") {
  exactObjectKeys(value, ["tableCounts", "tracking", "digests", "policy"], label);
  exactObjectKeys(value.tableCounts, MARKET_BOT_TABLES, `${label}.tableCounts`);
  for (const table of MARKET_BOT_TABLES) {
    if (typeof value.tableCounts[table] !== "string") throw new Error(`Migration ${label}.${table} must be a decimal string.`);
    parseDecimalSize(value.tableCounts[table], `${label}.${table}`);
  }
  exactObjectKeys(value.tracking, ["total", "active", "retired"], `${label}.tracking`);
  for (const key of ["total", "active", "retired"]) {
    if (typeof value.tracking[key] !== "string") throw new Error(`Migration ${label}.tracking.${key} must be a decimal string.`);
    parseDecimalSize(value.tracking[key], `${label}.tracking.${key}`);
  }
  if (BigInt(value.tracking.active) + BigInt(value.tracking.retired) !== BigInt(value.tracking.total)) throw new Error("Migration tracking counts are inconsistent.");
  exactObjectKeys(value.digests, ["botOwned", "protectedNonBot", "cycleEvidence"], `${label}.digests`);
  for (const digest of Object.values(value.digests)) assertDigest(digest, `${label} SHA-256`);
  exactObjectKeys(value.policy, ["runtimeVersion", "schemaVersion", "catalogItems", "catalogSha256", "semanticSha256"], `${label}.policy`);
  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(String(value.policy.runtimeVersion || ""))) throw new Error(`Migration ${label} runtime version is invalid.`);
  for (const field of ["schemaVersion", "catalogItems"]) {
    if (typeof value.policy[field] !== "string") throw new Error(`Migration ${label}.policy.${field} must be a decimal string.`);
    parseDecimalSize(value.policy[field], `${label}.policy.${field}`);
  }
  assertDigest(value.policy.catalogSha256, `${label} catalog SHA-256`);
  assertDigest(value.policy.semanticSha256, `${label} semantic policy SHA-256`);
  return value;
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function parseJsonResult(value, label) {
  try { return JSON.parse(String(value || "")); }
  catch { throw new Error(`Server Migration could not parse ${label} evidence.`); }
}

function exactObjectKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Migration ${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error(`Migration ${label} contains unknown or missing fields.`);
}

function validateDecimalMap(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.keys(value).length) throw new Error(`Migration ${label} must be a non-empty object.`);
  for (const [key, count] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)) throw new Error(`Migration ${label} contains an invalid key.`);
    if (typeof count !== "string") throw new Error(`Migration ${label}.${key} must be stored as a decimal string.`);
    parseDecimalSize(count, `${label}.${key}`);
  }
}

function validateNoSensitiveManifestData(value, trail = []) {
  const forbiddenKeys = ["password", "secret", "credential", "username", "ssh", "ipaddress", "hostpath", "windowspath", "vmpath", "pvc", "namespace", "battlegroupname", "playername", "rowdata"];
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (forbiddenKeys.some((token) => normalizedKey === token || normalizedKey.startsWith(token) || normalizedKey.endsWith(token))) throw new Error(`Migration manifest contains forbidden field ${[...trail, key].join(".")}.`);
      validateNoSensitiveManifestData(nested, [...trail, key]);
    }
    return;
  }
  if (typeof value !== "string") return;
  if (/(?:[A-Za-z]:[\\/]|\\\\|\/home\/|\/var\/|\/tmp\/|ssh-rsa|BEGIN [A-Z ]*PRIVATE KEY)/i.test(value)) throw new Error("Migration manifest contains a forbidden local or server path/key value.");
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(value)) throw new Error("Migration manifest contains an IP address.");
}

function validateExtensions(extensions) {
  if (!Array.isArray(extensions) || extensions.length !== REQUIRED_EXTENSIONS.length) throw new Error("Migration manifest has an unsupported extension set.");
  for (let index = 0; index < extensions.length; index += 1) {
    exactObjectKeys(extensions[index], ["name", "version"], "extension");
    if (extensions[index].name !== REQUIRED_EXTENSIONS[index].name || extensions[index].version !== REQUIRED_EXTENSIONS[index].version) throw new Error("Migration manifest has an unsupported extension name or version.");
  }
}

function validateMigrationManifest(manifest, profile = SUPPORTED_PROFILE) {
  exactObjectKeys(manifest, ["format", "formatVersion", "suiteVersion", "createdAt", "source", "fingerprints", "boundary", "verificationQueryVersion", "entityCounts", "sourceMarket", "components", "compatibility"], "manifest");
  if (manifest.format !== PACKAGE_FORMAT || manifest.formatVersion !== FORMAT_VERSION) throw new Error("Migration package format version is unsupported.");
  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(String(manifest.suiteVersion || ""))) throw new Error("Migration Suite version is invalid.");
  if (!Number.isFinite(Date.parse(manifest.createdAt)) || !String(manifest.createdAt).endsWith("Z")) throw new Error("Migration creation timestamp must be UTC.");
  exactObjectKeys(manifest.source, ["gameBuild", "postgresServerVersion", "dumpToolVersion", "requiredExtensions"], "source");
  if (manifest.source.gameBuild !== profile.gameBuild) throw new Error("Migration game build is unsupported.");
  if (String(manifest.source.postgresServerVersion).split(".")[0] !== profile.postgresMajor) throw new Error("Migration PostgreSQL server version is unsupported.");
  if (String(manifest.source.dumpToolVersion).split(".")[0] !== profile.dumpToolMajor) throw new Error("Migration dump-tool version is unsupported.");
  validateExtensions(manifest.source.requiredExtensions);
  exactObjectKeys(manifest.fingerprints, ["appliedPatchesSha256", "schemaCatalogSha256"], "fingerprints");
  if (assertDigest(manifest.fingerprints.appliedPatchesSha256) !== profile.appliedPatchSha256 || assertDigest(manifest.fingerprints.schemaCatalogSha256) !== profile.sourcePortableSchemaSha256) throw new Error("Migration source-portable schema or applied-patch fingerprint is unsupported.");
  exactObjectKeys(manifest.boundary, ["included", "excluded"], "boundary");
  if (canonicalJson(manifest.boundary.included) !== canonicalJson(INCLUDED_BOUNDARIES) || canonicalJson(manifest.boundary.excluded) !== canonicalJson(EXCLUDED_BOUNDARIES)) throw new Error("Migration database boundary is unsupported.");
  if (manifest.verificationQueryVersion !== VERIFICATION_QUERY_VERSION) throw new Error("Migration verification-query version is unsupported.");
  validateDecimalMap(manifest.entityCounts, "entityCounts");
  const entityKeys = Object.keys(manifest.entityCounts).sort();
  const expectedEntityKeys = Object.keys(ENTITY_TABLES).sort();
  if (entityKeys.length !== expectedEntityKeys.length || entityKeys.some((key, index) => key !== expectedEntityKeys[index])) throw new Error("Migration semantic entity-count set is incomplete or unknown.");
  validateSourceMarketEvidence(manifest.sourceMarket, "manifest.sourceMarket");
  if (!Array.isArray(manifest.components) || manifest.components.length !== 3) throw new Error("Migration manifest must describe exactly three package components.");
  const expectedPaths = ["manifest.json", "world.dump", "verification.json"];
  const expectedMediaTypes = ["application/json", "application/vnd.postgresql.custom-dump", "application/json"];
  manifest.components.forEach((component, index) => {
    exactObjectKeys(component, ["path", "mediaType", "size", "sha256"], "component");
    if (component.path !== expectedPaths[index]) throw new Error("Migration manifest components are missing or out of order.");
    if (component.mediaType !== expectedMediaTypes[index]) throw new Error("Migration manifest component media type is unsupported.");
    parseDecimalSize(component.size, "component size");
    assertDigest(component.sha256, "component SHA-256");
  });
  const selfInput = JSON.parse(JSON.stringify(manifest));
  selfInput.components[0].sha256 = "0".repeat(64);
  if (manifest.components[0].size !== String(Buffer.byteLength(canonicalJson(manifest), "utf8")) || manifest.components[0].sha256 !== sha256Text(canonicalJson(selfInput))) throw new Error("Migration manifest self-digest is invalid.");
  exactObjectKeys(manifest.compatibility, ["mode", "profileId"], "compatibility");
  if (manifest.compatibility.mode !== "exact" || manifest.compatibility.profileId !== profile.id) throw new Error("Migration compatibility policy is unsupported.");
  validateNoSensitiveManifestData(manifest);
  return manifest;
}

function buildMigrationManifest({ suiteVersion, createdAt, gameBuild, postgresServerVersion, dumpToolVersion, extensions, appliedPatchSha256, schemaCatalogSha256, entityCounts, sourceMarket, components, profile = SUPPORTED_PROFILE }) {
  const manifest = {
    format: PACKAGE_FORMAT,
    formatVersion: FORMAT_VERSION,
    suiteVersion: String(suiteVersion),
    createdAt: String(createdAt),
    source: { gameBuild, postgresServerVersion, dumpToolVersion, requiredExtensions: extensions },
    fingerprints: { appliedPatchesSha256: appliedPatchSha256, schemaCatalogSha256 },
    boundary: { included: [...INCLUDED_BOUNDARIES], excluded: [...EXCLUDED_BOUNDARIES] },
    verificationQueryVersion: VERIFICATION_QUERY_VERSION,
    entityCounts,
    sourceMarket,
    components: [{ path: "manifest.json", mediaType: "application/json", size: "0", sha256: "0".repeat(64) }, ...components],
    compatibility: { mode: "exact", profileId: profile.id }
  };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const size = String(Buffer.byteLength(canonicalJson(manifest), "utf8"));
    if (manifest.components[0].size === size) break;
    manifest.components[0].size = size;
  }
  const selfInput = JSON.parse(JSON.stringify(manifest));
  selfInput.components[0].sha256 = "0".repeat(64);
  manifest.components[0].sha256 = sha256Text(canonicalJson(selfInput));
  return validateMigrationManifest(manifest, profile);
}

function validateVerificationEvidence(verification, manifest, profile = SUPPORTED_PROFILE) {
  exactObjectKeys(verification, ["formatVersion", "queryVersion", "collectedAt", "fingerprints", "requiredExtensions", "entityCounts", "sourceMarket", "relationships", "sequences"], "verification evidence");
  if (verification.formatVersion !== FORMAT_VERSION || verification.queryVersion !== VERIFICATION_QUERY_VERSION) throw new Error("Migration verification evidence version is unsupported.");
  if (!Number.isFinite(Date.parse(verification.collectedAt)) || !String(verification.collectedAt).endsWith("Z")) throw new Error("Migration verification timestamp must be UTC.");
  if (canonicalJson(verification.fingerprints) !== canonicalJson(manifest.fingerprints)) throw new Error("Migration verification fingerprints do not match the manifest.");
  if (canonicalJson(verification.requiredExtensions) !== canonicalJson(manifest.source.requiredExtensions)) throw new Error("Migration verification extensions do not match the manifest.");
  if (canonicalJson(verification.entityCounts) !== canonicalJson(manifest.entityCounts)) throw new Error("Migration verification counts do not match the manifest.");
  validateSourceMarketEvidence(verification.sourceMarket, "verification.sourceMarket");
  if (canonicalJson(verification.sourceMarket) !== canonicalJson(manifest.sourceMarket)) throw new Error("Migration source-market evidence does not match the manifest.");
  exactObjectKeys(verification.relationships, ["foreignKeyCount", "invalidForeignKeys", "sha256"], "relationship evidence");
  exactObjectKeys(verification.sequences, ["sequenceCount", "sha256"], "sequence evidence");
  parseDecimalSize(verification.relationships.foreignKeyCount, "foreign-key count");
  if (verification.relationships.foreignKeyCount !== profile.foreignKeyCount) throw new Error("Migration foreign-key relationship count is unsupported.");
  if (verification.relationships.invalidForeignKeys !== "0") throw new Error("Migration database has unvalidated foreign keys.");
  assertDigest(verification.relationships.sha256, "relationship SHA-256");
  parseDecimalSize(verification.sequences.sequenceCount, "sequence count");
  if (verification.sequences.sequenceCount !== profile.sequenceCount) throw new Error("Migration sequence count is unsupported.");
  assertDigest(verification.sequences.sha256, "sequence SHA-256");
  return verification;
}

function validatePgRestoreToc(tocText, options = {}) {
  const scope = String(options.scope || "dune");
  if (scope !== "dune") throw new Error("Server Migration v1 supports only the portable dune archive boundary.");
  const entries = parsePgRestoreToc(tocText);
  const lines = String(tocText || "").split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith(";"));
  if (entries.some((entry) => String(entry.schema || "").toLowerCase() === "public" && entry.fields.some((field) => /^alphanine_/i.test(field)))) {
    throw new Error("PostgreSQL archive contains excluded public AlphaNine objects.");
  }
  const excludedArtifacts = new Set([...CODEX_BACKUP_ARTIFACTS, ...CODEX_BACKUP_SEQUENCES].map((name) => name.toLowerCase()));
  if (entries.some((entry) => String(entry.schema || "").toLowerCase() === "dune" && entry.fields.some((field) => excludedArtifacts.has(String(field).toLowerCase())))) {
    throw new Error("PostgreSQL archive contains an excluded positively-proven Codex backup artifact.");
  }
  if (entries.some((entry) => ["DATABASE", "DATABASE PROPERTIES", "EXTENSION", "ACL", "DEFAULT ACL"].includes(entry.descriptor))) throw new Error("PostgreSQL archive contains destination-owned infrastructure objects.");
  const sessionDescriptors = new Set(["ENCODING", "STDSTRINGS", "SEARCHPATH"]);
  if (entries.some((entry) => !sessionDescriptors.has(entry.descriptor) && String(entry.schema || "") !== "dune")) throw new Error("PostgreSQL archive contains objects outside the authoritative dune schema.");
  const requirements = {
    schema: (entry) => entry.descriptor === "SCHEMA" && entry.fields[1] === "dune",
    tables: (entry) => entry.descriptor === "TABLE" && entry.schema === "dune",
    tableData: (entry) => entry.descriptor === "TABLE DATA" && entry.schema === "dune",
    sequences: (entry) => entry.descriptor === "SEQUENCE" && entry.schema === "dune",
    sequenceState: (entry) => entry.descriptor === "SEQUENCE SET" && entry.schema === "dune",
    types: (entry) => ["TYPE", "DOMAIN"].includes(entry.descriptor) && entry.schema === "dune",
    functions: (entry) => ["FUNCTION", "PROCEDURE", "AGGREGATE"].includes(entry.descriptor) && entry.schema === "dune",
    triggers: (entry) => entry.descriptor === "TRIGGER" && entry.schema === "dune",
    views: (entry) => ["VIEW", "MATERIALIZED VIEW"].includes(entry.descriptor) && entry.schema === "dune",
    constraints: (entry) => entry.descriptor === "CONSTRAINT" && entry.schema === "dune",
    foreignKeys: (entry) => entry.descriptor === "FK CONSTRAINT" && entry.schema === "dune",
    partitions: (entry) => entry.descriptor === "TABLE ATTACH" && entry.schema === "dune"
  };
  const evidence = Object.fromEntries(Object.entries(requirements).map(([key, predicate]) => [key, entries.some(predicate)]));
  const missing = Object.entries(evidence).filter(([, present]) => !present).map(([key]) => key);
  if (missing.length) throw new Error(`PostgreSQL archive is missing required dune object classes: ${missing.join(", ")}.`);
  return { ok: true, entryCount: String(lines.length), objectClasses: evidence, sha256: sha256Text(`${lines.join("\n")}\n`) };
}

function isWithin(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assessOutputPath(outputPath, options = {}) {
  const resolved = path.resolve(String(outputPath || ""));
  if (!String(outputPath || "").trim()) throw new Error("Choose a migration package destination.");
  if (path.extname(resolved).toLowerCase() !== ".a9migration") throw new Error("Migration export filename must end in .a9migration.");
  const unsafeRoots = (options.unsafeRoots || []).filter(Boolean).map((root) => path.resolve(root));
  const unsafeReasons = [];
  for (const root of unsafeRoots) {
    if (isWithin(resolved, root)) unsafeReasons.push("The selected location is inside a server, Suite, or temporary directory.");
  }
  return { fileName: path.basename(resolved), parentPath: path.dirname(resolved), resolvedPath: resolved, unsafe: unsafeReasons.length > 0, unsafeReasons: [...new Set(unsafeReasons)] };
}

module.exports = {
  ACTIVE_WRITERS_SQL,
  CODEX_BACKUP_ARTIFACTS,
  CODEX_BACKUP_ARTIFACT_SQL,
  CODEX_BACKUP_SEQUENCES,
  DATABASE_FACTS_SQL,
  DUMP_FLAGS,
  ENTITY_TABLES,
  EXCLUDED_BOUNDARIES,
  EXTENSION_SQL,
  FRESH_DESTINATION_SQL,
  INCLUDED_BOUNDARIES,
  MARKET_BOT_TABLES,
  MARKET_BOT_OWNED_SEQUENCES,
  PACKAGE_FORMAT,
  PATCH_CATALOG_SQL,
  RELATIONSHIP_SQL,
  REQUIRED_EXTENSIONS,
  SCHEMA_CATALOG_SQL,
  SEQUENCE_SQL,
  SUPPORTED_PROFILE,
  VERIFICATION_QUERY_VERSION,
  StructuredOfflineEvidenceError,
  assessOutputPath,
  assertMigrationRollbackOfflineCheckpoint,
  assertStableStructuredMigrationOfflineSamples,
  buildMigrationRollbackOfflineCheckpoint,
  buildMigrationManifest,
  classifyMigrationOfflineStatus,
  classifyStructuredMigrationOfflineSample,
  collectIndependentWriterSamples,
  entityCountsSql,
  evaluateIndependentWriterSamples,
  marketBotTableCountsSql,
  parseJsonResult,
  sha256Text,
  validateMigrationManifest,
  validateMarketBotEvidence,
  validateSourceMarketEvidence,
  validateNoSensitiveManifestData,
  validatePgRestoreToc,
  validateVerificationEvidence
};
