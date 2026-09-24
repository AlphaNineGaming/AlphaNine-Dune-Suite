"use strict";
// Requires Bash and jq on PATH (BASH_EXE can override the Bash executable).
const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const source = fs.readFileSync(path.join(__dirname, "../assets/scheduler/alphanine-scheduler.sh"), "utf8").replace(/\r\n/g, "\n");
const functions = source.slice(source.indexOf("resolve_backup_path() {"), source.indexOf("run_restart() {"));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-storage-"));
const shellDir = scratch.replaceAll("\\", "/");
const storage = process.platform === "win32" ? shellDir.replace(/^([A-Za-z]):/, (_, drive) => "/" + drive.toLowerCase()) : shellDir;
const name = "alphanine-scheduled-20260924-000000.backup";
const operationName = "alphanine-dump-20260924-000000";
const bash = process.env.BASH_EXE || (process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash");
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
const fixture = () => ({
  databaseoperation: {metadata:{name:operationName, namespace:"ns", uid:"op"}, status:{phase:"Succeeded"}, spec:{action:"dump", battleGroup:"bg",backup:name}},
  pod: {metadata:{namespace:"ns",ownerReferences:[{kind:"DatabaseOperation",name:operationName,uid:"op"}]},status:{phase:"Succeeded"},spec:{containers:[{args:["--dump_path=/root/Saved/DatabaseDumps/"+name],volumeMounts:[{name:"data",mountPath:"root/Saved/DatabaseDumps/",subPath:"Saved/DatabaseDumps"}]}],volumes:[{name:"data",persistentVolumeClaim:{claimName:"claim"}}]}},
  pvc:{metadata:{name:"claim",namespace:"ns",uid:"claim-id"},status:{phase:"Bound"},spec:{volumeName:"pv"}},
  pv:{metadata:{name:"pv"},spec:{claimRef:{name:"claim",namespace:"ns",uid:"claim-id"},local:{path:storage}}}
});
function run(f, command, extra="") {
  for(const [kind,value] of Object.entries(f)) fs.writeFileSync(path.join(scratch,kind+".json"), JSON.stringify(value));
  const script = 'set -u; set -o pipefail; NAMESPACE=ns; BATTLEGROUP=bg; ROOT_DIR='+quote(shellDir)+'; STATE_FILE="$ROOT_DIR/state.json"; LOG_FILE="$ROOT_DIR/log"; BACKUP_DIR="";\n'+functions+
    'kubectl_safe() { if [ "$1" = apply ]; then return 0; fi; if [ "$2" = battlegroup ]; then printf "kind: Battlegroup\\n"; else cat "$ROOT_DIR/$2.json"; fi; }; sudo() { shift; "$@"; }; record_event() { printf "%s %s\\n" "$1" "$2" >> "$ROOT_DIR/events"; }; config_number() { printf %s "$2"; }; operation_conflict_reason() { :; }; date() { case "$1" in -u) printf 20260924-000000;; +%s) printf 2000000000;; *) printf 2026-09-24;; esac; }; state_update() { local filter="$1"; shift; jq "$@" "$filter" "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"; };\n'+extra+'\n'+command;
  return spawnSync(bash,["-s"],{input:script,encoding:"utf8",env:{...process.env,MSYS_NO_PATHCONV:"1"}});
}
try {
  const expected=storage+"/Saved/DatabaseDumps/"+name;
  let result=run(fixture(), 'resolve_backup_path '+operationName+' '+name);
  assert.equal(result.status,0,result.stderr); assert.equal(result.stdout.trim(),expected);
  const host=fixture(); host.pv.spec.hostPath=host.pv.spec.local; delete host.pv.spec.local;
  assert.equal(run(host,'resolve_backup_path '+operationName+' '+name).status,0);
  for(const mutate of [
    f=>f.databaseoperation.spec.battleGroup="other", f=>f.databaseoperation.status.phase="Running",
    f=>f.pod.metadata.ownerReferences[0].uid="other", f=>f.pod.status.phase="Running",
    f=>f.pod.spec.containers[0].args=["--dump_path=/root/Saved/DatabaseDumps/other.backup"],
    f=>f.pod.spec.containers[0].volumeMounts[0].subPath="../escape",
    f=>f.pod.spec.containers[0].volumeMounts[0].subPathExpr="dynamic",
    f=>f.pod.spec.containers.push(f.pod.spec.containers[0]),
    f=>f.pvc.status.phase="Pending", f=>f.pv.spec.claimRef.uid="other", f=>delete f.pv.spec.local,
    f=>f.pv.spec.local.path="/storage/../other"
  ]) {const f=fixture();mutate(f);result=run(f,'resolve_backup_path '+operationName+' '+name);assert.notEqual(result.status,0,JSON.stringify(f));}
  const dumps=path.join(scratch,"Saved/DatabaseDumps"); fs.mkdirSync(dumps,{recursive:true});
  fs.writeFileSync(path.join(scratch,"state.json"),"{}"); fs.writeFileSync(path.join(dumps,name),"dump");
  result=run(fixture(),'run_backup manual'); assert.equal(result.status,0,result.stderr);
  const state=JSON.parse(fs.readFileSync(path.join(scratch,"state.json")));assert.equal(state.lastSuccessfulBackupPath,expected);assert.equal(state.lastSuccessfulBackupEpoch,2000000000);assert(fs.statSync(path.join(dumps,name+".yaml")).size>0);
  assert.equal(run(fixture(),'backup_is_fresh').status,0);
  assert.notEqual(run(fixture(),'BATTLEGROUP=other; backup_is_fresh').status,0);
  fs.unlinkSync(path.join(dumps,name+".yaml")); assert.notEqual(run(fixture(),'backup_is_fresh').status,0);
  result=run(fixture(),'run_backup manual', 'kubectl_safe() { if [ "$1" = apply ]; then return 0; fi; if [ "$2" = battlegroup ]; then return 1; fi; cat "$ROOT_DIR/$2.json"; };');
  assert.notEqual(result.status,0,"Failed recovery manifest must fail the backup");
  // Retention must prune only scheduler-named dumps inside the resolved storage directory.
  fs.writeFileSync(path.join(dumps,name+".yaml"),"manifest");
  const old="alphanine-scheduled-20200101-000000.backup";
  for(const suffix of ["", ".yaml"]) fs.writeFileSync(path.join(dumps,old+suffix),"old");
  fs.utimesSync(path.join(dumps,old),new Date(0),new Date(0));
  fs.writeFileSync(path.join(dumps,"manual.backup"),"manual");
  fs.writeFileSync(path.join(scratch,old),"outside");
  result=run(fixture(),'BACKUP_DIR='+quote(storage+'/Saved/DatabaseDumps')+'; prune_backups','config_number() { printf 1; };');
  assert.equal(result.status,0,result.stderr); assert(!fs.existsSync(path.join(dumps,old))); assert(!fs.existsSync(path.join(dumps,old+".yaml")));
  assert(fs.existsSync(path.join(dumps,name))); assert(fs.existsSync(path.join(dumps,"manual.backup"))); assert(fs.existsSync(path.join(scratch,old)));
  fs.unlinkSync(path.join(dumps,name)); assert.notEqual(run(fixture(),'backup_is_fresh').status,0);
  fs.writeFileSync(path.join(scratch,"state.json"),"{}");
  result=run(fixture(),'run_backup manual');assert.notEqual(result.status,0);assert.equal(JSON.parse(fs.readFileSync(path.join(scratch,"state.json"))).lastSuccessfulBackupEpoch,undefined);
  fs.writeFileSync(path.join(dumps,name),""); assert.notEqual(run(fixture(),'run_backup manual').status,0);
  console.log("Scheduler backup storage resolution, ownership, binding, missing/empty artifacts, recovery manifest and restart freshness tests passed.");
} finally {fs.rmSync(scratch,{recursive:true,force:true});}
