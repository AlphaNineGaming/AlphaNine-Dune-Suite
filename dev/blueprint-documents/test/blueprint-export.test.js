const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {ProjectDocument,Construction}=require('../construction');
const {exportBlueprint}=require('../blueprint-export');
const types=require('../export-types.json');
const {normalizeBlueprint,createBlueprintService}=require('../../../lib/blueprints');
const catalog={schema:1,buildId:types.buildId,entries:Object.entries(types.entries).map(([id,m])=>({id,status:'available',tableSource:{uexpSha256:m.tableSha256},geometry:{kind:'native-render-lod',vertices:[[0,0,0],[1,0,0],[0,1,0]],indices:[0,1,2]}}))};
const base='Choam_Shelter_Foundation_New';
function project(pieces){return ProjectDocument.from({format:'alphanine-construction',version:1,buildId:types.buildId,name:'Export test',pieces:pieces.map(p=>({id:crypto.randomUUID(),type:base,position:[0,0,0],yaw:0,...p}))});}
test('all 565 palette identities export and survive Suite normalization without dropping pieces',()=>{
  const doc=project(catalog.entries.map((e,i)=>({type:e.id,position:[i*512,0,0],yaw:(i%12)*30}))),before=doc.toBuffer();
  const result=exportBlueprint(doc,catalog),value=JSON.parse(result.document.toBuffer()),normalized=normalizeBlueprint(value);
  assert.equal(normalized.instances.length,565);assert.deepEqual(doc.toBuffer(),before);
  normalized.instances.forEach((r,i)=>{assert.equal(r.id,i+1);assert.equal(r.type,catalog.entries[i].id);assert.equal(r.stability,types.entries[r.type].foundation);assert.deepEqual([r.x,r.y,r.z,r.rotation],[i*512,0,0,(i%12)*30]);});
  assert.deepEqual(value.placeables,[]);assert.deepEqual(value.pentashields,[]);
});
test('fractional snapped coordinates, negative and multiple-turn yaw convert deterministically to game real values',()=>{
  const doc=project([{position:[1/3,-512.123456,384],yaw:-90},{yaw:750}]);const a=exportBlueprint(doc,catalog).document.toBuffer(),b=exportBlueprint(doc,catalog).document.toBuffer();assert.deepEqual(a,b);
  const v=normalizeBlueprint(JSON.parse(a));assert.equal(v.instances[0].x,Math.fround(1/3));assert.equal(v.instances[0].y,Math.fround(-512.123456));assert.equal(v.instances[0].rotation,270);assert.equal(v.instances[1].rotation,30);
});
test('empty, unresolved, wrong-build and mismatched native metadata exports fail without partial output',()=>{
  assert.throws(()=>exportBlueprint(project([]),catalog),/at least one/);
  assert.throws(()=>exportBlueprint(project([{type:'Unknown'}]),catalog),/unsupported/);
  assert.throws(()=>exportBlueprint(project([{}]),{...catalog,buildId:'other'}),/versions/);
  assert.throws(()=>exportBlueprint(project([{}]),{...catalog,entries:catalog.entries.map(e=>({...e,tableSource:{uexpSha256:'wrong'}}))}),/unsupported/);
});
test('export does not mark edits saved or change undo history',()=>{
  const editor=new Construction(catalog);editor.command({kind:'add',type:base,position:[0,0,0],yaw:0});const snapshot=editor.snapshot();
  exportBlueprint(editor.document(),catalog);assert.deepEqual(editor.snapshot(),snapshot);editor.command({kind:'undo'});assert.equal(editor.snapshot().pieces.length,0);
});
test('export reaches the existing Suite transactional import with matching transforms and stability',async()=>{
  const v=JSON.parse(exportBlueprint(project([{},{type:'Choam_Shelter_Wall_01_New',position:[0,256,384]}]),catalog).document.toBuffer()),queries=[];
  const service=createBlueprintService({query:async sql=>{queries.push(sql);if(queries.length===1)return '[]';throw Error('OFFLINE_IMPORT_CAPTURE');}});
  await assert.rejects(service.importBlueprint('test-player',v,'export.json'),/OFFLINE_IMPORT_CAPTURE/);
  assert.equal(queries.length,2);assert.match(queries[1],/building_blueprint_instances/);assert.match(queries[1],/Choam_Shelter_Foundation_New/);assert.match(queries[1],/Choam_Shelter_Wall_01_New/);
});
