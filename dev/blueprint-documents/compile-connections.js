"use strict";
const assert=require("node:assert/strict");
const rotationNames={Normal:0,Rotated90:90,Rotated120:120,Rotated180:180,Rotated240:240,Rotated270:270};
function turns(names){return names.map(name=>{assert.ok(name.startsWith("ESocketConfiguration::"));const key=name.slice(22);assert.ok(Object.hasOwn(rotationNames,key),`Unknown native rotation: ${name}`);return rotationNames[key];});}
function yaw(q){assert.ok(Array.isArray(q)&&q.length===4&&q.every(Number.isFinite)&&q[0]===0&&q[1]===0&&Math.abs(Math.hypot(...q)-1)<1e-5,"Unsupported socket quaternion");const d=2*Math.atan2(q[2],q[3])*180/Math.PI,c=Math.round(d/90)*90;return Math.abs(d-c)<1e-4?c:d;}
function compile(audit,catalog){
  assert.equal(audit.buildId,catalog.buildId);const setups={},entries=[],unresolved=[];
  for(const [id,s] of Object.entries(audit.setups)){
    const sockets=s.sockets.map(p=>{assert.ok(p.position.length===3&&p.position.every(Number.isFinite));assert.ok(p.scale.length===3&&p.scale.every(n=>Number.isFinite(n)&&Math.abs(n-1)<1e-5));return {...p,yaw:yaw(p.quaternion),turns:turns(p.overrides.length?p.overrides:s.rotations)};});
    setups[id]={sockets,rotations:s.rotations,halfWidth:Math.max(0,...sockets.map(p=>Math.abs(p.position[0])))};
  }
  for(const e of catalog.entries){
    const row=audit.entries.find(r=>r.id===e.id&&r.table===e.tableSource.assetPath),group=audit.groups[row?.group],table=audit.tables.find(t=>t.source.assetPath===row?.table);
    assert.ok(row&&!row.excluded&&group&&table,`Missing native identity ${e.id}`);
    assert.deepEqual(table.source,e.tableSource);const setup=setups[group.socketGroup];
    if(e.status!=="available"||!setup?.sockets.length){unresolved.push({id:e.id,group:row.group,reason:e.reason||"No decoded native sockets"});continue;}
    const g=row.group,prop=key=>row.properties.find(p=>p.key===key)?.value;
    // Families are palette organization. Native setup links/classes define
    // alignment; names are never used to manufacture dimensions or sockets.
    const family=prop("m_bIsFoundation")?"base":prop("m_bIsPillar")?"pillar":g.startsWith("Stairs")||g==="Ramp_Wide"?"stair":g.startsWith("Ramp")?"ramp":g.startsWith("Railing")?"railing":g==="Ladder"?"ladder":g.startsWith("Floor")||g==="Rooftop"||g==="Hatch_Frame"?"slab":g.startsWith("Roof")&&!g.startsWith("Roof_Cover")?"slope":"wall";
    entries.push({id:e.id,group:g,socketGroup:group.socketGroup,family,source:e.source,tableSource:e.tableSource,defaultTranslate:prop("m_DefaultTranslate")});
  }
  return {data:{buildId:catalog.buildId,groupSource:audit.groups.Foundation.source,socketSource:audit.socketSource,setups,entries},unresolved};
}
module.exports={compile,yaw,turns};
