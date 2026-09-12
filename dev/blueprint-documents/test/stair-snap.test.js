"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),C=require("../connected-snap"),D=require("../connection-data"),{Construction,ProjectDocument}=require("../construction");
const catalog={schema:1,buildId:D.buildId,entries:D.entries.map(e=>({...e,status:"available",geometry:{kind:"native-render-lod"}}))},known=C.profiles(catalog);
const base="Atreides_Outpost_Foundation",floor="Atreides_Outpost_Floor",stair="Atreides_Outpost_Stairs",half="Atreides_Outpost_Stairs_Half",wide="Atreides_Outpost_Stair_Wide";
const piece=(type,position=[0,0,0],yaw=0,id="target")=>({id,type,position,yaw}),near=(a,b)=>a.every((v,i)=>Math.abs(v-b[i])<1e-7);
const candidates=(type,target,yaw=0)=>C.candidates({type,yaw,pieces:[target],known});
const find=(type,target,position,yaw=0)=>candidates(type,target,yaw).find(c=>near(c.position,position)&&Math.abs(c.yaw-yaw)<1e-7);
const command=c=>({kind:"add-connected",type:c.type,targetId:c.targetId,targetSocket:c.targetSocket,ownSocket:c.ownSocket,turn:c.turn,yaw:c.inputYaw,position:c.position});
test("45 stair/wide-ramp types including recovered meshes preserve native group and height profiles",()=>{
  assert.equal(Object.values(known).filter(p=>p.family==="stair").length,45);
  assert.equal(known[stair].socketGroup,"Angled");assert.equal(known[half].socketGroup,"Angled_Half");assert.equal(known[wide].socketGroup,"Ramp_Wide");
  assert.deepEqual(known[stair].sockets.slice(0,2).map(s=>s.position),[[0,256,0],[0,-256,384]]);
  assert.deepEqual(known[half].sockets.slice(0,2).map(s=>s.position),[[0,256,0],[0,-256,192]]);
  assert.deepEqual(known[wide].sockets.slice(0,2).map(s=>s.position),[[0,768,0],[0,-768,384]]);
  assert.equal(known.Choam_Shelter_Stairs.socketGroup,"Angled");
});
test("stairs ascend or descend from foundation edges and connect to upper floors at native heights",()=>{
  const foundation=piece(base);
  for(const [type,offset,rise] of [[stair,512,384],[half,512,192],[wide,1024,384]]){
    assert.ok(find(type,foundation,[0,-offset,384]),type);
    assert.ok(find(type,foundation,[0,-offset,384-rise],180),type);
    const upper=find(floor,piece(type,[0,-offset,384]),[0,-offset*2,384+rise]);assert.ok(upper,type);
  }
  assert.ok(find(stair,piece(stair,[0,-512,384]),[0,-1024,768]));
});
test("side connections honor native classes and Normal-only overrides; matching corners connect",()=>{
  const target=piece(stair),side=find(stair,target,[512,0,0]);assert.ok(side);assert.equal(side.turn,0);assert.deepEqual(side.line,[side.socket,side.socket]);
  const all=candidates(stair,target);for(const c of all){const own=known[stair].sockets.find(s=>s.index===c.ownSocket);assert.ok(own.turns.includes(c.turn));}
  assert.equal(candidates(half,target).some(c=>known[half].sockets.find(s=>s.index===c.ownSocket).own[0]!=="BP_DuneBuildingSocket_C"),false);
  for(const type of ["Atreides_Outpost_Stairs_Corner","Atreides_Outpost_Stairs_Corner_Inward"]){const matches=candidates(type,target).filter(c=>known[type].sockets.find(s=>s.index===c.ownSocket).own[0]==="BP_DuneBuildingAngledSocket_C");assert.ok(matches.length,type);assert.ok(matches.every(c=>c.turn===0));}
  assert.equal(candidates(floor,target).some(c=>known[stair].sockets.find(s=>s.index===c.targetSocket).own[0]!=="BP_DuneBuildingSocket_C"),false);
  assert.equal(candidates(stair,piece("Atreides_Outpost_Wall_01")).length,0);
});
test("duplicate stair placement is blocked across matching sets and spatial index agrees",()=>{
  const candidate=find(stair,piece(base),[0,-512,384]),existing=[piece("MTX_Smug_Stairs",candidate.position)];
  assert.equal(C.occupied(candidate,existing,known),true);assert.equal(C.occupied(candidate,C.obstacleIndex(existing,known)(candidate),known),true);
  assert.equal(C.occupied(candidate,[piece(stair,[0,-1024,768])],known),false);
});
test("actual top-view pointer scoring selects stairs, landing, side flight, half rise and wide flight",()=>{
  const fs=require("node:fs"),vm=require("node:vm"),Scene=require("../scene-model"),context={window:{},BlueprintScene:Scene};vm.runInNewContext(fs.readFileSync(require.resolve("../assembly-viewport.js"),"utf8"),context);
  const viewport=Object.create(context.window.AssemblyViewport.prototype);Object.assign(viewport,{canvas:{getBoundingClientRect:()=>({left:0,top:0,width:700,height:500})},target:[0,-700,450],yaw:0,pitch:Math.PI/2,scale:2400});
  const pieces=[piece(base)];
  function choose(type,position,yaw){return C.choose({candidates:C.candidates({type,yaw,pieces,known}),point:viewport.projectPoint(position).map(Math.round),project:viewport.projector(),pieces,known,depth:p=>Scene.dot(p,viewport.basis().forward)});}
  assert.deepEqual(choose(stair,[0,-512,384],0).snap.position,[0,-512,384]);assert.deepEqual(choose(stair,[0,-512,384],180).snap.position,[0,-512,0]);
  for(const [type,position,yaw]of [[stair,[0,-512,384],360],[floor,[0,-1024,768],0],["MTX_Smug_Stairs",[512,-512,384],0],[half,[0,-1536,768],0],[wide,[1024,0,384],90]]){
    const r=choose(type,position,yaw);assert.deepEqual(r.snap?.position,position,type);pieces.push(piece(type,r.snap.position,r.snap.yaw,String(pieces.length)));
  }
});
test("stair preview is read-only; main process rejects altered height, stale targets and illegal side rotations",()=>{
  const p=new Construction(catalog);p.command({kind:"add",type:base,position:[0,0,0],yaw:0});const target=p.snapshot().pieces[0],c=find(stair,target,[0,-512,384]),before=p.document().toBuffer();
  const r=C.choose({candidates:candidates(stair,target),point:[0,-512],project:v=>[v[0],v[1]],pieces:[target],known});assert.ok(r.snap);assert.deepEqual(p.document().toBuffer(),before);
  assert.throws(()=>p.command({...command(c),position:[0,-512,0]}));assert.deepEqual(p.document().toBuffer(),before);
  p.command(command(c));const added=p.snapshot().pieces[1],side=find(stair,added,[512,-512,384]),saved=p.document().toBuffer();assert.throws(()=>p.command({...command(side),turn:180}));assert.deepEqual(p.document().toBuffer(),saved);
  p.command({kind:"move",ids:[target.id],delta:[0,0,100]});const moved=p.document().toBuffer();assert.throws(()=>p.command(command(c)));assert.deepEqual(p.document().toBuffer(),moved);
  p.command({kind:"undo"});p.command({kind:"undo"});assert.deepEqual(p.document().toBuffer(),before);p.command({kind:"redo"});assert.deepEqual(new ProjectDocument(p.document().toBuffer()).toBuffer(),saved);
});
