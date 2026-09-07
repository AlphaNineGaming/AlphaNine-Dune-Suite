"use strict";
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),os=require('os');
const {spawnSync}=require('child_process');
const {createUserGameRecovery,APPLY,SNAPSHOT}=require('../lib/user-game-recovery');
const python=process.env.PYTHON || 'python3';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'ini-recovery-test-'));
const template='/home/dune/.dune/download/scripts/setup/config/UserGame.ini';
const active='/var/lib/rancher/k3s/storage/pvc-one/UserGame.ini';
const engine=active.replace('UserGame','UserEngine');
const game='; custom comment\r\n[/Script/DuneSandbox.DuneGameMode]\r\nm_GlobalXPMultiplier=1.00\r\nm_GlobalHarvestHealthMultiplier=1.00\r\nUnknown=keep\r\n';
let fail=false,conflict=false,vm='one',calls=0;
const mapped=p=>path.join(root,Buffer.from(p).toString('hex'));
const originals=new Map([[template,game],[template.replace('UserGame','UserEngine'),'[URL]\nPort=12345\n'],[active,game.replace('m_GlobalHarvestHealthMultiplier=1.00','m_GlobalHarvestHealthMultiplier=4.00')+'m_GlobalHarvestAmountMultiplier=5.00\r\nPartitionSetting=yes\r\n'],[engine,'[URL]\r\nPort=23456\r\nIGWPort=34567\r\n']]);
for(const [p,text] of originals) fs.writeFileSync(mapped(p),text);
const directory=path.join(root,'backups');
const recovery=createUserGameRecovery({directory,quote:s=>s,target:()=>vm,sshCommand:async(command,timeout,options)=>{
 if(command.endsWith(SNAPSHOT)) return {ok:true,stdout:JSON.stringify([...originals.keys()].map(p=>({path:p,content:fs.readFileSync(mapped(p)).toString('base64')})))};
 calls++;
 assert(!command.includes('apply-default-usersettings'));
 const payload=JSON.parse(fs.readFileSync(options.inputPath,'utf8'));
 assert(fs.existsSync(path.join(path.dirname(options.inputPath),'backup.json')),'Backup must exist before writes');
 if(conflict) fs.appendFileSync(mapped(active),'concurrent edit');
 const translated=payload.map(row=>({...row,path:mapped(row.path)}));
 // Windows test adapter for POSIX locking/ownership. Actual byte checks,
 // atomic writes, verification and rollback run through the production Python.
 let source=APPLY.replace("'/tmp/alphanine-usergame.lock'",JSON.stringify(path.join(root,'lock')));
 if(process.platform==='win32') source="import sys,types,os\nsys.modules['fcntl']=types.SimpleNamespace(flock=lambda *a:None,LOCK_EX=1,LOCK_NB=2)\nos.chown=lambda *a:None\n"+source;
 if(fail) source=source.replace("written.append(p); write(p,data)","written.append(p); write(p,data)\n  if len(written)==2: raise RuntimeError('injected second-file failure')");
 const result=spawnSync(python,['-c',source],{input:JSON.stringify(translated),encoding:'utf8'});
 return {ok:result.status===0,stdout:result.stdout,stderr:result.stderr||String(result.error||'')};
}});
(async()=>{
 const first=await recovery.save({m_GlobalXPMultiplier:2,m_GlobalHarvestHealthMultiplier:1},game);
 assert.equal(first.changedFiles.length,2);
 for(const p of [template,active]) {const text=fs.readFileSync(mapped(p),'utf8');assert(text.includes('m_GlobalXPMultiplier=2.00'));assert(text.includes('Unknown=keep'));}
 assert(fs.readFileSync(mapped(active),'utf8').includes('PartitionSetting=yes'));
 assert(fs.readFileSync(mapped(active),'utf8').includes('m_GlobalHarvestHealthMultiplier=4.00'),'Unedited per-map settings must survive form saves');
 assert.equal(fs.readFileSync(mapped(engine),'utf8'),originals.get(engine));
 assert.equal(recovery.list().length,1);
 assert.equal(recovery.read(first.backupId).files.length,4);
 const noChange=await recovery.save({m_GlobalXPMultiplier:2});assert.equal(noChange.changedFiles.length,0);assert.equal(calls,1);
 await assert.rejects(recovery.save({m_GlobalXPMultiplier:3},game),/changed since/);
 const before=fs.readFileSync(mapped(template)); fail=true;
 await assert.rejects(recovery.save({m_GlobalXPMultiplier:3}),/rollback completed/);fail=false;
 assert.deepEqual(fs.readFileSync(mapped(template)),before);
 assert(fs.readFileSync(mapped(active),'utf8').includes('m_GlobalXPMultiplier=2.00'));
 conflict=true;await assert.rejects(recovery.save({m_GlobalXPMultiplier:3}),/changed since backup/);conflict=false;
 assert.deepEqual(fs.readFileSync(mapped(template)),before);
 await recovery.restore(first.backupId,'UserGame.ini');
 assert.equal(fs.readFileSync(mapped(template),'utf8'),game);
 assert.equal(fs.readFileSync(mapped(active),'utf8'),originals.get(active));
 fs.writeFileSync(mapped(engine),'[URL]\nPort=7777\n');
 await recovery.restore(first.backupId,'UserEngine.ini');
 assert.equal(fs.readFileSync(mapped(engine),'utf8'),originals.get(engine));
 vm='other';await assert.rejects(recovery.restore(first.backupId,'UserEngine.ini'),/different VM/);
 assert.throws(()=>recovery.read('../bad'),/Invalid backup/);
 console.log('INI recovery passed: custom ports, per-file preservation, local backups, no-op, stale edits, rollback, restore, and VM binding.');
})().finally(()=>fs.rmSync(root,{recursive:true,force:true})).catch(error=>{console.error(error);process.exitCode=1;});
