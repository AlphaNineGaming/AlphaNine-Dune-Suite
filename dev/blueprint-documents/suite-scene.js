"use strict";
const crypto=require("node:crypto");
// The display contract is recorded in the Suite's own historical JSON viewer:
// server.js at e4d5825 (blueprintExactRows / blueprintBabylonPosition).
// Native mesh coordinates need none of the removed converted-asset corrections.
// This read-only display profile is not an in-game compatibility certification.
function suiteScene(document,catalog) {
  const bytes=document.toBuffer(),sha256=crypto.createHash("sha256").update(bytes).digest("hex");
  // Catalog blueprint hashes describe extraction provenance, not eligibility
  // of another document to display the same exact native building IDs.
  if(catalog?.schema!==1||catalog.buildId!=="24654038"||!Array.isArray(catalog.entries))throw Error("Geometry catalog does not match the supported schema and game build");
  const available=new Map(catalog.entries.filter(e=>e.status==="available"&&e.geometry?.kind==="native-render-lod").map(e=>[e.id,e]));
  const instances=[],unresolved=[];
  for(const record of document.referenceRecords()){
    const fields=record.fields,type=fields.building_type?.text,reasons=[];
    if(record.group!=="instances")reasons.push("This record family has no native mesh/transform profile yet");
    if(!available.has(type))reasons.push("No matching verified native render mesh");
    if(fields.transform)reasons.push("Alternate transform representation is unsupported");
    if(fields.scale || fields.rx || fields.ry || fields.rz)reasons.push("Additional scale or Euler transform fields are unsupported for structural instances");
    const values=["x","y","z","rotation"].map(key=>{
      const token=fields[key],number=Number(token?.raw);
      if(token?.type!=="number"||!Number.isFinite(number)||Math.abs(number)>1e8)reasons.push(`Unsupported ${key} value for rendering`);
      return number;
    });
    const raw=Object.fromEntries(Object.entries(fields).map(([key,value])=>[key,value.raw]));
    const item={key:record.key,type:type||"(missing building type)",raw,sourceGroup:record.group,sourceIndex:record.index};
    if(reasons.length){unresolved.push({...item,reasons});continue;}
    const [x,y,z,yaw]=values,angle=(yaw%360)*Math.PI/360;
    instances.push({...item,position:[x,y,z],quaternion:[0,0,Math.sin(angle),Math.cos(angle)],scale:[1,1,1]});
  }
  return {schema:1,kind:"suite-structural-preview",buildId:catalog.buildId,
    name:document.summary().name,sourceSha256:sha256,
    evidence:{label:"Suite structural display convention",position:"Source X / Y / Z; Z vertical",rotation:"Source rotation interpreted as yaw in degrees, following the Suite viewer contract",
      limitation:"Native mesh origins are used directly. Runtime offsets, placement legality and in-game compatibility are not verified. No editing is enabled.",
      sources:["Suite server.js at e4d5825: blueprintExactRows, blueprintBabylonPosition", "Suite lib/blueprints.js: export transform array mapping", "Installed game 24654038: native render meshes and BuildingBlueprintDataAsset transforms"]},
    entries:catalog.entries,instances,unresolved};
}
module.exports={suiteScene};
