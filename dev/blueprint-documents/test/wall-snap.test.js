"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),S=require("../foundation-snap"),{Construction}=require("../construction");
const wallIds=require("../fixtures/wall-identities.json"),baseIds=require("../fixtures/foundation-identities.json"),type="Atreides_Outpost_Wall_01",baseType="Atreides_Outpost_Foundation";
const catalog={schema:1,buildId:wallIds.buildId,entries:[...wallIds.entries,...baseIds.entries].map(e=>({...e,status:"available",geometry:{kind:"native-render-lod",vertices:[[0,0,0],[1,0,0],[0,1,0]],indices:[0,1,2]}}))};
const known=S.profiles(catalog),base=(position=[0,0,0],yaw=0,id="base")=>({id,type:baseType,position,yaw});
const find=(point,options={})=>S.find({type,point,yaw:0,pieces:[base()],known,...options});
const close=(a,b)=>a.forEach((v,i)=>assert.ok(Math.abs(v-b[i])<1e-7));
test("five native Wall identities resolve, while other meshes/builds and altered table provenance do not",()=>{
  assert.equal(Object.values(known).filter(p=>p.group==="Wall").length,5);
  for(const entry of wallIds.entries){assert.equal(known[entry.id].group,"Wall");const bad={...catalog,entries:[{...catalog.entries.find(e=>e.id===entry.id),tableSource:{...entry.tableSource,uexpSha256:"modified"}}]};assert.equal(S.profiles(bad)[entry.id],undefined);}
  assert.equal(known.Atreides_Outpost_Wall_Half,undefined);assert.deepEqual(S.profiles({...catalog,buildId:"other"}),{});
});
test("wall cursor height derives from foundation socket data and does not change free/foundation heights",()=>{
  assert.equal(S.cursorHeight(type,known,0),384);assert.equal(S.cursorHeight(type,known,100),484);assert.equal(S.cursorHeight(baseType,known,100),100);assert.equal(S.cursorHeight("unknown",known,100),100);
});
test("walls align to all four foundation edges at the top, with their length along the edge",()=>{
  for(const position of [[256,0,384],[-256,0,384],[0,256,384],[0,-256,384]]){
    const result=find(position);assert.ok(result.snap);close(result.snap.position,position);const direction=S.rotate([1,0,0],result.snap.yaw);assert.ok(Math.abs(direction[0]*position[0]+direction[1]*position[1])<1e-7);
    close(result.snap.socket,position);assert.equal(result.snap.own,0);
  }
});
test("wall direction chooses the nearest 180-degree alternative and follows rotated raised foundations",()=>{
  assert.equal(find([0,256,384],{yaw:170}).snap.yaw,180);
  const target=base([100,200,50],37),point=S.rotate([256,0,384],37).map((n,i)=>n+target.position[i]);
  const r=find(point,{pieces:[target],yaw:140});assert.ok(r.snap);close(r.snap.position,point);assert.equal(r.snap.yaw,127);
});
test("walls require a matching foundation top level and reject hidden, distant, unknown and wall targets",()=>{
  for(const p of [[256,0,0],[256,0,385],[900,0,384]])assert.equal(find(p).snap,null);
  assert.equal(find([256,0,384],{targetVisible:()=>false}).snap,null);
  assert.equal(find([256,0,384],{pieces:[{...base(),type}]}).snap,null);
  assert.equal(find([256,0,384],{type:"Atreides_Outpost_Wall_Half"}).snap,null);
});
test("an occupied wall slot is blocked across wall types, opposite facing and shared foundation edges",()=>{
  const wall={id:"wall",type:"Atreides_Outpost_Wall_02",position:[256,0,384],yaw:-90},pieces=[base(),base([512,0,0],0,"neighbor"),wall],r=find([256,0,384],{pieces});assert.equal(r.snap,null);assert.equal(r.blocked,true);
  assert.ok(find([0,256,384],{pieces}).snap); // Adjacent corner is a separate slot.
  assert.equal(S.occupied([512,0,0],0,baseType,[base(),wall],known),false);
  assert.equal(S.wallOccupied([256,0,768],90,pieces,known),false);
});
test("wall placement preview does not mutate projects; main-process snap commits height and revalidates stale slots",()=>{
  const project=new Construction(catalog),id=project.command({kind:"add",type:baseType,position:[0,0,0],yaw:0})[0],before=project.document().toBuffer();
  find([256,0,384],{pieces:project.snapshot().pieces});assert.deepEqual(project.document().toBuffer(),before);
  const command={kind:"add-snapped",type,point:[260,0,384],yaw:0,targetId:id,edge:2,previous:null};project.command(command);const pieces=project.snapshot().pieces;close(pieces[1].position,[256,0,384]);assert.equal(Math.abs(pieces[1].yaw),90);
  const saved=project.document().toBuffer();assert.throws(()=>project.command(command),/occupied/);assert.deepEqual(project.document().toBuffer(),saved);project.command({kind:"undo"});assert.deepEqual(project.document().toBuffer(),before);project.command({kind:"redo"});assert.deepEqual(project.document().toBuffer(),saved);
  assert.throws(()=>project.command({...command,point:[260,0,0]}),/unavailable/);
});
