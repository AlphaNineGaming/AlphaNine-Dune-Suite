"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),S=require("../foundation-snap"),{Construction}=require("../construction");
const identities=require("../fixtures/foundation-identities.json");
// Test-only triangle geometry: native identity matching and snap math are tested
// separately from the offline audit of the actual asset bytes.
const catalog={schema:1,...identities,entries:identities.entries.map(e=>({...e,status:"available",geometry:{kind:"native-render-lod",vertices:[[0,0,0],[1,0,0],[0,1,0]],indices:[0,1,2]}}))};
const known=S.profiles(catalog),type="Atreides_Outpost_Foundation",other="MTX_Smug_Foundation";
const target=(id="a",position=[0,0,0],yaw=0)=>({id,type,position,yaw});
const find=(point,options={})=>S.find({type,point,yaw:0,pieces:[target()],known,...options});
const close=(a,b)=>a.forEach((n,i)=>assert.ok(Math.abs(n-b[i])<1e-7,`${a} differs from ${b}`));
test("only the two inspected build/asset/table identities enable foundation snapping",()=>{
  assert.deepEqual(Object.keys(known).sort(),[type,other].sort());
  for(const bad of [{...catalog,buildId:"unknown"},{...catalog,schema:2},{...catalog,entries:catalog.entries.map(e=>({...e,source:{...e.source,uexpSha256:"changed"}}))},{...catalog,entries:catalog.entries.map(e=>({...e,id:e.id+"_Wedge"}))}])assert.equal(Object.keys(S.profiles(bad)).length,0);
  assert.equal(find([512,0,0],{type:"constructor"}).snap,null);
});
test("four edges align exact native sockets with stable selection and no input mutation",()=>{
  for(const position of [[512,0,0],[-512,0,0],[0,512,0],[0,-512,0]]){
    const pieces=[target()],before=JSON.stringify(pieces),result=find(position.map((n,i)=>i===0?n+12:n),{pieces});assert.ok(result.snap);close(result.snap.position,position);
    const movingEdge=known[type].edges[result.snap.own],socket=S.rotate(movingEdge,result.snap.yaw).map((n,i)=>n+result.snap.position[i]);close(socket,result.snap.socket);assert.equal(JSON.stringify(pieces),before);
  }
});
test("rotated, translated and cross-type foundations align relative to the target",()=>{
  for(const yaw of [0,90,180,270,37,-450]){
    const piece=target("rotated",[200,-300,25],yaw),delta=S.rotate([512,0,0],yaw),expected=delta.map((n,i)=>n+piece.position[i]);
    const result=find(expected,{type:other,yaw:yaw+83,pieces:[piece]});assert.ok(result.snap);close(result.snap.position,expected);assert.equal(result.snap.yaw,yaw+90);
  }
});
test("different levels, distant pointers, unsupported meshes and hidden targets do not attract",()=>{
  assert.equal(find([512,0,10]).snap,null);assert.equal(find([800,0,0]).snap,null);assert.equal(find([512,0,0],{type:"Unknown"}).snap,null);
  assert.equal(find([512,0,0],{targetVisible:()=>false}).snap,null);assert.equal(find([NaN,0,0]).snap,null);
});
test("capture distance and release hysteresis avoid abrupt jumps without sticky distant snaps",()=>{
  assert.equal(find([540,0,0],{radius:20}).snap,null);
  const first=find([520,0,0],{radius:20}).snap;assert.ok(first);
  assert.equal(find([540,0,0],{radius:20,previous:first.key}).snap.key,first.key);
  assert.equal(find([545,0,0],{radius:20,previous:first.key}).snap,null);
});
test("occupied sockets and overlapping square footprints are blocked; touching edges and other heights are allowed",()=>{
  const pieces=[target(),target("occupied",[512,0,0])];assert.equal(find([514,0,0],{pieces}).snap,null);assert.equal(find([514,0,0],{pieces}).blocked,true);
  assert.equal(find([0,0,0]).blocked,true);
  assert.equal(S.occupied([512,0,0],0,type,[target()],known),false);
  assert.equal(S.occupied([500,0,0],0,type,[target()],known),true);
  assert.equal(S.occupied([0,0,1],0,type,[target()],known),false);
  assert.equal(S.occupied([400,0,0],45,type,[target()],known),true);
  assert.ok(find([512,512,0],{pieces:[target("east",[512,0,0]),target("north",[0,512,0])]}).snap);
});
test("equally near corner candidates are deterministic regardless of piece order",()=>{
  const a=target("a",[512,0,0]),b=target("b",[0,512,0]);
  assert.equal(find([512,512,0],{pieces:[a,b]}).snap.key,find([512,512,0],{pieces:[b,a]}).snap.key);
});
test("snapped placement is one undoable main-process command and stale occupied targets fail atomically",()=>{
  const p=new Construction(catalog),id=p.command({kind:"add",type,position:[0,0,0],yaw:0})[0];
  const request={kind:"add-snapped",type:other,point:[520,0,0],yaw:5,targetId:id,edge:2,previous:null};
  const before=p.document().toBuffer();p.command(request);close(p.snapshot().pieces[1].position,[512,0,0]);assert.equal(p.snapshot().pieces[1].yaw,0);
  const added=p.document().toBuffer();assert.throws(()=>p.command(request),/occupied/);assert.deepEqual(p.document().toBuffer(),added);
  p.command({kind:"undo"});assert.deepEqual(p.document().toBuffer(),before);p.command({kind:"redo"});assert.deepEqual(p.document().toBuffer(),added);
  for(const change of [{targetId:"missing"},{edge:8},{type:"Unknown"},{point:[9999,0,0]}]){assert.throws(()=>p.command({...request,...change}));assert.deepEqual(p.document().toBuffer(),added);}
});
