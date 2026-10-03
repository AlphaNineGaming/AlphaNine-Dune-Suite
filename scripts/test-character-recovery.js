"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const { createCharacterRecovery, CHARACTER_CLASS, SUCCESS, ROUTINES, fingerprint } = require("../lib/character-recovery");
const vendor = require("./fixtures/character-recovery-vendor-routines.json");
const travelLoader = require("./fixtures/character-recovery-travel-loader.json");
const clone = (x) => JSON.parse(JSON.stringify(x));

// Transactional DB model: uncommitted function effects exist only on the client;
// rollback/disconnect discard them, and COMMIT publishes them to a fresh reader.
function harness(options = {}) {
  const initial = {
    pawn: { id:"6",owner_account_id:options.pawnOwner??"2",class:options.pawnClass??CHARACTER_CLASS,state:options.actorState??"Default",serial:"123",
      map:options.currentMap||"Arrakeen",partition_id:"3",dimension_index:0,x:90,y:80,z:70,
      rotation:"{\"w\":0.7,\"x\":0,\"y\":0,\"z\":0.6}",
      properties:{skills:["a","b"],equipment:{head:"helmet"},progression:{level:42}},
      gas_attributes:{health:250,stamina:180} },
    links:{account:{id:2,user:"original-fls-id"},character:{id:1},controller:{id:4,map:"Arrakeen",state:options.controllerState||"Default"},player_state:{id:5,map:"Arrakeen",state:options.playerStateState||"Default"},
      inventories:[{id:11,actor_id:6}],items:[{id:33,inventory_id:11,equipment:true}],
      progression:{skillPoints:17},login_travel:{login_target_dimension_index:0},travel_return:{map:"HaggaBasin"},travel_parents:options.travelParents||[],transfer_import:options.transferImport||null}
  };
  const model = { state:clone(initial),before:clone(initial),trace:[],moves:[],commits:0,rollbacks:0,backupCalls:0,backupChecks:0,journal:null,clients:0 };
  const context = {databaseId:"cluster-1",checkpoint:{name:"selected-group",namespace:"selected-namespace"},target:{name:"selected-group",namespace:"selected-namespace"}};
  function pawnRow(state) {
    const p=state.pawn;
    const {map,partition_id,dimension_index,x,y,z,rotation,...protectedPawn}=p;
    return {row_id:"1",account_id:"2",pawn_id:"6",controller_id:options.controllerId??"4",state_id:"5",character_name:"Test Player",
      online_status:options.onlineStatus||"Offline",database_offline:options.databaseOffline!==false,
      home_dimension_index:options.homeDimension??0,return_dimension_index:options.returnDimension??0,
      fls_id:"original-fls-id",fls_accounts:options.ambiguousFls?2:1,pawn_links:1,
      actor_id:p.id,owner_account_id:p.owner_account_id,class:p.class,state:p.state,map,partition_id,dimension_index,x,y,z,rotation,
      pawn_snapshot:JSON.stringify(p),protected_pawn:JSON.stringify(protectedPawn)};
  }
  class Client {
    constructor(){this.state=null;this.write=false;this.closed=false;model.clients++;}
    async query(input) {
      const name=typeof input==="string"?input:input.name;
      model.trace.push({name,write:this.write,values:input.values});
      if(typeof input==="string") {
        if(input.startsWith("BEGIN")){this.write=!input.includes("READ ONLY");this.state=clone(model.state);return {rows:[]};}
        if(input==="COMMIT"){
          assert(this.write,"Only the recovery-owned write transaction may commit");
          model.state=clone(this.state);model.commits++;this.state=null;
          if(options.commitAcknowledgementLost)throw new Error("Connection lost while committing");
          return {rows:[]};
        }
        if(input==="ROLLBACK"){if(this.write)model.rollbacks++;this.state=null;return {rows:[]};}
        if(input.startsWith("LOCK TABLE")){assert(this.write);this.locked=true;return {rows:[]};}
        return {rows:[]};
      }
      const state=this.state||model.state;
      switch(name) {
        case "recovery-database":return {rows:[{database:"dune",database_id:options.wrongDatabase?"other-cluster":"cluster-1"}]};
        case "recovery-schema":return {rows:vendor.map(r=>({...r,...(options.changedFunction&&r.proname==="admin_move_offline_player_to_partition"?{prosrc:r.prosrc+" -- changed"}:{})}))};
        case "recovery-storage":return {rows:[{relkind:"r",has_state:true,relrowsecurity:false,relforcerowsecurity:false,has_triggers:!!options.trigger,has_rules:false}]};
        case "recovery-pawn": {
          if(options.finalReadBackFails&&model.commits)throw new Error("Final read-back unavailable");
          const row=pawnRow(state);
          return {rows:options.missingPawn?[]:options.ambiguousPawn?[row,{...row,row_id:"99"}]:[row]};
        }
        case "recovery-travel-loader":return {rows:options.missingLoader?[]:options.ambiguousLoader?[travelLoader,travelLoader]:[{...travelLoader,...(options.changedLoader?{prosrc:travelLoader.prosrc+" changed"}:{})}]};
        case "recovery-links": {
          assert.match(input.text,/x\.id<>\$5::bigint and x\.state::text<>'Default'/);
          assert.match(input.text,/x\.id=\$5::bigint and x\.state::text not in \('Default','Travel'\)/);
          return {rows:[{protected_links:JSON.stringify(state.links),transfer_blocked:!!options.transferBlocked||state.links.controller.state!=="Default"||state.links.player_state.state!=="Default"||state.links.travel_parents.length>0||!!state.links.transfer_import,login_dimension:options.loginDimension??0}]};
        }
        case "recovery-manual-partition":return {rows:options.manualPartitionMissing?[]:options.manualPartitionAmbiguous?[{partition_id:"10",dimension_index:0},{partition_id:"11",dimension_index:0}]:[{partition_id:"10",dimension_index:options.manualPartitionDimension??0,partition_snapshot:options.partitionChanged&&model.moves.length?"changed":"manual-partition"}]};
        case "recovery-destination":return {rows:options.destinationMissing?[]:[{source_actor_id:"60",partition_id:"10",dimension_index:0,x:12,y:34,z:56,partition_snapshot:"{\"partition_id\":10,\"dimension_index\":0,\"blocked\":false}"}]};
        case "recovery-diagnostic": {
          assert.equal(this.write,false,"Travel diagnostics require a read-only transaction");
          if(options.diagnosticFails)throw new Error("Diagnostic query failed");
          const p=pawnRow(state);
          const evidence={accountId:"2",playerName:"Test Player",pawnId:p.pawn_id,controllerId:p.controller_id,playerStateId:p.state_id,onlineStatus:p.online_status,
            actors:options.missingPawn?[]:[{id:p.pawn_id,class:p.class,ownerAccountId:p.owner_account_id,state:p.state,map:p.map,partitionId:p.partition_id,dimensionIndex:p.dimension_index}],
            loginTargetDimensionIndex:0,travelReturn:state.links.travel_return,travelParents:[],transferImport:null};
          return {rows:options.missingCharacter?[]:(options.ambiguousPawn?[{evidence},{evidence:{...evidence,pawnId:"99"}}]:[{evidence}])};
        }
        case "recovery-diagnostic-routines": {
          assert.equal(this.write,false,"Vendor definitions must be collected read-only");
          assert.match(input.text,/pg_catalog\.pg_get_functiondef/);
          for(const name of ['login_account','get_player_pawn','load_full_actors','get_actor_server_info','save_actors','delete_actor_states_travel','get_traveling_non_player_actor_ids','get_traveling_actor_ids','get_traveling_actor_id_and_types','update_traveling_actor_tree','update_traveling_actor_dependencies']) assert(input.text.includes("'"+name+"'"),'Missing routine: '+name);
          return {rows:[{signature:"dune.admin_move_offline_player_to_partition(text,bigint,dune.vector)",definition:vendor[0].prosrc}]};
        }
        case "recovery-move": {
          assert(this.write&&this.locked,"The function must execute under recovery-owned locks and transaction");
          assert.match(input.text,/select dune\.admin_move_offline_player_to_partition\(/);
          const xyz=options.manualCoordinates||{x:12,y:34,z:56};
          assert.deepEqual(input.values,["original-fls-id","10",xyz.x,xyz.y,xyz.z]);
          model.moves.push(input.values);
          Object.assign(state.pawn,{map:"HaggaBasin",partition_id:"10",dimension_index:0,...xyz});
          if(options.functionFails)throw new Error("Vendor database function failed after its UPDATE");
          if(options.stateChanged)state.pawn.state=state.pawn.state==="Travel"?"Default":"Travel";
          if(options.badMap)state.pawn.map="HarkoVillage";
          if(options.badDimension)state.pawn.dimension_index=7;
          if(options.badPartition)state.pawn.partition_id="77";
          if(options.badLocation)state.pawn.z+=1;
          if(options.rotationChanged)state.pawn.rotation="different";
          if(options.protectedPawnChanged)state.pawn.properties.progression.level=0;
          if(options.inventoryChanged)state.links.items=[];
          if(options.controllerChanged)state.links.controller.map="HaggaBasin";
          return {rows:[{}]};
        }
        default:throw new Error("Unexpected query: "+name);
      }
    }
    async end(){this.state=null;this.closed=true;}
  }
  const presets=[{enabled:true,verified:true,map:"HaggaBasin",source:"online-player-position",source_actor_id:"60",auditVerified:true,
    name:"Existing safe location",created_at:"2026-01-01T00:00:00Z",partition_id:10,x:12,y:34,z:56}];
  const service=createCharacterRecovery({
    getContext:async()=>clone(context),openClient:async()=>new Client(),
    getVerifiedPresets:async()=>options.noPresets?[]:presets,
    withinBounds:()=>!options.outOfBounds,
    assertSafe:async()=>{if(options.serverOnline)throw new Error("Safety Backup requires the selected battlegroup fully stopped");},
    assertHold:async()=>{if(options.holdChanged&&model.moves.length)throw new Error("Server offline hold changed");},
    createBackup:async()=>{model.backupCalls++;return options.backupFails?{ok:false,verified:false,error:"Backup failed"}:{ok:true,verified:true,filePath:"verified.backup",sha256:"hash",size:"123"};},
    verifyBackup:async()=>{model.backupChecks++;if(options.backupVerifyFails||(options.backupChangedBeforeCommit&&model.moves.length))throw new Error("Backup verification failed");},
    loadJournal:async()=>clone(model.journal),saveJournal:async(_,journal)=>{model.journal=clone(journal);},audit:async()=>{}
  });
  return {service,model,options,presets};
}

test("captured vendor definitions match the inspected compatibility allowlist",()=>{
  for(const r of vendor)assert(ROUTINES[r.proname].has(fingerprint(r.prosrc)));
});
test("offline Arrakeen pawn recovers through the original FLS function and fresh read-back",async()=>{
  const {service,model}=harness();const p=await service.inspect("2");
  assert.equal(p.currentLocation,"Arrakeen");assert.equal(p.destination.partitionId,"10");
  const result=await service.recover({previewId:p.previewId,confirmed:true});
  assert.equal(result.message,SUCCESS);assert.equal(result.status,"verified");
  assert.equal(model.backupCalls,1);assert.equal(model.backupChecks,2);assert.equal(model.commits,1);assert.equal(model.rollbacks,0);
  assert.equal(model.journal.status,"verified");assert(model.clients>=4,"Final verification uses a new connection");
  assert.deepEqual(model.state.links,model.before.links);
  const expected={...model.before.pawn,map:"HaggaBasin",partition_id:"10",dimension_index:0,x:12,y:34,z:56};
  assert.deepEqual(model.state.pawn,expected,"IDs, ownership, rotation, equipment, skills and progression remain intact");
});
for(const currentMap of ["HarkoVillage","Overmap"])test("recovery resolves the existing "+currentMap+" pawn without loading its map",async()=>{
  const {service,model}=harness({currentMap});const p=await service.inspect("2");
  assert.equal(p.currentLocation,currentMap);
  await service.recover({previewId:p.previewId,confirmed:true});
  assert.equal(model.state.pawn.map,"HaggaBasin");assert.equal(model.moves.length,1);
  assert.deepEqual(model.state.links,model.before.links);
});
for(const [name,options,pattern] of [
  ["online player",{onlineStatus:"Online"},/must be offline/],
  ["unknown status",{onlineStatus:"Unknown"},/must be offline/],
  ["database offline rejection",{databaseOffline:false},/must be offline/],
  ["missing pawn",{missingPawn:true},/missing or ambiguous/],
  ["ambiguous pawn",{ambiguousPawn:true},/missing or ambiguous/],
  ["ambiguous original FLS identifier",{ambiguousFls:true},/FLS identifier/],
  ["colliding actor identities",{controllerId:"6"},/pawn 6, PlayerController 6 and PlayerState 5.*three distinct actors/],
  ["unsupported pawn class",{pawnClass:"/Game/UnknownPlayerCharacter.UnknownPlayerCharacter_C"},/pawn 6 has unsupported character class.*UnknownPlayerCharacter/],
  ["wrong pawn ownership",{pawnOwner:"42"},/pawn 6 belongs to account 42; the selected account is 2/],
  ["unsupported pawn state",{actorState:"AbortedAuthorityTransfer"},/unsupported actor state/],
  ["missing destination",{destinationMissing:true},/destination could not/],
  ["no authoritative safe preset",{noPresets:true},/destination could not/],
  ["out-of-bounds destination",{outOfBounds:true},/destination could not/],
  ["incompatible login dimension",{loginDimension:9},/destination could not/],
  ["incompatible home dimension",{homeDimension:9},/destination could not/],
  ["incompatible return dimension",{returnDimension:9},/destination could not/],
  ["travel/migration ambiguity",{transferBlocked:true},/Travel, migration/],
  ["changed database function",{changedFunction:true},/unsupported or changed/],
  ["actor update trigger",{trigger:true},/unsupported recovery side effects/],
  ["wrong database connection",{wrongDatabase:true},/safety-backup database/]
])test(name+" aborts before backup or writes",async()=>{
  const {service,model}=harness(options);await assert.rejects(service.inspect("2"),pattern);
  assert.equal(model.backupCalls,0);assert.equal(model.moves.length,0);assert.deepEqual(model.state,model.before);
});
for(const [name,options,pattern] of [
  ["server online",{serverOnline:true},/fully stopped/],
  ["backup creation failure",{backupFails:true},/Backup failed/],
  ["backup verification failure",{backupVerifyFails:true},/Backup verification/]
])test(name+" aborts without calling the function",async()=>{
  const {service,model}=harness(options);const p=await service.inspect("2");
  await assert.rejects(service.recover({previewId:p.previewId,confirmed:true}),pattern);
  assert.equal(model.moves.length,0);assert.equal(model.commits,0);assert.deepEqual(model.state,model.before);
});
for(const [name,options] of [
  ["database-function failure",{functionFails:true}],
  ["wrong map",{badMap:true}],["wrong partition",{badPartition:true}],["wrong dimension",{badDimension:true}],
  ["wrong location",{badLocation:true}],["changed rotation",{rotationChanged:true}],
  ["changed unrelated pawn progression",{protectedPawnChanged:true}],
  ["changed inventory",{inventoryChanged:true}],["changed controller",{controllerChanged:true}],
  ["lost offline hold",{holdChanged:true}],["changed backup before commit",{backupChangedBeforeCommit:true}]
])test(name+" rolls back the executed function before commit",async()=>{
  const {service,model}=harness(options);const p=await service.inspect("2");
  await assert.rejects(service.recover({previewId:p.previewId,confirmed:true}));
  assert.equal(model.moves.length,1);assert.equal(model.commits,0);assert.equal(model.rollbacks,1);
  assert.deepEqual(model.state,model.before);assert.equal(model.journal.status,"rolled-back");
});
test("player becoming online after inspection is rechecked",async()=>{
  const h=harness();const p=await h.service.inspect("2");h.options.onlineStatus="Online";
  await assert.rejects(h.service.recover({previewId:p.previewId,confirmed:true}),/must be offline/);
  assert.equal(h.model.moves.length,0);assert.equal(h.model.backupCalls,0);
});
test("before-state changed after confirmation aborts",async()=>{
  const h=harness();const p=await h.service.inspect("2");h.model.state.pawn.serial="124";
  await assert.rejects(h.service.recover({previewId:p.previewId,confirmed:true}),/changed after confirmation/);
  assert.equal(h.model.moves.length,0);
});
test("confirmation is mandatory and no browser destination is used",async()=>{
  const h=harness();const p=await h.service.inspect("2");
  await assert.rejects(h.service.recover({previewId:p.previewId}),/Confirm/);
  await h.service.recover({previewId:p.previewId,confirmed:true,partitionId:999,x:999,map:"DeepDesert",flsId:"replacement"});
  assert.deepEqual(h.model.moves[0],["original-fls-id","10",12,34,56]);
  await assert.rejects(h.service.recover({previewId:p.previewId,confirmed:true}),/expired/);
});
for(const option of ["finalReadBackFails","commitAcknowledgementLost"])test(option+" never claims post-commit rollback or retries blindly",async()=>{
  const h=harness({[option]:true});const p=await h.service.inspect("2");
  await assert.rejects(h.service.recover({previewId:p.previewId,confirmed:true}),e=>e.code==="RECOVERY_UNVERIFIED"&&/No post-commit rollback/.test(e.message));
  assert.equal(h.model.commits,1);assert.equal(h.model.rollbacks,0);assert.equal(h.model.journal.status,"unverified");
  assert.equal(h.model.state.pawn.map,"HaggaBasin");
  h.options[option]=false;const inspected=await h.service.inspect("2");
  assert.equal(inspected.currentLocation,"HaggaBasin");assert.equal(h.model.journal.status,"reconciled");
  assert.equal(h.model.moves.length,1,"Reconciliation only reads, never repeats the function");
});
test("release contains no investigated universal coordinate or direct actor UPDATE",()=>{
  const source=fs.readFileSync(path.join(__dirname,"../lib/character-recovery.js"),"utf8");
  assert.doesNotMatch(source,/UPDATE\s+dune\.actors/i);assert.doesNotMatch(source,/-88912|315607|24062/);
  const server=fs.readFileSync(path.join(__dirname,"../server.js"),"utf8");
  assert.match(server,/Recover Character/);assert.match(server,/Recovery Destination: Hagga Basin/);
  assert.match(server,/Recover to Hagga Basin/);assert.match(server,/syncCharacterRecoveryControls\(\)/);
});

function uiHarness() {
  const source=fs.readFileSync(path.join(__dirname,"../server.js"),"utf8");
  const snippet=source.slice(source.indexOf("let characterRecoveryPreview=null"),source.indexOf("function resetPlayerRename(",source.indexOf("let characterRecoveryPreview=null")));
  const elements={},calls=[],toasts=[],downloads=[];
  const h={player:{account_id:"2",online_status:"Offline"},confirmed:true,fail:false};
  function element(id){return elements[id]??=( {disabled:false,textContent:"",classList:{add(){},remove(){}}});}
  const preview={ok:true,previewId:"server-token",accountId:"2",playerName:"Test Player",currentLocation:"Arrakeen"};
  const context={document:{getElementById:element},selectedPlayer:()=>h.player,
    setText:(id,text)=>{element(id).textContent=text;},showToast:(...args)=>toasts.push(args),betterError:e=>e.message,
    appConfirm:async(title,message)=>{calls.push({confirmation:message});if(h.switchDuringConfirmation)h.player={account_id:"9",online_status:"Offline"};return h.confirmed;},
    getJson:async(url,options)=>{calls.push({url,options});if(h.fail)throw new Error("Recovery unverified; inspect before retrying");if(url.endsWith("/recovery/preview")){if(h.switchDuringDiagnostic)h.player={account_id:"9",online_status:"Offline"};return {...preview,destination:{verifiedSafe:false,partitionId:"10",x:12,y:34,z:56}};}if(url.includes("/diagnostics?")){if(h.switchDuringDiagnostic)h.player={account_id:"9",online_status:"Offline"};return {ok:true,readOnly:true,accountId:"2",characters:[{pawnId:"6",actors:[{id:"6",state:"Travel",map:"Arrakeen"}]}],routines:[]};}return options?.method==="POST"?{ok:true,message:SUCCESS,accountId:"2"}:preview;},
    databaseExplorerDownload:(...args)=>downloads.push(args),
    refreshPlayersAfterRename:async()=>{if(h.refreshFails)throw new Error("Players refresh unavailable");},encodeURIComponent};
  vm.createContext(context);vm.runInContext(snippet,context);
  return {...h,state:h,context,elements,calls,toasts,downloads,element};
}
test("Players enables recovery only for an offline selected player",()=>{
  const h=uiHarness();h.context.syncCharacterRecoveryControls();assert.equal(h.element("playerRecoveryOpenButton").disabled,false);
  h.state.player.online_status="Online";h.context.syncCharacterRecoveryControls();assert.equal(h.element("playerRecoveryOpenButton").disabled,true);
  h.state.player=null;h.context.syncCharacterRecoveryControls();assert.equal(h.element("playerRecoveryOpenButton").disabled,true);
});
test("simple recovery UI shows authoritative current location and requested confirmation",async()=>{
  const h=uiHarness();await h.context.openCharacterRecovery();
  assert.equal(h.element("playerRecoveryLocation").textContent,"Current Location: Arrakeen");
  await h.context.recoverSelectedCharacter();
  assert.equal(h.calls.find(c=>c.confirmation).confirmation,"Recover Test Player to a safe location in Hagga Basin?");
  const post=h.calls.find(c=>c.options?.method==="POST");
  assert.deepEqual(JSON.parse(post.options.body),{previewId:"server-token",confirmed:true});
  assert.equal(h.element("playerRecoveryStatus").textContent,SUCCESS);
});
test("cancelling confirmation and switching player never submit recovery",async()=>{
  for(const mode of ["cancel","switch"]){const h=uiHarness();await h.context.openCharacterRecovery();h.state.confirmed=mode!=="cancel";h.state.switchDuringConfirmation=mode==="switch";await h.context.recoverSelectedCharacter();assert.equal(h.calls.filter(c=>c.options?.method==="POST").length,0);}
});
test("read-back failure remains an error in the UI and cannot reuse the confirmation",async()=>{
  const h=uiHarness();await h.context.openCharacterRecovery();h.state.fail=true;await h.context.recoverSelectedCharacter();
  assert.match(h.element("playerRecoveryStatus").textContent,/unverified/);
  assert.equal(h.element("playerRecoveryApplyButton").disabled,true);
  assert.equal(h.toasts.some(t=>t[1]==="success"),false);
});

test("Players refresh failure preserves the verified recovery result",async()=>{
  const h=uiHarness();await h.context.openCharacterRecovery();h.state.refreshFails=true;await h.context.recoverSelectedCharacter();
  assert.ok(h.element("playerRecoveryStatus").textContent.startsWith(SUCCESS));
  assert.match(h.element("playerRecoveryStatus").textContent,/Use Refresh Players/);
  assert.equal(h.toasts.some(t=>t[1]==="error"),false);
  assert.equal(h.element("playerRecoveryApplyButton").disabled,true);
});

for(const options of [{actorState:"Travel"},{onlineStatus:"Online"},{missingPawn:true},{ambiguousPawn:true},{missingCharacter:true}])test("Suite diagnostics inspect blocked linkage without authorizing recovery: "+JSON.stringify(options),async()=>{
  const h=harness(options);const data=await h.service.diagnostics("2");
  assert.equal(data.readOnly,true);assert.equal(data.previewId,undefined);
  assert.equal(h.model.moves.length,0);assert.equal(h.model.backupCalls,0);assert.equal(h.model.commits,0);assert.equal(h.model.journal,null);
  assert.deepEqual(h.model.state,h.model.before);
  assert.doesNotMatch(JSON.stringify(data),/original-fls-id|helmet|skillPoints/);
  assert(h.model.trace.some(t=>t.name==="ROLLBACK"));
  assert(h.model.trace.filter(t=>typeof t.name==="string"&&t.name.startsWith("BEGIN")).every(t=>t.name.includes("READ ONLY")));
});
test("failed diagnostic read closes its read-only transaction without writes",async()=>{
  const h=harness({diagnosticFails:true});await assert.rejects(h.service.diagnostics("2"),/Diagnostic query failed/);
  assert(h.model.trace.some(t=>t.name==="ROLLBACK"));assert.equal(h.model.moves.length,0);assert.equal(h.model.commits,0);
});
test("travel diagnostics remain usable after recovery inspection is blocked",async()=>{
  const h=uiHarness();h.state.fail=true;await h.context.openCharacterRecovery();h.state.fail=false;
  await h.context.inspectCharacterTravel();assert.equal(h.element("playerRecoveryLocation").textContent,"Current Location: Arrakeen");
  assert.match(h.element("playerRecoveryDiagnosticStatus").textContent,/Pawn 6 \/ State: Travel/);
  assert.equal(h.element("playerRecoveryApplyButton").disabled,true);
  h.context.exportCharacterTravel();assert.equal(h.downloads.length,1);
  assert.equal(JSON.parse(h.downloads[0][2]).readOnly,true);
  assert.equal(h.calls.some(c=>c.options?.method==="POST"),false);
});
test("switching players prevents displaying or exporting a stale travel report",async()=>{
  const h=uiHarness();h.state.switchDuringDiagnostic=true;await h.context.inspectCharacterTravel();h.context.exportCharacterTravel();
  assert.equal(h.downloads.length,0);assert.equal(h.element("playerRecoveryExportButton").disabled,true);
});
test("travel diagnostic API uses the existing local-only boundary",()=>{
  const source=fs.readFileSync(path.join(__dirname,"../server.js"),"utf8");
  const start=source.indexOf('if (url.pathname === "/api/admin/players/recovery/diagnostics"');
  const endpoint=source.slice(start,source.indexOf('if (url.pathname === "/api/admin/players/recovery" && req.method === "POST")',start));
  assert.match(endpoint,/isRemotePortalRequest\(req\) \|\| !remoteAccess\.isLoopbackRequest\(req\)/);
  assert.match(endpoint,/403/);assert.match(endpoint,/characterRecovery\.diagnostics/);
});

for(const currentMap of ["Arrakeen","HarkoVillage"])test("isolated Travel pawn recovers from "+currentMap+" with state and protected data unchanged",async()=>{
 const h=harness({actorState:"Travel",currentMap});const preview=await h.service.inspect("2");const result=await h.service.recover({previewId:preview.previewId,confirmed:true});
 assert.equal(result.status,"verified");assert.equal(h.model.state.pawn.state,"Travel");assert.equal(h.model.state.pawn.map,"HaggaBasin");assert.equal(h.model.moves.length,1);assert.equal(h.model.commits,1);
 assert.deepEqual(h.model.state.pawn,{...h.model.before.pawn,map:"HaggaBasin",partition_id:"10",dimension_index:0,x:12,y:34,z:56});assert.deepEqual(h.model.state.links,h.model.before.links);
 const names=h.model.trace.map(x=>x.name);assert(names.includes("recovery-travel-loader"));assert(names.indexOf("recovery-pawn",names.indexOf("recovery-move"))<names.indexOf("COMMIT"),"Verify before commit");assert(names.lastIndexOf("recovery-pawn")>names.indexOf("COMMIT"),"Fresh readback after commit");
});
for(const [name,options,pattern] of [
 ["online Travel player",{onlineStatus:"Online"},/must be offline/],
 ["Travel controller",{controllerState:"Travel"},/Travel, migration/],
 ["Travel PlayerState",{playerStateState:"Travel"},/Travel, migration/],
 ["linked travel parent",{travelParents:[{id:"6",parent_id:"99"}]},/Travel, migration/],
 ["transfer import",{transferImport:{state:"Started"}},/Travel, migration/],
 ["changed Travel loader",{changedLoader:true},/full actor loader/],
 ["missing Travel loader",{missingLoader:true},/full actor loader/],
 ["ambiguous Travel loader",{ambiguousLoader:true},/full actor loader/]
])test(name+" remains blocked without writes",async()=>{const h=harness({actorState:"Travel",...options});await assert.rejects(h.service.inspect("2"),pattern);assert.equal(h.model.moves.length,0);assert.equal(h.model.backupCalls,0);assert.deepEqual(h.model.state,h.model.before);});
for(const options of [{stateChanged:true},{functionFails:true},{protectedPawnChanged:true},{badMap:true}])test("Travel recovery failure rolls back all changes: "+JSON.stringify(options),async()=>{const h=harness({actorState:"Travel",...options});const preview=await h.service.inspect("2");await assert.rejects(h.service.recover({previewId:preview.previewId,confirmed:true}));assert.equal(h.model.rollbacks,1);assert.equal(h.model.commits,0);assert.deepEqual(h.model.state,h.model.before);});
test("Default recovery does not require Travel-only loader compatibility",async()=>{const h=harness({missingLoader:true});const preview=await h.service.inspect("2");await h.service.recover({previewId:preview.previewId,confirmed:true});assert(!h.model.trace.some(x=>x.name==="recovery-travel-loader"));});

const manualTarget=(location={x:12,y:34,z:56})=>({map:"HaggaBasin",location,acceptUnverifiedHeight:true});
test("manual recovery accepts explicitly chosen coordinates without a safe preset",async()=>{
 const xyz={x:74346,y:233799,z:5000};const h=harness({actorState:"Travel",noPresets:true,manualCoordinates:xyz});const preview=await h.service.inspect("2",manualTarget(xyz));
 assert.equal(preview.destination.verifiedSafe,false);assert.equal(preview.destination.source,"administrator-coordinates");assert.equal(preview.destination.partitionId,"10");
 await assert.rejects(h.service.recover({previewId:preview.previewId,confirmed:true}),/unverified landing height/);assert.equal(h.model.moves.length,0);
 const result=await h.service.recover({previewId:preview.previewId,confirmed:true,acceptUnverifiedHeight:true,destination:{x:0,y:0,z:0}});assert.equal(result.status,"verified");
 assert.deepEqual(h.model.state.pawn,{...h.model.before.pawn,map:"HaggaBasin",partition_id:"10",dimension_index:0,...xyz});assert.deepEqual(h.model.state.links,h.model.before.links);assert.equal(h.model.journal.destination.verifiedSafe,false);
});
for(const [name,options,target,pattern] of [
 ["missing height acknowledgement",{}, {...manualTarget(),acceptUnverifiedHeight:false},/acknowledge/],
 ["wrong map",{}, {...manualTarget(),map:"Arrakeen"},/Hagga/],
 ["non-finite coordinate",{},manualTarget({x:12,y:34,z:NaN}),/finite/],
 ["out-of-bounds point",{outOfBounds:true},manualTarget(),/in-bounds/],
 ["missing partition",{manualPartitionMissing:true},manualTarget(),/exactly one valid/],
 ["ambiguous partition",{manualPartitionAmbiguous:true},manualTarget(),/exactly one valid/],
 ["partition dimension mismatch",{manualPartitionDimension:1},manualTarget(),/exactly one valid/],
 ["character dimension mismatch",{homeDimension:1},manualTarget(),/compatible character dimension/],
 ["online player",{onlineStatus:"Online"},manualTarget(),/must be offline/]
])test("manual recovery rejects "+name+" before any write",async()=>{const h=harness({noPresets:true,...options});await assert.rejects(h.service.inspect("2",target),pattern);assert.equal(h.model.moves.length,0);assert.equal(h.model.backupCalls,0);});
for(const options of [{functionFails:true},{badLocation:true},{stateChanged:true},{serverOnline:true},{backupFails:true}])test("manual recovery preserves protections: "+JSON.stringify(options),async()=>{const h=harness({actorState:"Travel",noPresets:true,...options});const preview=await h.service.inspect("2",manualTarget());await assert.rejects(h.service.recover({previewId:preview.previewId,confirmed:true,acceptUnverifiedHeight:true}));assert.equal(h.model.commits,0);assert.deepEqual(h.model.state,h.model.before);if(h.model.moves.length)assert.equal(h.model.rollbacks,1);});
test("manual recovery API is local-only and the confirmation never labels its height safe",()=>{const source=fs.readFileSync(path.join(__dirname,"../server.js"),"utf8");const endpoint=source.slice(source.indexOf('if (url.pathname === "/api/admin/players/recovery/preview"'),source.indexOf('if (url.pathname === "/api/admin/players/recovery" && req.method === "POST")'));assert.match(endpoint,/remoteAccess\.isLoopbackRequest/);assert.match(endpoint,/403/);assert.match(endpoint,/characterRecovery\.inspect/);assert.doesNotMatch(endpoint,/characterRecovery\.recover/);assert.match(source,/Landing height is unverified; offline recovery does not resolve safe ground/);});

test("manual UI confirms the selected player and unverified coordinates explicitly",async()=>{const h=uiHarness();for(const [key,value] of Object.entries({X:12,Y:34,Z:56}))h.element("recoveryManual"+key).value=String(value);h.element("recoveryManualAcknowledgement").checked=true;await h.context.previewManualCharacterRecovery();assert.match(h.element("playerRecoveryStatus").textContent,/Landing height is unverified/);await h.context.recoverSelectedCharacter();assert.match(h.calls.find(c=>c.confirmation).confirmation,/Test Player.*X 12, Y 34, Z 56.*height is unverified/);const posts=h.calls.filter(c=>c.options?.method==="POST");assert.deepEqual(JSON.parse(posts.at(-1).options.body),{previewId:"server-token",confirmed:true,acceptUnverifiedHeight:true});});
test("manual UI rejects missing acknowledgement and ignores a switched player",async()=>{const h=uiHarness();for(const key of ["X","Y","Z"])h.element("recoveryManual"+key).value="12";await h.context.previewManualCharacterRecovery();assert.equal(h.calls.length,0);h.element("recoveryManualAcknowledgement").checked=true;h.state.switchDuringDiagnostic=true;await h.context.previewManualCharacterRecovery();assert.equal(h.element("playerRecoveryApplyButton").disabled,true);await h.context.recoverSelectedCharacter();assert.equal(h.calls.filter(c=>c.url==="/api/admin/players/recovery").length,0);});
