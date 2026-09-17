'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const TABLES = ['alphanine_market_bot_cycles','alphanine_market_bot_listings','alphanine_market_bot_audit','alphanine_market_bot_cycle_evidence'];
const SEQUENCE = 'alphanine_market_bot_audit_id_seq';
const ERROR = /must be able to SET ROLE "postgres"/;
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const ident = value => '"' + String(value).replaceAll('"','""') + '"';
const inventorySql = `SELECT json_build_object('databaseOwner',pg_get_userbyid((SELECT datdba FROM pg_database WHERE datname=current_database())), 'objects',COALESCE((SELECT json_agg(json_build_object('name',c.relname,'kind',c.relkind,'owner',pg_get_userbyid(c.relowner))) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN (${[...TABLES,SEQUENCE].map(quote).join(',')}) AND c.relkind IN ('r','S')), '[]'::json));`;
function repairPlan(inventory) {
  if(inventory.databaseOwner !== 'dune') throw Error('The game database owner is not dune. This targeted repair does not apply.');
  const objects = inventory.objects || [];
  if(objects.some(o => !['dune','postgres'].includes(o.owner))) throw Error('Custom tables have an unexpected owner. Manual review is required.');
  return objects.filter(o => o.owner === 'postgres').map(o => {
    if(!(TABLES.includes(o.name) && o.kind==='r') && !(o.name===SEQUENCE && o.kind==='S')) throw Error('Unexpected repair object.');
    return {...o,sql:`ALTER ${o.kind==='S'?'SEQUENCE':'TABLE'} public.${ident(o.name)} OWNER TO dune;`};
  });
}
function createOwnershipRepair({sshCommand, getTarget, directory, update=()=>{}, sleep=ms=>new Promise(r=>setTimeout(r,ms))}) {
  const selected = getTarget();
  if(!selected?.name || selected.namespace !== 'funcom-seabass-'+selected.name) throw Error('Select a valid battlegroup first.');
  const identity=JSON.stringify(selected);
  const ns=selected.namespace;
  const k='sudo -n kubectl -n '+quote(ns);
  function checkTarget(){if(JSON.stringify(getTarget())!==identity)throw Error('Selected battlegroup changed; repair stopped.');}
  async function command(text,timeout=30000,maxBuffer=4*1024*1024){
    checkTarget();
    const result=await sshCommand(text,timeout,{maxBuffer});
    if(!result.ok)throw Error(result.stderr||result.error||result.stdout||'VM command failed.');
    checkTarget();return String(result.stdout||'').trim();
  }
  async function snapshot(){
    const bg=JSON.parse(await command(k+' get battlegroup '+quote(selected.name)+' -o json'));
    const deployments=JSON.parse(await command(k+' get databasedeployments -o json')).items||[];
    const matches=deployments.filter(d=>d.metadata?.name===selected.name+'-db-dbdepl');
    if(matches.length!==1)throw Error('Could not identify exactly one game database deployment.');
    const db=matches[0];
    const pods=JSON.parse(await command(k+' get pods -o json')).items||[];
    return {bg,db,pods};
  }
  function noGameProcesses(state){
    if(state.pods.some(p=>p.metadata?.labels?.role==='igw-server' && !['Succeeded','Failed'].includes(p.status?.phase))) {
      throw Error('Game processes are active. This repair only runs when the database update has blocked server startup.');
    }
  }
  function databasePod(state){
    const matches=state.pods.filter(p=>p.metadata?.labels?.role==='igw-database' && p.status?.phase==='Running' && p.metadata?.name===state.db.metadata.name+'-sts-0');
    if(matches.length!==1)throw Error('The PostgreSQL pod is not running or is ambiguous.');
    return matches[0];
  }
  function failedPod(state){
    const matches=state.pods.filter(p=>p.status?.phase==='Failed' && p.metadata?.name?.startsWith(state.db.metadata.name+'-util-'));
    if(matches.length!==1)throw Error('Could not identify one failed database migration. Export operator logs for diagnosis.');
    return matches[0];
  }
  async function inspect(){
    const state=await snapshot();
    if(state.db.status?.phase==='Ready')return {needed:false,message:'No repair needed. The database is already Ready.'};
    noGameProcesses(state);
    const pod=databasePod(state),failed=failedPod(state);
    const log=await command(k+' logs '+quote(failed.metadata.name)+' --tail=200');
    if(!ERROR.test(log))throw Error('The failed migration does not contain the supported SET ROLE postgres error. No changes were made.');
    const port=Number(String(state.db.status?.address||'').split(':').pop());
    if(!Number.isInteger(port)||port<1||port>65535)throw Error('Database port could not be determined.');
    const exec=k+' exec '+quote(pod.metadata.name)+' -- ';
    const psql=exec+'psql -X -U postgres -p '+port+' -d dune -v ON_ERROR_STOP=1 -Atc ';
    const plan=repairPlan(JSON.parse(await command(psql+quote(inventorySql))));
    if(!plan.length)throw Error('No postgres-owned AlphaNine market-bot objects were found. No changes were made.');
    return {needed:true,state,pod,failed,log,port,exec,psql,plan};
  }
  async function run(){
    update('Checking database','Looking for the supported database migration failure.');
    const evidence=await inspect();
    if(!evidence.needed)return {ok:true,changed:false,message:evidence.message};
    const {exec,port}=evidence;
    const id='database-ownership-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomBytes(4).toString('hex');
    fs.mkdirSync(directory,{recursive:true});
    const dumpPath=path.join(directory,id+'.dump');
    const reportPath=path.join(directory,id+'.json');
    const remote='/tmp/'+id+'.dump';
    const report={createdAt:new Date().toISOString(),battlegroup:selected,objects:evidence.plan.map(({name,kind,owner})=>({name,kind,owner})),backupPath:dumpPath,remoteBackupPath:remote,status:'backing-up'};
    const save=()=>fs.writeFileSync(reportPath,JSON.stringify(report,null,2),{mode:0o600});
    save();
    try{
      update('Creating backup','Creating and validating a complete database backup before repair.');
      await command(exec+'sh -c '+quote('umask 077; pg_dump -U postgres -p '+port+' -d dune -Fc -f '+quote(remote)+' && pg_restore --file=/dev/null '+quote(remote)),240000);
      update('Verifying backup','Validating the archive and calculating its checksum.');
      const hash=(await command(exec+'sha256sum '+quote(remote))).split(/\s+/)[0];
      const size=Number(await command(exec+'stat -c %s '+quote(remote)));
      if(!/^[a-f0-9]{64}$/.test(hash)||!Number.isSafeInteger(size)||size<5||size>64*1024*1024)throw Error('Backup is invalid or exceeds the 64 MB repair transfer limit. No ownership changes were made.');
      update('Saving backup','Copying the verified backup to local storage.');
      const encoded=await command(exec+'base64 '+quote(remote),240000,96*1024*1024);
      const buffer=Buffer.from(encoded.replace(/\s/g,''),'base64');
      if(buffer.length!==size||buffer.subarray(0,5).toString()!=='PGDMP'||crypto.createHash('sha256').update(buffer).digest('hex')!==hash)throw Error('Backup transfer verification failed. No ownership changes were made.');
      fs.writeFileSync(dumpPath,buffer,{flag:'wx',mode:0o600});
      if(crypto.createHash('sha256').update(fs.readFileSync(dumpPath)).digest('hex')!==hash)throw Error('Local backup checksum failed.');
      report.sha256=hash;report.backupVerified=true;report.status='backed-up';save();
      fs.writeFileSync(path.join(directory,id+'.migration.log'),evidence.log,{mode:0o600});
      update('Rechecking database','Verifying that the database and failed migration have not changed.');
      const current=await inspect();
      if(!current.needed || current.state.db.metadata.uid!==evidence.state.db.metadata.uid || current.pod.metadata.uid!==evidence.pod.metadata.uid || current.failed.metadata.uid!==evidence.failed.metadata.uid || JSON.stringify(current.plan)!==JSON.stringify(evidence.plan))throw Error('Database state changed after backup; repair stopped safely.');
      update('Repairing ownership','Updating the affected AlphaNine table and sequence owners.');
      await command(evidence.psql+quote('BEGIN; SET LOCAL lock_timeout=\'5s\'; '+evidence.plan.map(o=>o.sql).join(' ')+' COMMIT;'));
      report.status='ownership-repaired';save();
      const verified=repairPlan(JSON.parse(await command(evidence.psql+quote(inventorySql))));
      if(verified.length)throw Error('Ownership verification failed. The backup has been retained.');
      const latest=await snapshot();noGameProcesses(latest);
      if(latest.db.metadata.uid!==evidence.state.db.metadata.uid)throw Error('Database deployment changed before retry.');
      const failed=failedPod(latest);
      if(failed.metadata.uid!==evidence.failed.metadata.uid)throw Error('The failed migration changed before retry.');
      update('Retrying migration','Ownership repaired. Retrying the failed database migration.');
      const deleteOptions=JSON.stringify({apiVersion:'v1',kind:'DeleteOptions',preconditions:{uid:failed.metadata.uid}});
      await command('printf %s '+quote(deleteOptions)+' | sudo -n kubectl delete --raw '+quote('/api/v1/namespaces/'+ns+'/pods/'+failed.metadata.name)+' -f -');
      report.status='migration-retrying';save();
      update('Waiting for database','Migration is running. Waiting for the database to become Ready.');
      for(let i=0;i<36;i++){
        await sleep(5000);
        const state=await snapshot();
        if(state.db.metadata.uid!==evidence.state.db.metadata.uid)throw Error('Database deployment changed during verification.');
        if(state.db.status?.phase==='Ready'){
          report.status='complete';report.schema=state.db.status.schema;save();
          return {ok:true,changed:true,message:'Database repair completed. The database is Ready; the battlegroup can resume its requested startup.',backupPath:dumpPath,reportPath};
        }
        if(state.pods.some(p=>p.status?.phase==='Failed'&&p.metadata?.name?.startsWith(state.db.metadata.name+'-util-')))throw Error('Ownership repaired, but the migration failed again. Export fresh logs; the backup and repair report are retained.');
      }
      throw Error('Ownership repaired and migration retried, but database readiness was not confirmed within three minutes. Check server status before retrying.');
    }catch(error){report.error=error.message;report.failedAt=new Date().toISOString();save();throw Error(error.message+' Repair report: '+reportPath);}
  }
  return {inspect,run};
}
module.exports={createOwnershipRepair,repairPlan,inventorySql,TABLES,SEQUENCE};
