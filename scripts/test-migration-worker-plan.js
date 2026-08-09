"use strict";

const assert=require("assert");
const {buildMigrationWorkerPlan}=require("../lib/migration-worker-plan");

const digest="a".repeat(64);
const options={
  target:{namespace:"test-ns",name:"test-bg",dbPod:"postgres-0",dbSvc:"postgres"},kubectlExecutable:"/usr/bin/kubectl",
  tools:{pgDump:"/usr/bin/pg_dump",pgRestore:"/usr/bin/pg_restore",psql:"/usr/bin/psql"},world:{size:"1200",sha256:digest},
  cleanupSql:"BEGIN; SELECT '{}'::jsonb; COMMIT;",cleanupExpected:{committed:true,deletedListings:"0",deletedSellRows:"0",deletedItems:"0",completedHistory:"0",completedHistoryDigest:digest},
  checks:[
    {file:"writers.sql",purpose:"writers",sql:"SELECT '{}'::jsonb;",kind:"exact-json",expected:{unexpectedActiveClients:"0",openTransactions:"0"},phases:["pre","restored","final"]},
    {file:"relationships.sql",purpose:"relationships",sql:"SELECT '{}'::jsonb;",kind:"relationship",expected:{foreignKeyCount:"5",invalidForeignKeys:"0",sha256:digest},phases:["restored","final"]}
  ]
};

const plan=buildMigrationWorkerPlan(options);
assert(plan.stages.some(s=>s.name==="rollback-backup"));
assert(plan.stages.some(s=>s.name==="atomic-package-restore"&&s.modificationBegins===true));
assert(plan.rollbackStages.some(s=>s.name==="atomic-rollback"));
const commands=[...plan.stages,...plan.rollbackStages].flatMap(stage=>stage.commands).concat(plan.cleanup);
assert(commands.every(command=>new Set(["/usr/bin/sudo","/usr/bin/test","/bin/rm","/bin/mv","/bin/cp"]).has(command.executable)));
assert(commands.every(command=>!command.arguments.some(argument=>/\bssh\b|powershell|encodedcommand/i.test(argument))));
assert(commands.every(command=>!command.arguments.some(argument=>argument.includes("DROP SCHEMA")||argument.includes("SELECT "))));
const dumps=commands.filter(command=>command.arguments.includes("/usr/bin/pg_dump"));assert.equal(dumps.length,1);assert(dumps[0].arguments.includes("--file=/tmp/alphanine-migration-worker-rollback.dump"));
const restores=commands.filter(command=>command.arguments.includes("/usr/bin/pg_restore"));assert(restores.length>=6);
const atomic=commands.filter(command=>command.arguments.includes("--single-transaction"));assert.equal(atomic.length,2);assert(atomic.every(command=>command.arguments.includes("--file=/tmp/alphanine-migration-worker-reset.sql")&&command.arguments.includes("--file=/tmp/alphanine-migration-worker-restore.sql")&&command.arguments.includes("--file=/tmp/alphanine-migration-worker-runtime-role-verify.sql")));
assert(atomic.every(command=>command.arguments.indexOf("--file=/tmp/alphanine-migration-worker-restore.sql")<command.arguments.indexOf("--file=/tmp/alphanine-migration-worker-runtime-role-verify.sql")));
assert(plan.inputs.find(input=>input.name==="reset.sql").content.includes("SET ROLE dune;"));
assert(plan.inputs.find(input=>input.name==="runtime-role-verify.sql").content.includes("get_applied_patches()"));
assert(plan.cleanup.length>5);

const injected=buildMigrationWorkerPlan({...options,injectRestoreFailure:true});
const importPsql=injected.stages.find(s=>s.name==="atomic-package-restore").commands[0];assert(importPsql.arguments.includes("--file=/tmp/alphanine-migration-worker-injected-failure.sql"));
assert(!injected.rollbackStages.find(s=>s.name==="atomic-rollback").commands[0].arguments.includes("--file=/tmp/alphanine-migration-worker-injected-failure.sql"));

const reusable=buildMigrationWorkerPlan({...options,reuseRollback:{path:"rollback.dump",size:"99",sha256:"b".repeat(64)}});
assert(!reusable.stages.find(s=>s.name==="rollback-backup").commands.some(command=>command.arguments.includes("/usr/bin/pg_dump")));
assert(reusable.stages.find(s=>s.name==="rollback-backup").commands.some(command=>command.assertFiles?.[0]?.sha256==="b".repeat(64)));
console.log("Migration worker plan tests passed.");
