"use strict";
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { updateUserGameIni } = require('./user-game-settings');
const TEMPLATE = '/home/dune/.dune/download/scripts/setup/config/UserGame.ini';
const sha = content => crypto.createHash('sha256').update(Buffer.from(content, 'base64')).digest('hex');
// Read bytes without newline conversion. Only active INIs in the standard VM
// template directory and Kubernetes persistent volumes are in scope.
const SNAPSHOT = `import os,json,base64
paths=[${JSON.stringify(TEMPLATE)},${JSON.stringify(TEMPLATE.replace('UserGame','UserEngine'))}]
root='/var/lib/rancher/k3s/storage'
if not os.path.isdir(root): raise RuntimeError('Standard VM storage directory is missing; no files changed.')
def walk_error(error): raise error
for parent,dirs,files in os.walk(root,onerror=walk_error):
 for name in files:
  if name in ('UserGame.ini','UserEngine.ini'): paths.append(os.path.join(parent,name))
result=[]
for p in sorted(set(paths)):
 if os.path.islink(p): raise RuntimeError('Refusing symlink: '+p)
 with open(p,'rb') as f: data=f.read()
 result.append(dict(path=p,content=base64.b64encode(data).decode()))
if not any(x['path'].startswith(root+'/') and x['path'].endswith('/UserGame.ini') for x in result): raise RuntimeError('No active UserGame.ini found; no files changed.')
print(json.dumps(result))`;
const APPLY = `import os,json,base64,hashlib,tempfile,fcntl
payload=json.load(__import__('sys').stdin)
lock=open('/tmp/alphanine-usergame.lock','a')
fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
def write(p,data):
 st=os.stat(p)
 fd,tmp=tempfile.mkstemp(prefix='.alphanine-',dir=os.path.dirname(p))
 try:
  with os.fdopen(fd,'wb') as f:
   f.write(data); f.flush(); os.fsync(f.fileno())
  os.chown(tmp,st.st_uid,st.st_gid); os.chmod(tmp,st.st_mode & 0o7777)
  os.replace(tmp,p)
 finally:
  if os.path.exists(tmp): os.unlink(tmp)
original={}
for row in payload:
 p=row['path']
 if os.path.islink(p): raise RuntimeError('Refusing symlink: '+p)
 with open(p,'rb') as f: data=f.read()
 if hashlib.sha256(data).hexdigest()!=row['sha256']: raise RuntimeError('INI changed since backup; reload and retry: '+p)
 original[p]=data
written=[]
try:
 for row in payload:
  if 'replacement' not in row: continue
  p=row['path']; data=base64.b64decode(row['replacement'],validate=True)
  written.append(p); write(p,data)
  with open(p,'rb') as f:
   if f.read()!=data: raise RuntimeError('Verification failed: '+p)
except BaseException as error:
 failures=[]
 for p in reversed(written):
  try: write(p,original[p])
  except BaseException as rollback: failures.append(p+': '+str(rollback))
 raise RuntimeError(str(error)+'; rollback '+('; '.join(failures) if failures else 'completed'))
print(json.dumps(dict(ok=True,changed=len(written))))`;
function createUserGameRecovery({ directory, sshCommand, quote, target = () => "default" }) {
 let busy = false;
 const command = script => `sudo -n python3 -c ${quote(script)}`;
 async function snapshot() {
  const result = await sshCommand(command(SNAPSHOT), 45000, { maxBuffer: 16 * 1024 * 1024 });
  if (!result.ok) throw Error(result.stderr || result.error || 'Could not back up VM INIs.');
  return JSON.parse(result.stdout);
 }
 function list() {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(id => /^[0-9a-f-]{36}$/.test(id)).map(id => {
   try { const data = read(id); return { id, createdAt: data.createdAt, files: data.files.map(f => f.path) }; } catch { return null; }
  }).filter(Boolean).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
 }
 function read(id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw Error('Invalid backup ID.');
  return JSON.parse(fs.readFileSync(path.join(directory,id,'backup.json'),'utf8'));
 }
 function backup(files) {
  const id = crypto.randomUUID(), folder = path.join(directory,id);
  fs.mkdirSync(folder,{recursive:true});
  const record = { id, createdAt:new Date().toISOString(), target:target(), files:files.map(f => ({...f,sha256:sha(f.content)})) };
  const file = path.join(folder,'backup.json');
  fs.writeFileSync(file,JSON.stringify(record,null,2),{flag:'wx',mode:0o600});
  for (const [index,row] of record.files.entries()) {
   const copy=path.join(folder,String(index).padStart(3,'0')+'-'+path.posix.basename(row.path));
   fs.writeFileSync(copy,Buffer.from(row.content,'base64'),{flag:'wx',mode:0o600});
   if(fs.readFileSync(copy).toString('base64')!==row.content) throw Error('Local INI backup verification failed.');
  }
  const saved=read(id);
  for (const row of saved.files) if (sha(row.content)!==row.sha256) throw Error('Local backup verification failed.');
  return record;
 }
 async function apply(files, replacements) {
  const record=backup(files);
  const input=path.join(directory,record.id,'staged.json');
  try {
   fs.writeFileSync(input,JSON.stringify(record.files.map(f => ({path:f.path,sha256:f.sha256,...(replacements.has(f.path)?{replacement:replacements.get(f.path)}:{})}))),{mode:0o600});
   const result=await sshCommand(command(APPLY),120000,{inputPath:input,maxBuffer:1024*1024});
   if (!result.ok) throw Error(result.stderr||result.error||'INI save failed.');
   return { backupId:record.id, backupPath:path.join(directory,record.id), changedFiles:[...replacements.keys()] };
  } catch(error) { throw Error(error.message+' Recovery backup: '+path.join(directory,record.id)); }
  finally { fs.rmSync(input,{force:true}); }
 }
 async function exclusive(fn) { if(busy) throw Error('An INI save or restore is already running.'); busy=true; try{return await fn();}finally{busy=false;} }
 return { list, read, directory,
  save: (values, expectedContent) => exclusive(async()=>{
   const files=await snapshot();
   if (expectedContent !== undefined && Buffer.from(files.find(f=>f.path===TEMPLATE).content,'base64').toString('utf8') !== expectedContent) throw Error('UserGame.ini changed since it was loaded. Reload before saving.');
   const template=files.find(f=>f.path===TEMPLATE);
   if(!template) throw Error('UserGame.ini template was not found; no files changed.');
   const templateUpdate=updateUserGameIni(Buffer.from(template.content,'base64').toString('utf8'),values);
   const changedValues=Object.fromEntries(templateUpdate.changedKeys.map(key=>[key,values[key]]));
   const replacements=new Map();
   for(const f of files.filter(f=>f.path.endsWith('/UserGame.ini'))) {
    const updated=updateUserGameIni(Buffer.from(f.content,'base64').toString('utf8'),changedValues);
    if(updated.changedKeys.length) replacements.set(f.path,Buffer.from(updated.content).toString('base64'));
   }
   if(!replacements.size) return {changedFiles:[],backupPath:''};
   return apply(files,replacements);
  }),
  restore: (id, filename) => exclusive(async()=>{
   if(!['UserGame.ini','UserEngine.ini'].includes(filename)) throw Error('Select an INI file to restore.');
   const record=read(id);
   if(record.target!==target()) throw Error("This backup belongs to a different VM connection.");
   const files=await snapshot(), replacements=new Map();
   for(const f of record.files.filter(f=>f.path.endsWith('/'+filename))) {
    if(sha(f.content)!==f.sha256) throw Error('Backup checksum failed.');
    if(!files.some(current=>current.path===f.path)) throw Error('Backup targets do not match this VM.');
    replacements.set(f.path,f.content);
   }
   if(!replacements.size) throw Error('This backup does not contain '+filename);
   return apply(files,replacements);
  })
 };
}
module.exports={createUserGameRecovery,SNAPSHOT,APPLY};
