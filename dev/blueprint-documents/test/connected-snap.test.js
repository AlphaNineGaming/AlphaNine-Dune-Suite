"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),C=require("../connected-snap"),Data=require("../connection-data"),{Construction,ProjectDocument}=require("../construction");
const catalog={schema:1,buildId:Data.buildId,entries:Data.entries.map(e=>({...e,status:"available",geometry:{kind:"native-render-lod",vertices:[[0,0,0],[1,0,0],[0,1,0]],indices:[0,1,2]}}))},known=C.profiles(catalog);
const base="Atreides_Outpost_Foundation",wall="Atreides_Outpost_Wall_01",half="Atreides_Outpost_Wall_Half",door="Atreides_Outpost_Door_Frame",wide="Atreides_Outpost_Door_Frame_Wide",tall="Atreides_Outpost_Door_Frame_Tall",floor="Atreides_Outpost_Floor",roof="Atreides_Outpost_Roof_Half",flat="Atreides_Outpost_Rooftop_01";
const piece=(type,position=[0,0,0],yaw=0,id="target")=>({id,type,position,yaw});
const near=(a,b)=>a.every((v,i)=>Math.abs(v-b[i])<1e-7);
const find=(type,target,position,yaw=0)=>C.candidates({type,yaw,pieces:[target],known}).find(c=>near(c.position,position)&&Math.abs(Math.sin((c.yaw-yaw)*Math.PI/180))<1e-7);
const command=c=>({kind:"add-connected",type:c.type,targetId:c.targetId,targetSocket:c.targetSocket,ownSocket:c.ownSocket,turn:c.turn,yaw:c.inputYaw,position:c.position});
test("every catalog type connects through a native socket and survives project save/reopen",()=>{
  const representatives=[...new Map(Object.entries(known).map(([type,p])=>[p.socketGroup+":"+p.family,type])).values()];
  for(const type of Object.keys(known)){
    const targetType=representatives.find(t=>{const p=piece(t,[100,-200,25],37);return C.candidates({type,yaw:37,pieces:[p],known}).some(x=>!C.occupied(x,[p],known));});assert.ok(targetType,type);
    const c=new Construction(catalog);c.command({kind:"add",type:targetType,position:[100,-200,25],yaw:37});
    const target=c.snapshot().pieces[0],candidate=C.candidates({type,yaw:37,pieces:[target],known}).find(x=>!C.occupied(x,[target],known));assert.ok(candidate,type);
    c.command(command(candidate));const added=c.snapshot().pieces[1],own=known[type].sockets.find(s=>s.index===candidate.ownSocket),other=known[targetType].sockets.find(s=>s.index===candidate.targetSocket);
    const rotate=require("../foundation-snap").rotate,a=rotate(own.position,added.yaw).map((v,i)=>v+added.position[i]),b=rotate(other.position,target.yaw).map((v,i)=>v+target.position[i]);assert.ok(near(a,b),type);
    assert.deepEqual(new ProjectDocument(c.document().toBuffer()).value().pieces,c.snapshot().pieces);
  }
});
test("complete building-group chain enables 565 exact native identities; roof maps to Angled_Half and rooftop to Floor",()=>{
  assert.equal(Object.keys(known).length,565);assert.equal(Data.entries.find(e=>e.id===roof).socketGroup,"Angled_Half");assert.equal(Data.entries.find(e=>e.id===flat).socketGroup,"Floor");
  assert.deepEqual(Object.keys(C.profiles({...catalog,buildId:"unknown"})),[]);
  for(const identity of ["source","tableSource"]){const entries=structuredClone(catalog.entries);entries[0][identity].assetPath+="changed";assert.equal(C.profiles({...catalog,entries})[entries[0].id],undefined);}
});
test("doorframes, windows and half walls attach to native foundation edges, including wide anchor offsets",()=>{
  const target=piece(base);for(const type of [door,tall,wall,half,"Atreides_Outpost_Window_02"])assert.ok(find(type,target,[0,-256,384]));
  assert.ok(find(wide,target,[256,-256,384]));assert.ok(find(wide,target,[-256,-256,384]));
  assert.equal(known[half].maxZ,192);assert.equal(known[tall].maxZ,768);assert.equal(known[wide].half,512);
});
test("wall stacking uses each target's actual top height, including half/tall doorframe types",()=>{
  for(const [type,height] of [[wall,384],[half,192],[tall,768]]){const target=piece(type,[100,200,500],37),c=find(wall,target,[100,200,500+height],37);assert.ok(c);assert.equal(c.yaw,37);}
});
test("upper floors and flat roofs connect to wall tops on either side; floors extend edge-to-edge",()=>{
  const target=piece(wall,[0,-256,384]);assert.ok(find(floor,target,[0,0,768]));assert.ok(find(flat,target,[0,-512,768]));
  assert.ok(find(floor,piece(floor,[0,0,768]),[512,0,768]));assert.ok(find(wall,piece(floor,[0,0,768]),[0,-256,768]));
});
test("sloped roofs use low/high native edge heights, allowing adjoining and opposing roof connections",()=>{
  const target=piece(wall,[0,256,384]);assert.ok(find(roof,target,[0,0,768]));
  const slopes=C.candidates({type:roof,yaw:0,pieces:[piece(roof,[0,0,768])],known});
  assert.ok(slopes.some(c=>near(c.position,[0,-512,960])));assert.ok(slopes.some(c=>near(c.position,[0,-512,768])&&Math.abs(c.yaw%360)===180));
});
test("socket span guard rejects overlapping wall/doorway slots and preserves touching corners and stacks",()=>{
  const target=piece(base),c=find(wide,target,[256,-256,384]);assert.ok(c);
  assert.equal(C.occupied(c,[piece(wall,[0,-256,384])],known),true);
  assert.equal(C.occupied(find(wall,target,[0,-256,384]),[piece(half,[0,-256,384])],known),true);
  assert.equal(C.occupied(find(wall,target,[0,-256,384]),[piece(wall,[0,-256,768])],known),false);
  assert.equal(C.occupied(find(wall,target,[0,-256,384]),[piece(wall,[256,0,384],90)],known),false);
  assert.equal(C.occupied(find(flat,piece(wall,[0,-256,384]),[0,0,768]),[piece(floor,[0,0,768])],known),true);
});
test("screen capture supports auto height, cycling, hidden targets and stable deterministic alternatives",()=>{
  const pieces=[piece(base,[0,0,900])],all=C.candidates({type:door,yaw:0,pieces,known}),point=[0,-256],project=p=>[p[0],p[1]],before=JSON.stringify(pieces);
  const a=C.choose({candidates:all,point,project,pieces,known});assert.equal(a.snap.position[2],1284);assert.ok(a.alternatives.length>=2);
  const b=C.choose({candidates:all,point,project,pieces,known,cycle:1});assert.notEqual(a.snap.key,b.snap.key);
  assert.equal(C.choose({candidates:all,point,project,pieces,known,visible:()=>false}).snap,null);
  assert.equal(C.choose({candidates:all,point:[2000,2000],project,pieces,known}).snap,null);assert.equal(JSON.stringify(pieces),before);
});
test("complete local room workflow preserves imported-independent projects, history and exact saved positions",()=>{
  const p=new Construction(catalog);p.command({kind:"add",type:base,position:[0,0,0],yaw:0});let target=p.snapshot().pieces[0];
  for(const [type,position,yaw] of [[door,[0,-256,384],0],[wall,[0,256,384],0],[wall,[256,0,384],90],[wall,[-256,0,384],90]]){const c=find(type,target,position,yaw);p.command(command(c));}
  const front=p.snapshot().pieces[1];p.command(command(find(floor,front,[0,0,768])));
  const level=p.snapshot().pieces.at(-1);p.command(command(find(wall,level,[0,-256,768])));const upper=p.snapshot().pieces.at(-1);
  p.command(command(find(flat,upper,[0,0,1152])));assert.equal(p.snapshot().pieces.length,8);
  const saved=p.document().toBuffer();assert.deepEqual(new Construction(catalog,new ProjectDocument(saved)).document().toBuffer(),saved);
  p.command({kind:"undo"});assert.equal(p.snapshot().pieces.length,7);p.command({kind:"redo"});assert.deepEqual(p.document().toBuffer(),saved);
});
test("main process rejects forged, stale, unsupported and occupied connections atomically",()=>{
  const p=new Construction(catalog);p.command({kind:"add",type:base,position:[0,0,0],yaw:0});const target=p.snapshot().pieces[0],c=find(door,target,[0,-256,384]),cmd=command(c),before=p.document().toBuffer();
  for(const bad of [{...cmd,position:[0,0,0]},{...cmd,targetSocket:99},{...cmd,turn:90},{...cmd,type:"unknown"},{...cmd,yaw:NaN},{...cmd,unknown:1}]){assert.throws(()=>p.command(bad));assert.deepEqual(p.document().toBuffer(),before);}
  p.command({kind:"move",ids:[target.id],delta:[0,0,100]});const moved=p.document().toBuffer();assert.throws(()=>p.command(cmd),/changed/);assert.deepEqual(p.document().toBuffer(),moved);
  p.command({kind:"undo"});p.command(cmd);const saved=p.document().toBuffer();assert.throws(()=>p.command(cmd),/occupied/);assert.deepEqual(p.document().toBuffer(),saved);
});
test("actual viewport top projection chooses the upper roof connection instead of a hidden lower level",()=>{
  const fs=require("node:fs"),vm=require("node:vm"),context={window:{},BlueprintScene:require("../scene-model")};
  vm.runInNewContext(fs.readFileSync(require.resolve("../assembly-viewport.js"),"utf8"),context);
  const viewport=Object.create(context.window.AssemblyViewport.prototype);Object.assign(viewport,{canvas:{getBoundingClientRect:()=>({left:0,top:0,width:700,height:500})},target:[0,0,400],yaw:0,pitch:Math.PI/2,scale:1200});
  const pieces=[piece(base)],sequence=[[door,[0,-256,384],0],[wall,[0,256,384],0],["Atreides_Outpost_Window_02",[256,0,384],90],["Atreides_Outpost_Wall_02",[-256,0,384],90],[floor,[0,0,768],0],[floor,[512,0,768],0],[half,[0,-256,768],0],[wall,[0,256,768],0],[roof,[0,0,960],180]];
  for(const [type,position,yaw] of sequence){const result=C.choose({candidates:C.candidates({type,yaw,pieces,known}),point:viewport.projectPoint(position).map(Math.round),project:viewport.projector(),pieces,known});assert.deepEqual(result.snap?.position,position);pieces.push(piece(type,result.snap.position,result.snap.yaw,String(pieces.length)));}
});
test("spatial occupancy index matches full scan across negative coordinates, rotated frames and slab levels",()=>{
  const types=[base,wide,wall,half,floor,roof],pieces=Array.from({length:300},(_,i)=>piece(types[i%types.length],[(i%15-7)*256,(Math.floor(i/15)-10)*256,(i%4)*384],i%3*37,String(i))),index=C.obstacleIndex(pieces,known);
  for(let i=0;i<100;i++){const original=pieces[i*7%pieces.length],c={...original,position:original.position.map((v,j)=>v+(j===0?128:0))};assert.equal(C.occupied(c,index(c),known),C.occupied(c,pieces,known));}
});
