"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const {BlueprintDocument}=require("../document"),{suiteScene}=require("../suite-scene"),M=require("../scene-model");
const geometry={kind:"native-render-lod",vertices:[[0,0,0],[2,0,0],[0,2,0]],indices:[0,1,2]};
const entry={id:"Synthetic",status:"available",geometry};
const instance=(key,z=0)=>({key,type:"Synthetic",position:[0,0,z],quaternion:[0,0,0,1],scale:[1,1,1]});
test("mesh selection chooses the nearest actual triangle and respects visibility",()=>{
  const model=M.prepared({entries:[entry],instances:[instance("back"),instance("front",2)]});
  assert.equal(M.pick(model,[.5,.5,10],[0,0,-1]),"front");
  assert.equal(M.pick(model,[.5,.5,10],[0,0,-1],r=>r.key!=="front"),"back");
  assert.equal(M.pick(model,[1.8,1.8,10],[0,0,-1]),null); // Inside bounds, outside triangle.
  assert.equal(M.pick(model,[.5,.5,10],[0,0,1]),null);
});
test("mesh picking handles native rotation, translation, nonuniform scale and source indices",()=>{
  const row={...instance("instances:9007199254740993"),position:[5,6,7],quaternion:[0,0,Math.SQRT1_2,Math.SQRT1_2],scale:[2,3,4]};
  const model=M.prepared({entries:[entry],instances:[row]});
  const p=M.transform([.3,.3,0],row);assert.equal(M.pick(model,[p[0],p[1],30],[0,0,-1]),row.key);
  let selection=M.select(new Set(),row.key);selection=M.select(selection,"another",true);assert.equal(selection.size,2);selection=M.select(selection,row.key,true);assert.deepEqual([...selection],["another"]);
  assert.deepEqual([...M.select(selection,null)],[]);
});
test("scene rejects malformed geometry and transforms without partial substitutes",()=>{
  assert.throws(()=>M.prepared({entries:[{...entry,geometry:{...geometry,indices:[0,1,9]}}],instances:[]}),/triangles/);
  assert.throws(()=>M.prepared({entries:[entry],instances:[{...instance("a"),quaternion:[0,0,0,0]}]}),/rotation/);
  assert.throws(()=>M.prepared({entries:[entry],instances:[instance("a"),instance("a")]}),/Duplicate/);
});
function catalog(bytes){return {schema:1,buildId:"24654038",blueprint:{name:"Synthetic JSON",sha256:crypto.createHash("sha256").update(bytes).digest("hex")},entries:[entry]};}
test("display rounding, selection and derived transforms cannot rewrite lossless source tokens",()=>{
  const bytes=Buffer.from('{"name":"Test","unknown":{"nested":[9007199254740993,1.2300000000000000000001]},"instances":[{"instance_id":9007199254740993,"building_type":"Synthetic","x":0.1000000000000000000001,"y":2,"z":3,"rotation":90,"extra":{"v":-0}}]}');
  const doc=new BlueprintDocument(bytes),scene=suiteScene(doc,catalog(bytes));
  assert.equal(scene.instances.length,1);assert.equal(scene.instances[0].raw.instance_id,"9007199254740993");assert.equal(scene.instances[0].raw.x,"0.1000000000000000000001");
  const model=M.prepared(scene);M.pick(model,[0,0,10],[0,0,-1]);M.select(new Set(),scene.instances[0].key,true);
  scene.instances[0].position[0]=123;scene.instances[0].quaternion[0]=5;assert.deepEqual(doc.toBuffer(),bytes);
});
test("different source documents reuse exact mesh IDs while retaining their own name, hash and null collections",()=>{
  const origin=Buffer.from('{"name":"First","instances":[]}'),shared=catalog(origin);
  const bytes=Buffer.from('{"name":"Second","instances":[{"instance_id":8,"building_type":"Synthetic","x":1,"y":2,"z":3,"rotation":0},{"instance_id":8,"building_type":"Unmapped","x":1,"y":2,"z":3,"rotation":0}],"placeables":null}');
  const doc=new BlueprintDocument(bytes),scene=suiteScene(doc,shared);
  assert.equal(scene.name,"Second");
  assert.equal(scene.sourceSha256,crypto.createHash("sha256").update(bytes).digest("hex"));
  assert.notEqual(scene.sourceSha256,shared.blueprint.sha256);
  assert.deepEqual(scene.instances.map(r=>r.key),["instances:0"]);
  assert.deepEqual(scene.unresolved.map(r=>r.key),["instances:1"]);
  assert.match(scene.unresolved[0].reasons.join(),/No matching/);
  M.prepared(scene);assert.deepEqual(doc.toBuffer(),bytes);
  assert.equal(suiteScene(new BlueprintDocument(origin),shared).instances.length,0);
  for(const incompatible of [{...shared,buildId:"unknown"},{...shared,schema:2},{...shared,entries:null}]){
    assert.throws(()=>suiteScene(doc,incompatible),/schema and game build/);
  }
});
test("unknown types, alternate transforms, malformed positions and unimplemented families remain unresolved",()=>{
  const rows=[{building_type:"Synthetic",x:0,y:0,z:0,rotation:0},{building_type:"Unknown",x:0,y:0,z:0,rotation:0},{building_type:"Synthetic",x:"bad",y:0,z:0,rotation:0},{building_type:"Synthetic",x:0,y:0,z:0,rotation:[],transform:{}},{building_type:"Synthetic",x:0,y:0,z:0}];
  const bytes=Buffer.from(JSON.stringify({instances:rows,placeables:[{building_type:"Synthetic",x:0,y:0,z:0,rotation:0}]})),doc=new BlueprintDocument(bytes),scene=suiteScene(doc,catalog(bytes));
  assert.equal(scene.instances.length,1);assert.equal(scene.unresolved.length,5);assert.ok(scene.unresolved.every(r=>r.reasons.length));assert.deepEqual(doc.toBuffer(),bytes);
});
test("additional structural scale and Euler fields are not silently ignored",()=>{
  for(const extra of [{scale:[2,2,2]},{rx:0},{ry:0},{rz:0}]){
    const bytes=Buffer.from(JSON.stringify({instances:[{building_type:"Synthetic",x:0,y:0,z:0,rotation:0,...extra}]}));
    const scene=suiteScene(new BlueprintDocument(bytes),catalog(bytes));assert.equal(scene.instances.length,0);assert.match(scene.unresolved[0].reasons.join(),/Additional/);
  }
});
test("camera fit uses projected bounds to frame narrow and wide viewports",()=>{
  const rows=M.prepared({entries:[entry],instances:[instance("a"),{...instance("b",8),position:[100,0,8]}]}).rows;
  const basis={right:[1,0,0],up:[0,0,1]};
  for(const aspect of [.4,1,2.8]){const f=M.frame(rows,basis,aspect);assert.ok(f.scale>0);for(const row of rows)for(const p of [row.box.low,row.box.high]){const delta=M.sub(p,f.target);assert.ok(Math.abs(M.dot(delta,basis.right))<=f.scale*aspect);assert.ok(Math.abs(M.dot(delta,basis.up))<=f.scale);}}
});
