const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
const {createDesignerLauncher}=require('../electron/blueprint-designer-launcher');
async function main(){
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'designer-first-start-'));
  try{
    let assigned;
    const app={getAppPath:()=>path.join(__dirname,'..'),getPath:()=>scratch,setPath:(name,dir)=>{assert.ok(fs.statSync(dir).isDirectory());assigned=dir;},whenReady:()=>({then:()=>({catch(){}})}),on(){}};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../electron/blueprint-designer-entry.js'),'utf8'),{require:name=>name==='electron'?{app}:require(name),process:{argv:[]}});
    assert.equal(assigned,path.join(scratch,'AlphaNine Blueprint Designer'));
    fs.writeFileSync(path.join(assigned,'existing-project'),'keep');
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../electron/blueprint-designer-entry.js'),'utf8'),{require:name=>name==='electron'?{app}:require(name),process:{argv:[]}});
    assert.equal(fs.readFileSync(path.join(assigned,'existing-project'),'utf8'),'keep');
  }finally{fs.rmSync(scratch,{recursive:true,force:true});}
  const frame={url:'http://127.0.0.1:8810/#blueprints'},webContents={mainFrame:frame},event={sender:webContents,senderFrame:frame};
  let child,spawns=0,focus='';
  const launcher=createDesignerLauncher({app:{isPackaged:true,getAppPath:()=>process.cwd()},existsSync:()=>true,getMainWindow:()=>({webContents}),port:8810,spawn:()=>{spawns++;child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();child.stdin.write=s=>focus+=s;child.kill=()=>{};return child;}});
  let opened=false;const first=launcher.open(event).then(r=>{opened=true;return r;});
  child.emit('spawn');await new Promise(resolve=>setImmediate(resolve));assert.equal(opened,false,'Process spawn must not imply window readiness');
  const second=launcher.open(event);assert.equal(spawns,1);
  child.stdout.emit('data',Buffer.from('ALPHANINE_DESIGNER_'));child.stdout.emit('data',Buffer.from('READY\n'));
  assert.equal((await first).opened,true);await second;
  assert.equal((await launcher.open(event)).alreadyOpen,true);assert.equal(focus,'focus\n');
  child.emit('exit',0);
  const failed=launcher.open(event);child.stderr.emit('data',Buffer.from('Cannot load catalog'));child.emit('exit',1);
  await assert.rejects(failed,/Cannot load catalog/);
  const retry=launcher.open(event);child.stdout.emit('data',Buffer.from('ALPHANINE_DESIGNER_READY\n'));await retry;child.emit('exit',0);
  console.log('PASS: first-run directory, existing data, readiness, repeated clicks, focus, startup failure, and retry.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
