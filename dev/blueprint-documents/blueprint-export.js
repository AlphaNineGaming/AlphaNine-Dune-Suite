"use strict";
const {ProjectDocument}=require('./construction');
const {BlueprintDocument}=require('./document');
const types=require('./export-types.json');

// Project coordinates use the same XYZ / upright yaw-degrees representation
// as Suite blueprint JSON. Quantize only the exported copy to game real[].
function exportBlueprint(document,catalog){
  if(!(document instanceof ProjectDocument))throw Error('Open a valid construction project first.');
  const project=document.value();
  if(project.buildId!==types.buildId||catalog?.buildId!==types.buildId)throw Error('Project and blueprint catalog versions differ.');
  if(!project.pieces.length)throw Error('Add at least one piece before exporting a blueprint.');
  const available=new Map(catalog.entries.filter(e=>e.status==='available'&&e.geometry?.kind==='native-render-lod').map(e=>[e.id,e]));
  const instances=project.pieces.map((piece,index)=>{
    const entry=available.get(piece.type),metadata=types.entries[piece.type];
    if(!entry||!metadata||metadata.tableSha256!==entry.tableSource?.uexpSha256)throw Error('Cannot export unresolved or unsupported piece: '+piece.type+'.');
    const position=piece.position.map(v=>Math.fround(v));
    const yaw=Math.fround(((piece.yaw%360)+360)%360)%360;
    if(![...position,yaw].every(Number.isFinite))throw Error('Piece transform cannot be represented by the game: '+piece.type+'.');
    return {instance_id:index+1,building_type:piece.type,x:position[0],y:position[1],z:position[2],rotation:yaw,provides_stability:metadata.foundation};
  });
  const blueprint={name:project.name,instances,placeables:[],pentashields:[]};
  const bytes=Buffer.from(JSON.stringify(blueprint,null,2)+'\n');
  return {document:new BlueprintDocument(bytes),pieces:instances.length};
}
module.exports={exportBlueprint};
