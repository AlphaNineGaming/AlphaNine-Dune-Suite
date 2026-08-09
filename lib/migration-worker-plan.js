"use strict";

const crypto = require("crypto");
const { DROP_DUNE_SCHEMA_SQL, DUNE_RESTORE_FLAGS, DUNE_RUNTIME_ROLE_VERIFY_SQL } = require("./migration-schema-restore");

const POD = Object.freeze({
  credential: "/tmp/alphanine-migration-worker.pgpass", credentialNext: "/tmp/alphanine-migration-worker.pgpass.next",
  credentialScript: "/tmp/alphanine-migration-worker-credential.sh", world: "/tmp/alphanine-migration-worker-world.dump",
  rollback: "/tmp/alphanine-migration-worker-rollback.dump", restoreSql: "/tmp/alphanine-migration-worker-restore.sql",
  resetSql: "/tmp/alphanine-migration-worker-reset.sql", runtimeRoleVerifySql: "/tmp/alphanine-migration-worker-runtime-role-verify.sql",
  failureSql: "/tmp/alphanine-migration-worker-injected-failure.sql"
});

function safeName(value, label) {
  const text=String(value||""); if(!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(text))throw new Error(`${label} is unsafe.`);return text;
}
function safePath(value,label){const text=String(value||"");if(!/^\/[A-Za-z0-9_./+-]+$/.test(text)||text.includes("/../"))throw new Error(`${label} is unsafe.`);return text;}
function shaText(value){return crypto.createHash("sha256").update(String(value),"utf8").digest("hex");}

function base(purpose, extra={}) { return { purpose, executable:"/usr/bin/sudo", arguments:[], expectedExit:0, timeoutSeconds:300, ...extra }; }
function kubectl(options,args,extra={}) { return base(extra.purpose||"Kubernetes migration command",{...extra,arguments:["-n",safePath(options.kubectlExecutable,"kubectl executable"),...args.map(String)]}); }
function execPod(options,args,extra={}){return kubectl(options,["exec","-n",options.target.namespace,options.target.dbPod,"--",...args],extra);}
function cpToPod(options,local,remote,purpose){return kubectl(options,["cp",local,`${options.target.namespace}/${options.target.dbPod}:${remote}`],{purpose,timeoutSeconds:900});}
function cpFromPod(options,remote,local,purpose){return kubectl(options,["cp",`${options.target.namespace}/${options.target.dbPod}:${remote}`,local],{purpose,timeoutSeconds:1800});}
function commandTest(purpose, extra={}){const {file,...rest}=extra;return {purpose,executable:"/usr/bin/test",arguments:["-f",file||"job.json"],expectedExit:0,timeoutSeconds:30,...rest};}

function credentialScript(dbSvc){
  return `#!/bin/sh\nset -eu\numask 077\nnext=${POD.credentialNext}\nfinal=${POD.credential}\nrm -f "$next"\ntrap 'rm -f "$next"' EXIT HUP INT TERM\n[ -n "${'${POSTGRES_PASSWORD:-}'}" ]\nprintf '%s:%s:%s:%s:%s\\n' ${JSON.stringify(dbSvc)} 15432 dune postgres "$POSTGRES_PASSWORD" > "$next"\nchmod 0600 "$next"\ntest -s "$next"\nmv -f "$next" "$final"\ntrap - EXIT HUP INT TERM\nprintf 'A9_MIGRATION_CREDENTIAL_READY\\n'\n`;
}

function writeWorkerPlanInputs(options={}) {
  const inputs=[
    {name:"credential.sh",content:credentialScript(options.target.dbSvc)},
    {name:"reset.sql",content:`${DROP_DUNE_SCHEMA_SQL}\n`},
    {name:"runtime-role-verify.sql",content:DUNE_RUNTIME_ROLE_VERIFY_SQL}
  ];
  for(const check of options.checks||[])inputs.push({name:check.file,content:String(check.sql||"")});
  inputs.push({name:"cleanup.sql",content:String(options.cleanupSql||"")});
  if(options.injectRestoreFailure)inputs.push({name:"injected-failure.sql",content:"DO $a9$ BEGIN RAISE EXCEPTION 'injected durable worker restore failure'; END $a9$;\n"});
  return inputs;
}

function assertion(check){
  if(check.expectedSha256)return {assertStdoutSha256:check.expectedSha256};
  return {assertEvidenceKind:check.kind||"exact-json",expectedEvidence:check.expected};
}

function sqlCommand(options, check, phase){
  return execPod(options,["env",`PGPASSFILE=${POD.credential}`,options.tools.psql,"--no-password","--quiet","--set=ON_ERROR_STOP=1","-h",options.target.dbSvc,"-p","15432","-U","postgres","-d","dune","-At",`--file=/tmp/alphanine-migration-worker-${check.file}`],{purpose:`${phase}: ${check.purpose}`,...assertion(check),timeoutSeconds:Math.max(30,Number(check.timeoutSeconds||300))});
}

function offlineCommands(options, prefix){
  const commands=[];
  for(let i=1;i<=2;i++){
    commands.push(kubectl(options,["get","igwbg","-n",options.target.namespace,options.target.name,"-o","json"],{purpose:`${prefix}: battlegroup sample ${i}`,stdoutFile:`${prefix}-battlegroup-${i}.json`,timeoutSeconds:60}));
    commands.push(kubectl(options,["get","pods,deployments,statefulsets","-n",options.target.namespace,"-o","json"],{purpose:`${prefix}: workload sample ${i}`,stdoutFile:`${prefix}-workloads-${i}.json`,timeoutSeconds:60}));
  }
  commands.push(commandTest(`${prefix}: classify two stable structured samples`,{file:`${prefix}-battlegroup-2.json`,validateOffline:{battlegroupFiles:[`${prefix}-battlegroup-1.json`,`${prefix}-battlegroup-2.json`],workloadFiles:[`${prefix}-workloads-1.json`,`${prefix}-workloads-2.json`],namespace:options.target.namespace,name:options.target.name}}));
  return commands;
}

function podInputSetup(options){
  const commands=[cpToPod(options,"credential.sh",POD.credentialScript,"Install fixed credential preparation script")];
  for(const check of options.checks||[])commands.push(cpToPod(options,check.file,`/tmp/alphanine-migration-worker-${check.file}`,`Install ${check.purpose} query`));
  commands.push(cpToPod(options,"cleanup.sql","/tmp/alphanine-migration-worker-cleanup.sql","Install destination cleanup transaction"));
  commands.push(cpToPod(options,"reset.sql",POD.resetSql,"Install fixed atomic dune reset SQL"));
  commands.push(cpToPod(options,"runtime-role-verify.sql",POD.runtimeRoleVerifySql,"Install fixed runtime-role ownership and access verification SQL"));
  if(options.injectRestoreFailure)commands.push(cpToPod(options,"injected-failure.sql",POD.failureSql,"Install injected restore failure fixture"));
  commands.push(execPod(options,["chmod","0600",POD.credentialScript,POD.resetSql,POD.runtimeRoleVerifySql,"/tmp/alphanine-migration-worker-cleanup.sql",...(options.checks||[]).map(c=>`/tmp/alphanine-migration-worker-${c.file}`),...(options.injectRestoreFailure?[POD.failureSql]:[])],{purpose:"Apply restrictive pod input permissions"}));
  commands.push(execPod(options,["/bin/sh",POD.credentialScript],{purpose:"Prepare non-interactive PostgreSQL credentials",expectedStdoutFirstField:"A9_MIGRATION_CREDENTIAL_READY"}));
  commands.push(execPod(options,["stat","-c","%a",POD.credential],{purpose:"Verify credential permissions",expectedStdoutFirstField:"600"}));
  return commands;
}

function checkpointCommands(options, phase, selected){return (options.checks||[]).filter(c=>(c.phases||[]).includes(selected)).map(c=>sqlCommand(options,c,phase));}

function backupCommands(options){
  return [
    execPod(options,["env",`PGPASSFILE=${POD.credential}`,options.tools.pgDump,"--no-password","--format=custom","--no-owner","--no-privileges",`--file=${POD.rollback}`,"-h",options.target.dbSvc,"-p","15432","-U","postgres","-d","dune"],{purpose:"Create complete destination rollback archive",timeoutSeconds:7200}),
    execPod(options,["chmod","0600",POD.rollback],{purpose:"Restrict rollback archive permissions"}),
    execPod(options,["head","-c","5",POD.rollback],{purpose:"Verify rollback PGDMP signature",expectedStdoutFirstField:"PGDMP"}),
    execPod(options,[options.tools.pgRestore,"--list",POD.rollback],{purpose:"Validate complete rollback archive TOC",stdoutFile:"rollback.toc",validateTocProfile:"full-database",timeoutSeconds:1200}),
    execPod(options,[options.tools.pgRestore,"--file=/dev/null",POD.rollback],{purpose:"Read and decompress complete rollback archive",timeoutSeconds:7200}),
    cpFromPod(options,POD.rollback,"rollback.dump.partial","Download rollback archive to a restrictive partial file"),
    commandTest("Record downloaded rollback candidate identity",{file:"rollback.dump.partial",recordFileIdentity:"rollback.dump.partial",recordAs:"rollbackCandidate"}),
    execPod(options,["sha256sum",POD.rollback],{purpose:"Match pod and downloaded rollback hashes",assertStdoutArtifactHash:"rollbackCandidate"}),
    execPod(options,["stat","-c","%s",POD.rollback],{purpose:"Match pod and downloaded rollback sizes",assertStdoutArtifactSize:"rollbackCandidate"}),
    {purpose:"Publish verified durable rollback archive atomically",executable:"/bin/mv",arguments:["-f","rollback.dump.partial","rollback.dump"],expectedExit:0,timeoutSeconds:300},
    commandTest("Record published rollback archive identity",{file:"rollback.dump",recordFileIdentity:"rollback.dump",recordAs:"rollbackBackup"})
  ];
}

function reuseBackupCommands(options){
  const commands=[];
  const tocName=options.reuseTocName||"rollback-reuse.toc";
  if(options.reuseRollbackSource)commands.push({purpose:"Copy checkpoint-bound rollback backup into the new durable job",executable:"/bin/cp",arguments:[safePath(options.reuseRollbackSource,"reusable rollback source"),"rollback.dump"],expectedExit:0,timeoutSeconds:1800});
  return [...commands,
    commandTest("Reverify checkpoint-bound reusable rollback identity",{file:"rollback.dump",assertFiles:[options.reuseRollback],recordFileIdentity:"rollback.dump",recordAs:"rollbackBackup"}),
    cpToPod(options,"rollback.dump",POD.rollback,"Stage checkpoint-bound reusable rollback archive"),
    execPod(options,["chmod","0600",POD.rollback],{purpose:"Restrict reusable rollback permissions"}),
    execPod(options,["head","-c","5",POD.rollback],{purpose:"Verify reusable rollback PGDMP signature",expectedStdoutFirstField:"PGDMP"}),
    execPod(options,[options.tools.pgRestore,"--list",POD.rollback],{purpose:"Revalidate reusable rollback archive TOC",stdoutFile:tocName,validateTocProfile:"full-database",timeoutSeconds:1200}),
    execPod(options,[options.tools.pgRestore,"--file=/dev/null",POD.rollback],{purpose:"Read and decompress reusable rollback archive",timeoutSeconds:7200}),
    execPod(options,["sha256sum",POD.rollback],{purpose:"Match reusable pod and durable rollback hashes",assertStdoutArtifactHash:"rollbackBackup"}),
    execPod(options,["stat","-c","%s",POD.rollback],{purpose:"Match reusable pod and durable rollback sizes",assertStdoutArtifactSize:"rollbackBackup"})
  ];
}

function packageArchiveCommands(options){
  return [
    cpToPod(options,"world.dump",POD.world,"Stage verified package world archive in database pod"),
    execPod(options,["chmod","0600",POD.world],{purpose:"Restrict package archive permissions"}),
    execPod(options,["sha256sum",POD.world],{purpose:"Match staged package archive hash",expectedStdoutFirstField:options.world.sha256}),
    execPod(options,["stat","-c","%s",POD.world],{purpose:"Match staged package archive size",expectedStdoutFirstField:options.world.size}),
    execPod(options,["head","-c","5",POD.world],{purpose:"Verify package archive PGDMP signature",expectedStdoutFirstField:"PGDMP"}),
    execPod(options,[options.tools.pgRestore,"--list",POD.world],{purpose:"Validate exact dune-only package TOC",stdoutFile:"world.toc",validateTocProfile:"dune-only",timeoutSeconds:1200}),
    execPod(options,[options.tools.pgRestore,"--file=/dev/null",POD.world],{purpose:"Read and decompress complete package archive",timeoutSeconds:7200})
  ];
}

function generateRestoreCommands(options, archivePath, prefix){
  const archiveLocal=archivePath===POD.world?"world":"rollback";
  return [
    execPod(options,["rm","-f",POD.restoreSql],{purpose:`${prefix}: remove prior restore SQL`}),
    execPod(options,[options.tools.pgRestore,...DUNE_RESTORE_FLAGS,`--file=${POD.restoreSql}`,archivePath],{purpose:`${prefix}: generate matching-version dune restore SQL`,timeoutSeconds:3600}),
    execPod(options,["chmod","0600",POD.restoreSql],{purpose:`${prefix}: restrict restore SQL`}),
    cpFromPod(options,POD.restoreSql,`${archiveLocal}-restore.sql`,`${prefix}: download restore SQL once for worker validation`),
    commandTest(`${prefix}: validate restore SQL locally`,{file:`${archiveLocal}-restore.sql`,recordFileIdentity:`${archiveLocal}-restore.sql`,recordAs:`${archiveLocal}RestoreSql`,validateRestoreSql:`${archiveLocal}-restore.sql`}),
    execPod(options,["sha256sum",POD.restoreSql],{purpose:`${prefix}: reverify unchanged remote restore SQL hash`,assertStdoutArtifactHash:`${archiveLocal}RestoreSql`}),
    execPod(options,["stat","-c","%s",POD.restoreSql],{purpose:`${prefix}: reverify unchanged remote restore SQL size`,assertStdoutArtifactSize:`${archiveLocal}RestoreSql`})
  ];
}

function atomicRestoreCommand(options,prefix){
  const args=["env",`PGPASSFILE=${POD.credential}`,options.tools.psql,"--no-password","--single-transaction","--set=ON_ERROR_STOP=1","-h",options.target.dbSvc,"-p","15432","-U","postgres","-d","dune",`--file=${POD.resetSql}`,`--file=${POD.restoreSql}`];
  if(options.injectRestoreFailure&&prefix==="Package restore")args.push(`--file=${POD.failureSql}`);
  args.push(`--file=${POD.runtimeRoleVerifySql}`);
  return execPod(options,args,{purpose:`${prefix}: atomically replace dune schema`,timeoutSeconds:7200});
}

function cleanupCommands(options){
  const remote=[POD.credential,POD.credentialNext,POD.credentialScript,POD.world,POD.rollback,POD.restoreSql,POD.resetSql,POD.runtimeRoleVerifySql,POD.failureSql,"/tmp/alphanine-migration-worker-cleanup.sql",...(options.checks||[]).map(c=>`/tmp/alphanine-migration-worker-${c.file}`)];
  const local=["migration-package.a9migration","alphanine-migration-worker","world.dump","rollback.dump.partial","credential.sh","reset.sql","runtime-role-verify.sql","cleanup.sql","injected-failure.sql","world.toc","rollback.toc","rollback-reuse.toc","rollback-reverify.toc","world-restore.sql","rollback-restore.sql",...(options.checks||[]).map(c=>c.file)];
  for(const prefix of ["pre","final","rollback"])for(let i=1;i<=2;i++)local.push(`${prefix}-battlegroup-${i}.json`,`${prefix}-workloads-${i}.json`);
  return [execPod(options,["rm","-f",...remote],{purpose:"Remove all fixed pod migration temporary files",timeoutSeconds:300}),...remote.map(remotePath=>execPod(options,["test","!","-e",remotePath],{purpose:"Verify fixed pod temporary file absence"})),{purpose:"Remove uploaded package and local worker temporary components",executable:"/bin/rm",arguments:["-f",...local],expectedExit:0,timeoutSeconds:300},...local.map(file=>({purpose:"Verify local worker temporary file absence",executable:"/usr/bin/test",arguments:["!","-e",file],expectedExit:0,timeoutSeconds:30}))];
}

function buildMigrationWorkerPlan(options={}){
  options={...options,target:{...options.target,namespace:safeName(options.target?.namespace,"namespace"),name:safeName(options.target?.name,"battlegroup"),dbPod:safeName(options.target?.dbPod,"database pod"),dbSvc:safeName(options.target?.dbSvc,"database service")},kubectlExecutable:safePath(options.kubectlExecutable,"kubectl executable"),tools:{pgDump:safePath(options.tools?.pgDump,"pg_dump"),pgRestore:safePath(options.tools?.pgRestore,"pg_restore"),psql:safePath(options.tools?.psql,"psql")}};
  const stages=[
    {name:"offline-precheck",detail:"Proving the destination remains stopped",commands:offlineCommands(options,"pre")},
    {name:"preparing-pod",detail:"Installing verified fixed worker inputs",commands:podInputSetup(options)},
    {name:"destination-checkpoint",detail:"Revalidating the exact destination checkpoint",commands:checkpointCommands(options,"Pre-backup checkpoint","pre")},
    {name:"rollback-backup",detail:options.reuseRollback?"Reverifying the checkpoint-bound durable rollback backup":"Creating and fully verifying the durable rollback backup",commands:options.reuseRollback?reuseBackupCommands(options):backupCommands(options)},
    {name:"package-archive-verification",detail:"Verifying the package archive locally in the database pod",commands:packageArchiveCommands(options)},
    {name:"restore-sql-generation",detail:"Generating and locally validating restore SQL",commands:generateRestoreCommands(options,POD.world,"Package restore")},
    {name:"atomic-package-restore",detail:"Atomically replacing the dune schema",modificationBegins:true,commands:[atomicRestoreCommand(options,"Package restore")]},
    {name:"post-restore-verification",detail:"Verifying the restored package boundary",commands:checkpointCommands(options,"Post-restore verification","restored")},
    {name:"destination-market-cleanup",detail:"Removing active market listings transactionally",commands:[execPod(options,["env",`PGPASSFILE=${POD.credential}`,options.tools.psql,"--no-password","--quiet","--set=ON_ERROR_STOP=1","-h",options.target.dbSvc,"-p","15432","-U","postgres","-d","dune","-At","--file=/tmp/alphanine-migration-worker-cleanup.sql"],{purpose:"Execute exact destination market cleanup transaction",assertEvidenceKind:"exact-json",expectedEvidence:options.cleanupExpected,timeoutSeconds:1800})]},
    {name:"final-verification",detail:"Verifying imported entities, relationships, extensions, and market boundary",commands:[...checkpointCommands(options,"Final destination verification","final"),...offlineCommands(options,"final")]}
  ];
  const rollbackStages=[
    {name:"rollback-archive-reverification",detail:"Reverifying the checkpoint-bound rollback archive",commands:reuseBackupCommands({...options,reuseRollbackSource:"",reuseTocName:"rollback-reverify.toc",reuseRollback:options.reuseRollback||{path:"rollback.dump",size:"0",sha256:"0".repeat(64)}}).map((command,index)=>index===0?commandTest("Reverify current rollback artifact before automatic use",{file:"rollback.dump",recordFileIdentity:"rollback.dump",recordAs:"rollbackBackup"}):command)},
    {name:"rollback-sql-generation",detail:"Generating and validating rollback SQL",commands:generateRestoreCommands(options,POD.rollback,"Automatic rollback")},
    {name:"atomic-rollback",detail:"Atomically restoring the original dune schema",commands:[atomicRestoreCommand({...options,injectRestoreFailure:false},"Automatic rollback")]},
    {name:"rollback-verification",detail:"Verifying the exact pre-import checkpoint",commands:[...checkpointCommands(options,"Rollback checkpoint verification","pre"),...offlineCommands(options,"rollback")]}
  ];
  return {options,inputs:writeWorkerPlanInputs(options),stages,rollbackStages,cleanup:cleanupCommands(options),podPaths:POD};
}

module.exports={POD,buildMigrationWorkerPlan,credentialScript,writeWorkerPlanInputs};
