"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),{EventEmitter}=require("node:events"),fs=require("node:fs/promises"),path=require("node:path"),os=require("node:os");
const {createDocumentWindow}=require("../desktop");
const catalog={schema:1,buildId:"24654038",entries:[{id:"Choam_Shelter_Foundation_New",status:"available",tableSource:{uexpSha256:require("../export-types.json").entries.Choam_Shelter_Foundation_New.tableSha256},geometry:{kind:"native-render-lod",vertices:[[0,0,0],[1,0,0],[0,1,0]],indices:[0,1,2]}}]};
async function setup(t,mode="assembly"){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"a9-bridge-"));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const handlers=new Map();let discard=0,chosen=null,destination=null;
  class Window extends EventEmitter{
    constructor(options){super();this.options=options;this.webContents=new EventEmitter();this.webContents.mainFrame={url:""};this.webContents.setWindowOpenHandler=()=>{};}
    async loadURL(url){this.webContents.mainFrame.url=url;}
    close(){let prevented=false;this.emit("close",{preventDefault:()=>prevented=true});if(!prevented)this.emit("closed");}
  }
  const electron={app:{isPackaged:false,commandLine:{hasSwitch:()=>false}},BrowserWindow:Window,ipcMain:{handle:(k,v)=>handlers.set(k,v),removeHandler:k=>handlers.delete(k)},session:{fromPartition:()=>({webRequest:{onBeforeRequest:()=>{}},setPermissionRequestHandler:()=>{},setPermissionCheckHandler:()=>{}})}};
  const window=await createDocumentWindow(electron,{mode,geometryCatalog:catalog,dialogs:{showOpenDialog:async()=>chosen?{canceled:false,filePaths:[chosen]}:{canceled:true,filePaths:[]},showSaveDialog:async()=>destination?{canceled:false,filePath:destination}:{canceled:true},showMessageBox:async()=>({response:discard})}});
  const event={sender:window.webContents,senderFrame:window.webContents.mainFrame};
  const invoke=(channel,...args)=>handlers.get(`blueprint-document:${channel}`)(event,...args);
  return {directory,window,handlers,event,invoke,setDiscard:n=>discard=n,setChosen:p=>chosen=p,setDestination:p=>destination=p};
}
test("construction IPC authenticates the frame, retains sandboxing and rejects commands in read-only windows",async t=>{
  const s=await setup(t);assert.equal(s.window.options.webPreferences.sandbox,true);assert.equal(s.window.options.webPreferences.nodeIntegration,false);assert.equal(s.window.options.webPreferences.contextIsolation,true);
  await assert.rejects(s.handlers.get("blueprint-document:project")({...s.event,senderFrame:{url:s.event.senderFrame.url}},"new"),/untrusted/);
  assert.match((await s.invoke("project","command",{kind:"undo"})).error,/Create or open/);
  const reference=await setup(t,"reference");assert.match((await reference.invoke("project","new")).error,/unavailable/);
});
test("IPC keeps project saving separate from native blueprint copy saving",async t=>{
  const s=await setup(t);await s.invoke("project","new");const added=await s.invoke("project","command",{kind:"add",type:"Choam_Shelter_Foundation_New",position:[0,0,0],yaw:0});assert.equal(added.project.pieces.length,1);
  assert.match((await s.invoke("save-copy")).error,/not game blueprints/);
  s.setDestination(path.join(s.directory,"bad.json"));assert.match((await s.invoke("project","save")).error,/extension/);assert.deepEqual(await fs.readdir(s.directory),[]);
  const destination=path.join(s.directory,"base.a9project");s.setDestination(destination);const saved=await s.invoke("project","save");assert.equal(saved.project.dirty,false);assert.equal(JSON.parse(await fs.readFile(destination)).pieces.length,1);
  assert.match((await s.invoke("project","save")).error,/existing/);
  s.setChosen(destination);const reopened=await s.invoke("project","open");assert.deepEqual(reopened.project.pieces,added.project.pieces);assert.match((await s.invoke("project","save")).error,/source/);
});
test("unsaved project cancellation and malformed replacements preserve current work",async t=>{
  const s=await setup(t);await s.invoke("project","new");await s.invoke("project","command",{kind:"add",type:"Choam_Shelter_Foundation_New",position:[2,3,4],yaw:5});
  assert.equal((await s.invoke("project","new")).canceled,true);assert.equal((await s.invoke("open")).canceled,true);
  s.setDiscard(1);const bad=path.join(s.directory,"bad.a9project");await fs.writeFile(bad,'{"format":');s.setChosen(bad);assert.ok((await s.invoke("project","open")).error);
  const unchanged=await s.invoke("project","command",{kind:"rename",name:"Still here"});assert.deepEqual(unchanged.project.pieces[0].position,[2,3,4]);
  s.setChosen(null);assert.equal((await s.invoke("project","open")).canceled,true);
  assert.equal((await s.invoke("project","new")).project.pieces.length,0);
});
test("switching from project to blueprint disables construction and preserves source bytes",async t=>{
  const s=await setup(t);await s.invoke("project","new");await s.invoke("project","command",{kind:"add",type:"Choam_Shelter_Foundation_New",position:[0,0,0],yaw:0});s.setDiscard(1);
  const source=path.join(s.directory,"source.json"),bytes=Buffer.from('{"instances":[],"placeables":null,"unknown":9007199254740993}');await fs.writeFile(source,bytes);s.setChosen(source);
  const opened=await s.invoke("open");assert.equal(opened.instances,0);assert.match((await s.invoke("project","command",{kind:"delete",ids:["anything"]})).error,/Create or open/);
  s.setDestination(path.join(s.directory,"copy.json"));await s.invoke("save-copy");assert.deepEqual(await fs.readFile(source),bytes);assert.deepEqual(await fs.readFile(path.join(s.directory,"copy.json")),bytes);
});

test("packaged designer starts without a modal file operation; development auto-open remains available",async()=>{
  const vm=require("node:vm");
  const source=await fs.readFile(path.join(__dirname,"../assembly-renderer.js"),"utf8");
  const startup=source.trim().split(/\r?\n/).at(-1);
  for(const [search,expected] of [["?start=empty",0],["",1]]){
    let opened=0;vm.runInNewContext(startup,{URLSearchParams,location:{search},open:()=>opened++});assert.equal(opened,expected);
  }
});

test("Export Blueprint IPC writes game JSON, preserves project edits, and handles cancellation and overwrite refusal",async t=>{
  const s=await setup(t);await s.invoke('project','new');
  assert.match((await s.invoke('project','export')).error,/at least one/);
  const added=await s.invoke('project','command',{kind:'add',type:'Choam_Shelter_Foundation_New',position:[0,0,0],yaw:0});
  assert.equal((await s.invoke('project','export')).canceled,true);
  s.setDestination(path.join(s.directory,'bad.a9project'));assert.match((await s.invoke('project','export')).error,/\.json extension/);
  const output=path.join(s.directory,'ready.json');s.setDestination(output);
  const exported=await s.invoke('project','export');assert.equal(exported.pieces,1);assert.equal(exported.published,true);
  const value=JSON.parse(await fs.readFile(output));assert.equal(value.instances[0].building_type,'Choam_Shelter_Foundation_New');assert.equal(value.instances[0].provides_stability,true);assert.equal(value.instances[0].instance_id,1);assert.equal(value.pieces,undefined);
  assert.match((await s.invoke('project','export')).error,/existing/);
  const renamed=await s.invoke('project','command',{kind:'rename',name:added.project.name});assert.equal(renamed.project.dirty,true);assert.deepEqual(renamed.project.pieces,added.project.pieces);
  const reference=await setup(t,'reference');assert.match((await reference.invoke('project','export')).error,/unavailable/);
});
