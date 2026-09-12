"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path"),{randomUUID}=require("node:crypto");
const {Construction,ProjectDocument,LIMIT}=require("../construction"),{createLocalFiles}=require("../local-files"),{BlueprintDocument}=require("../document"),M=require("../scene-model");
const catalog={schema:1,buildId:"24654038",entries:[{id:"NativeFixture",status:"available",geometry:{kind:"native-render-lod",vertices:[[0,0,0],[2,0,0],[0,2,0]],indices:[0,1,2]}}]};
const add=(project,position=[0,0,0])=>project.command({kind:"add",type:"NativeFixture",position,yaw:0})[0];
test("placement uses an explicit native Z plane and rejects parallel or invalid rays",()=>{
  assert.deepEqual(M.planePoint([10,20,30],[0,0,-1],5),[10,20,5]);
  assert.deepEqual(M.planePoint([0,0,10],[1,0,-1],0),[10,0,0]);
  assert.equal(M.planePoint([0,0,10],[1,0,0],0),null);
  assert.equal(M.planePoint([Infinity,0,10],[0,0,-1],0),null);
  assert.equal(M.planePoint([0,0,10],[0,0,-1],1e9),null);
});
async function dir(t){const p=await fs.mkdtemp(path.join(os.tmpdir(),"a9-construction-"));t.after(()=>fs.rm(p,{recursive:true,force:true}));return p;}
test("construction creates local UUIDs, transforms multiple pieces and undoes complete commands",()=>{
  const p=new Construction(catalog),a=add(p),b=add(p,[4,0,0]);assert.notEqual(a,b);assert.equal(p.snapshot().dirty,true);
  p.command({kind:"move",ids:[a,b],delta:[1,2,3]});assert.deepEqual(p.snapshot().pieces.map(r=>r.position),[[1,2,3],[5,2,3]]);
  p.command({kind:"rotate",ids:[a,b],degrees:90});assert.ok(p.snapshot().pieces.every(r=>r.yaw===90));assert.deepEqual(p.snapshot().pieces[1].position,[5,2,3]);
  const copies=p.command({kind:"duplicate",ids:[a,b],delta:[0,0,10]});assert.equal(new Set([a,b,...copies]).size,4);assert.deepEqual(p.snapshot().pieces[2].position,[1,2,13]);
  const before=p.document().toBuffer();p.command({kind:"delete",ids:copies});assert.equal(p.snapshot().pieces.length,2);
  p.command({kind:"undo"});assert.deepEqual(p.document().toBuffer(),before);p.command({kind:"redo"});assert.equal(p.snapshot().pieces.length,2);
  p.command({kind:"undo"});p.command({kind:"rename",name:"New base"});assert.equal(p.snapshot().canRedo,false);
});
test("failed commands leave data, dirty status and history untouched",()=>{
  const p=new Construction(catalog),id=add(p);p.markSaved();const before=p.snapshot();
  for(const command of [{kind:"add",type:"Guessed",position:[0,0,0],yaw:0},{kind:"move",ids:[id],delta:[NaN,0,0]},{kind:"move",ids:[id],delta:null},{kind:"move",ids:[id],delta:[1e8,0,0]},{kind:"rotate",ids:[id,id],degrees:90},{kind:"delete",ids:["missing"]},{kind:"export"},{kind:"rename",name:""},{kind:"undo",extra:true}]){assert.throws(()=>p.command(command));assert.deepEqual(p.snapshot(),before);}
});
test("saved status follows content through undo/redo and snapshots never alias project state",()=>{
  const p=new Construction(catalog),id=add(p);p.markSaved();const detached=p.snapshot();detached.pieces[0].position[0]=123;
  p.command({kind:"move",ids:[id],delta:[10,0,0]});assert.equal(p.snapshot().dirty,true);p.command({kind:"undo"});assert.equal(p.snapshot().dirty,false);assert.equal(p.snapshot().pieces[0].position[0],0);p.command({kind:"redo"});assert.equal(p.snapshot().dirty,true);
});
test("project scene and selection are detached; missing meshes remain preserved and unresolved",()=>{
  const p=new Construction(catalog),id=add(p);const doc=p.document(),scene=p.scene(catalog),prepared=M.prepared(scene);
  assert.equal(M.pick(prepared,[.5,.5,5],[0,0,-1]),id);scene.instances[0].position[0]=10;assert.deepEqual(p.document().toBuffer(),doc.toBuffer());
  const missing=new Construction({...catalog,entries:[]},doc);assert.equal(missing.scene({...catalog,entries:[]}).unresolved.length,1);assert.deepEqual(missing.document().toBuffer(),doc.toBuffer());
});
test("strict project format rejects unknown fields, versions, duplicate keys, invalid UTF8 and lossy numbers",()=>{
  const p=new Construction(catalog);add(p);const value=p.document().value();
  for(const v of [{...value,extra:true},{...value,version:2},{...value,buildId:"other"},{...value,pieces:[{...value.pieces[0],extra:true}]},{...value,pieces:[value.pieces[0],value.pieces[0]]}])assert.throws(()=>new ProjectDocument(Buffer.from(JSON.stringify(v))));
  const valid=p.document().toBuffer().toString();
  for(const text of [valid.replace('"yaw": 0','"yaw": 0.1000000000000000000001'),valid.replace('"yaw": 0','"yaw": 1e309'),valid.replace('"yaw": 0','"yaw": 0, "yaw": 1'),valid+'x'])assert.throws(()=>new ProjectDocument(Buffer.from(text)));
  assert.throws(()=>new ProjectDocument(Buffer.from([0xff])));
  assert.throws(()=>new ProjectDocument(new BlueprintDocument(Buffer.from('{"instances":[]}')).toBuffer()));
  assert.throws(()=>new BlueprintDocument(p.document().toBuffer()),/envelope/);
});
test("project limit rejects insertion without changing a full project",()=>{
  const value=new Construction(catalog).document().value();value.pieces=Array.from({length:LIMIT},()=>({id:randomUUID(),type:"NativeFixture",position:[0,0,0],yaw:0}));
  const p=new Construction(catalog,ProjectDocument.from(value));assert.throws(()=>add(p),/at most/);assert.equal(p.snapshot().pieces.length,LIMIT);assert.equal(p.snapshot().canUndo,false);
});
test("project save/reopen preserves design and cannot overwrite source or existing blueprint",async t=>{
  const directory=await dir(t),files=createLocalFiles(undefined,ProjectDocument),p=new Construction(catalog);add(p,[1.25,-2,3]);
  const session=files.create(p.document()),saved=path.join(directory,"base.a9project"),blueprint=path.join(directory,"original.json"),original=Buffer.from('{"instances":[],"precise":0.10000000000000000000001}');await fs.writeFile(blueprint,original);
  await files.saveCopy(session,saved);const opened=await files.open(saved);assert.deepEqual(opened.document.value(),p.document().value());
  await assert.rejects(files.saveCopy(opened,saved),/source/);await assert.rejects(files.saveCopy(session,blueprint),/existing/);assert.deepEqual(await fs.readFile(blueprint),original);
  const invalid=path.join(directory,"invalid.a9project");await fs.writeFile(invalid,'{"format":');await assert.rejects(files.open(invalid));assert.deepEqual((await fs.readdir(directory)).sort(),["base.a9project","invalid.a9project","original.json"]);
});
test("project publication failure leaves no partial saved file",async t=>{
  const directory=await dir(t),files=createLocalFiles({...fs,link:async()=>{throw Error("injected publication failure");}},ProjectDocument),session=files.create(new Construction(catalog).document());
  await assert.rejects(files.saveCopy(session,path.join(directory,"failed.a9project")),/Save Copy failed/);assert.deepEqual(await fs.readdir(directory),[]);
});
