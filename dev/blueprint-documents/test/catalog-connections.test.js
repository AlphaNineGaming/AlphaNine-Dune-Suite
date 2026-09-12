"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),C=require("../connected-snap"),D=require("../connection-data"),{yaw,turns}=require("../compile-connections"),{Construction}=require("../construction");
const catalog={schema:1,buildId:D.buildId,entries:D.entries.map(e=>({...e,status:"available",geometry:{kind:"native-render-lod"}}))},known=C.profiles(catalog);
const type=group=>D.entries.find(e=>e.group===group).id,base=type("Foundation"),piece=(group,position=[0,0,0],angle=0)=>({id:"target",type:type(group),position,yaw:angle});
const near=(a,b)=>a.every((v,i)=>Math.abs(v-b[i])<1e-7);
const find=(group,target,position,angle=0)=>C.candidates({type:type(group),yaw:angle,pieces:[target],known}).find(c=>near(c.position,position)&&Math.abs(c.yaw-angle)<1e-7);
test("all 88 structural groups are reachable by connections from a square foundation",()=>{
  const reps=[...new Map(Object.entries(known).map(([id,p])=>[p.group,id])).values()],reached=new Set([base]);
  for(let pass=0;pass<reps.length;pass++){const before=reached.size;for(const id of reps){if(reached.has(id))continue;for(const targetType of reached){const target={id:"t",type:targetType,position:[0,0,0],yaw:0};if(C.candidates({type:id,pieces:[target],known}).some(c=>!C.occupied(c,[target],known))){reached.add(id);break;}}}if(before===reached.size)break;}
  assert.equal(reps.length,88);assert.deepEqual(reps.filter(id=>!reached.has(id)),[]);
});
test("wedge edges retain native noncardinal yaw and curved pieces share exact native anchors",()=>{
  assert.ok(find("Foundation_Wedge",piece("Foundation"),[0,-403.80167,0]));
  assert.ok(find("Floor_Wedge",piece("Foundation"),[0,-403.80167,384]));
  const wedges=C.candidates({type:type("Foundation_Wedge"),pieces:[piece("Foundation")],known});assert.ok(wedges.some(c=>Math.abs(c.yaw/90-Math.round(c.yaw/90))>.1));
  assert.ok(find("Wall_Round_Corner",piece("Foundation_Round_Corner"),[0,0,384]));
  assert.ok(find("Wall_Round_Corner_Half",piece("Wall_Round_Corner",[0,0,384]),[0,0,768]));
  assert.ok(find("Railing_Round_Corner",piece("Floor_Round_Corner",[0,0,768]),[0,0,768]));
  const angle=D.setups.Foundation_Wedge.sockets[1];assert.equal(angle.yaw,yaw(angle.quaternion));
});
test("pillars, corner pillars and ladders attach at recorded foundation sockets and stack",()=>{
  assert.ok(find("Pillar",piece("Foundation"),[0,0,384]));assert.ok(find("Pillar",piece("Pillar",[0,0,384]),[0,0,768]));
  assert.ok(find("Pillar_Corner",piece("Foundation"),[256,-256,384]));
  assert.ok(find("Ladder",piece("Foundation"),[0,-256,0]));assert.ok(find("Ladder",piece("Ladder"),[0,0,384]));
  const next=find("Pillar",piece("Foundation"),[0,0,384],90);assert.ok(next);assert.equal(next.turn,270);
});
test("inclined railings use one-way full/half receivers and never cross incompatible rises",()=>{
  assert.ok(find("Railing",piece("Foundation"),[0,-256,384]));
  assert.ok(find("Railing_Inclined",piece("Stairs",[0,-512,384]),[256,-512,384],90));
  assert.ok(find("Railing_Inclined_Half",piece("Stairs_Half",[0,-512,384]),[256,-512,384],90));
  assert.equal(C.candidates({type:type("Railing_Inclined_Half"),pieces:[piece("Stairs")],known}).length,0);
  assert.equal(C.candidates({type:type("Stairs"),pieces:[piece("Railing_Inclined")],known}).length,0);
});
test("new families keep preview immutable and extra rotations are revalidated in the main process",()=>{
  const p=new Construction(catalog);p.command({kind:"add",type:base,position:[0,0,0],yaw:0});const target=p.snapshot().pieces[0],before=p.document().toBuffer(),all=C.candidates({type:type("Pillar"),yaw:90,pieces:[target],known}),candidate=all.find(c=>near(c.position,[0,0,384])&&c.yaw===90);assert.ok(candidate);
  const cmd={kind:"add-connected",type:candidate.type,targetId:target.id,ownSocket:candidate.ownSocket,targetSocket:candidate.targetSocket,turn:candidate.turn,yaw:90,position:candidate.position};
  C.choose({candidates:all,point:[0,0],project:p=>p,pieces:[target],known});assert.deepEqual(p.document().toBuffer(),before);
  for(const bad of [{...cmd,turn:45},{...cmd,position:[0,0,385]},{...cmd,ownSocket:99}]){assert.throws(()=>p.command(bad));assert.deepEqual(p.document().toBuffer(),before);}
  p.command(cmd);const saved=p.document().toBuffer();p.command({kind:"undo"});assert.deepEqual(p.document().toBuffer(),before);p.command({kind:"redo"});assert.deepEqual(p.document().toBuffer(),saved);
});
test("native rotations fail closed and do not round wedges to invented right angles",()=>{
  assert.deepEqual(turns(["ESocketConfiguration::Rotated120","ESocketConfiguration::Rotated240"]),[120,240]);
  for(const q of [[1,0,0,0],[0,0,0,0],[0,0,NaN,1]])assert.throws(()=>yaw(q));
  assert.throws(()=>turns(["ESocketConfiguration::Unknown"]));assert.throws(()=>turns(["Other::Normal"]));
  assert.ok(Math.abs(yaw([0,0,.258819,.965926])-30)<.0001);
});
test("mixed-family occupancy index never misses a repeated native layout",()=>{
  const p=piece("Stairs",[0,0,384]),candidate={type:type("Roof"),position:[0,0,384],yaw:0};
  assert.equal(C.occupied(candidate,[p],known),true);assert.equal(C.occupied(candidate,C.obstacleIndex([p],known)(candidate),known),true);
  const curved={type:type("Floor_Round_Corner_Inverted"),position:[0,0,384],yaw:0};assert.equal(C.occupied(curved,[piece("Floor_Round_Corner",[0,0,384])],known),false);
});
test("screen and obstacle indexes agree with full scans through zoom, hidden targets and hysteresis",()=>{
  const types=Object.keys(known),pieces=Array.from({length:200},(_,i)=>({id:String(i),type:types[i*7%types.length],position:[(i%20-10)*512,(Math.floor(i/20)-5)*512,i%3*384],yaw:i%3*37})),obstacles=C.obstacleIndex(pieces,known);
  for(const group of ["Pillar","Wall","Foundation_Wedge","Railing_Inclined","Gate_Big"]){const all=C.candidates({type:type(group),pieces,known});for(const zoom of [.2,.02]){const project=p=>[p[0]*zoom,p[1]*zoom-p[2]*zoom*.3],screen=C.screenIndex(all,project);let previous=null;
    for(let i=0;i<12;i++){const point=[i*8-40,i*3-20],args={point,project,pieces,known,previous,cycle:i%3,visible:id=>Number(id)%3!==0},full=C.choose({...args,candidates:all}),indexed=C.choose({...args,candidates:screen.near(point),screen,obstacles});assert.equal(indexed.snap?.key,full.snap?.key);assert.equal(indexed.blocked,full.blocked);assert.deepEqual(indexed.alternatives.map(c=>c.key),full.alternatives.map(c=>c.key));previous=full.snap?.key;}
  }}
});
