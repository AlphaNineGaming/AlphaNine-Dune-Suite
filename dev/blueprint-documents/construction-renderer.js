"use strict";
// UI sends bounded editor commands. The main process owns history and files.
let construction = null, constructionEntries = [], placing = false;
const GHOST = "local-placement-preview";
let snapProfiles={},snapState=null,lastPointer=null;
let connectionProfiles={},connectionCache=null,connectionCycle=0;
const librarySet=e=>e.tableSource?.assetPath?.split("/DT_BuildingData_")[1]||"Unclassified";
const setFilter=document.createElement("select");setFilter.id="palette-set";setFilter.setAttribute("aria-label","Building set");el("palette-search").after(setFilter);
for(const [value,label] of [["stair","Stairs and wide ramps"],["ramp","Ramps"],["pillar","Pillars"],["railing","Railings"],["ladder","Ladders"]]){const option=document.createElement("option");option.value=value;option.textContent=label;el("palette-category").append(option);}
const libraryCount=document.createElement("p");libraryCount.id="palette-coverage";el("palette-types").after(libraryCount);
const unavailable=document.createElement("details"),unavailableTitle=document.createElement("summary"),unavailableRows=document.createElement("div");unavailable.id="library-unresolved";unavailable.append(unavailableTitle,unavailableRows);el("palette").append(unavailable);
function libraryControls(){
  setFilter.replaceChildren();for(const value of ["all",...new Set(constructionEntries.map(librarySet))]){const option=document.createElement("option");option.value=value;option.textContent=value==="all"?"All building sets":value.replaceAll("_"," ");setFilter.append(option);}
  const missing=constructionEntries.filter(e=>e.status!=="available");unavailable.hidden=!missing.length;unavailableTitle.textContent=`${missing.length} unresolved native records`;unavailableRows.replaceChildren();
  for(const e of missing){const p=document.createElement("p");p.textContent=`${e.id}: ${e.reason||"Native mesh unavailable"}`;unavailableRows.append(p);}
}
const autoConnections=()=>el("snap-mode").value==="auto";
function clearSnap(){snapState=null;connectionCache=null;connectionCycle=0;el("snap-guide").setAttribute("hidden", "");}
function snapMessage(){
  if(autoConnections()){
    const supported=connectionProfiles[el("palette-types").value];
    el("snap-status").textContent=!construction?"":!supported?"Free placement only · connection data not verified for this piece.":!el("foundation-snap").checked?"Auto snap off · placement uses the entered Z plane.":"Point near a connection · height is automatic · R rotates · Tab cycles · Alt places freely.";
    el("place-z-label").textContent="Free Z plane";
    el("placement-help").textContent=supported?.family==="stair"?"Point at a foundation, floor edge or matching stair socket. Height is automatic. R changes facing; Tab cycles landing or side connections. Green dot marks the socket. Alt places freely.":"Green guide: click to connect. Use Top or Isometric. R changes facing; Tab chooses another nearby connection. Escape returns to selection.";
    return;
  }
  const profile=snapProfiles[el("palette-types").value];
  el("snap-status").textContent=!construction?"":!profile?"Free placement: no verified socket profile for this piece.":!el("foundation-snap").checked?"Edge snap off. Free placement.":profile.group==="Wall"?"Wall snap ready · point at a foundation edge · height set automatically · Alt bypasses.":"Foundation edge snap ready · same height · hold Alt to bypass.";
  el("place-z-label").textContent=profile?.group==="Wall"&&el("foundation-snap").checked?"Foundation Z":"Z plane";
  el("place-exact").title="Add at the exact entered X, Y, Z and yaw without snapping.";
}
function fieldNumber(id) { const value=el(id).valueAsNumber;if(!Number.isFinite(value)||Math.abs(value)>1e7)throw Error("Enter a finite coordinate or angle within the editor range.");return value; }
const coordinates = prefix => ["x","y","z"].map(axis=>fieldNumber(`${prefix}-${axis}`));
function constructionButtons(){
  for(const id of ["new-project","open-project"])el(id).disabled=busy;
  for(const id of ["palette","construction-controls"])el(id).hidden=!construction;
  el("save").textContent=construction?"Save Project":"Save Copy";
  el("export-blueprint").hidden=!construction;
  el("export-blueprint").disabled=busy||!construction?.pieces.length;
  if(!construction)return;
  el("foundation-snap").disabled=busy||!(autoConnections()?connectionProfiles:snapProfiles)[el("palette-types").value];
  for(const id of ["preview-rotate","cycle-snap"])el(id).disabled=busy||!placing;
  el("save").disabled=busy;
  for(const id of ["move-project","rotate-project","duplicate-project","delete-project"])el(id).disabled=busy||!selected.size;
  for(const id of ["rename-project","place-exact","place-mode"])el(id).disabled=busy||(id!=="rename-project"&&!el("palette-types").value);
  el("undo-project").disabled=busy||!construction.canUndo;el("redo-project").disabled=busy||!construction.canRedo;
  el("title").textContent=construction.name+(construction.dirty?" *":"");
  el("mode-badge").textContent="BLUEPRINT PROJECT";
  el("inspector-mode").textContent="LOCAL PROJECT";
}
function palette(){
  clearSnap();lastPointer=null;
  const query=el("palette-search").value.toLowerCase(),previous=el("palette-types").value,category=el("palette-category").value;
  const types=constructionEntries.filter(e=>e.status==="available"&&e.geometry?.kind==="native-render-lod"&&e.id.toLowerCase().includes(query)&&(setFilter.value==="all"||librarySet(e)===setFilter.value)&&(category==="all"||(category==="supported"?!!connectionProfiles[e.id]:connectionProfiles[e.id]?.family===category))).sort((a,b)=>a.id.localeCompare(b.id));
  libraryCount.textContent=`${types.length} shown · ${constructionEntries.filter(e=>e.status==="available").length} native meshes · ${new Set(Object.values(connectionProfiles).map(p=>p.group)).size} groups with socket alignment`;
  el("palette-types").replaceChildren(...types.map(e=>{const option=document.createElement("option");option.value=e.id;option.textContent=e.id.replaceAll("_"," ")+(connectionProfiles[e.id]?" · snap":" · free");return option;}));
  el("palette-types").value=types.some(e=>e.id===previous)?previous:types[0]?.id||"";
  if(!types.length)placing=false;
  renderConstructionScene(true);constructionButtons();snapMessage();
}
function ghost(){
  if(!placing||!el("palette-types").value)return null;
  const angle=((snapState?.snap?.yaw??fieldNumber("place-yaw"))%360)*Math.PI/360;
  return {key:GHOST,type:el("palette-types").value,position:snapState?.snap?.position||snapState?.point||coordinates("place"),quaternion:[0,0,Math.sin(angle),Math.cos(angle)],scale:[1,1,1],preview:true};
}
function renderConstructionScene(preserve=true){
  if(!construction||!viewport)return;
  let preview=null;try{preview=ghost();}catch(error){status(error.message,true);}
  const scene={...opened.scene,instances:[...opened.scene.instances,...(preview?[preview]:[])]};
  viewport.setScene(scene,preserve);viewport.setView(new Set([...selected,...(preview?[GHOST]:[])]),row=>row.preview||visible(row));
  el("empty").hidden=!!scene.instances.length;
  if(!scene.instances.length)el("empty").textContent="Choose a piece from the palette to start your base.";
  el("place-mode").setAttribute("aria-pressed",String(placing));el("place-mode").textContent=placing?"Placing · Escape to select":"Place pieces";
}
function applyConstruction(result,reset=false){
  clearSnap();lastPointer=null;
  const hadPieces=!!opened?.scene?.instances.length;
  construction=result.project;
  if(result.scene.entries){constructionEntries=NativeMeshTransfer.unpack(result.scene.entries);libraryControls();}
  snapProfiles=FoundationSnap.profiles({schema:1,buildId:construction.buildId,entries:constructionEntries});
  connectionProfiles=ConnectedSnap.profiles({schema:1,buildId:construction.buildId,entries:constructionEntries});
  opened={scene:{...result.scene,entries:constructionEntries}};
  const resolved=new Set(result.scene.instances.map(r=>r.key));
  const records=[...result.scene.instances,...result.scene.unresolved];
  rows=construction.pieces.map(p=>{const r=records.find(r=>r.key===p.id);return {...r,identifier:p.id,resolved:resolved.has(p.id),reasons:r.reasons||[]};});
  selected=new Set((result.selection?.length?result.selection:[...selected]).filter(id=>rows.some(r=>r.key===id)));
  if(reset){placing=false;selected=new Set();el("height").value="100";el("height-label").textContent="All";el("search").value="";el("filter").value="all";el("palette-search").value="";el("palette-category").value="all";el("project-name").value=construction.name;palette();}
  el("summary").textContent=`${rows.length} project pieces · ${result.scene.unresolved.length} unresolved · Export as Blueprint JSON`;
  el("convention").textContent="Local construction · Native mesh coordinates · Placement legality unverified";
  el("evidence").textContent=`${Object.keys(connectionProfiles).length} structural types have native socket alignment, including wedges, curved pieces, roofs, ramps, stairs, pillars, railings and ladders. Green lines or dots show alignment anchors. Candidate ranking and duplicate guards are editor behavior; a snap does not certify game placement legality. Animated doors are inventoried separately and need skeletal geometry support. Export uses the Suite blueprint format. Building unlocks, materials and legal placement still apply in-game. Exported files use game instance IDs; the editable project is preserved.`;
  el("project-name").value=construction.name;
  renderConstructionScene(!reset&&hadPieces);filter();inspect();buttons();snapMessage();
}
async function projectAction(action,payload){
  if(busy)return;busy=true;buttons();
  try{
    const result=await api.project(action,payload);if(result.error)throw Error(result.error);if(result.canceled)return;
    if(action==="save"){construction=result.project;status(`Project copy saved: ${result.destination}. Use Export Blueprint JSON when ready to import into the game.`);}
    else if(action==="export"){status(`Blueprint exported: ${result.destination} (${result.pieces} pieces). In Suite, open Blueprints, choose the player and import this JSON. Keep a project copy for later editing.`);}
    else{applyConstruction(result,action==="new"||action==="open");status(action==="command"?"Local project updated. Game blueprint files are unchanged.":"Construction project ready. Save an .a9project copy to keep your design.");}
  }catch(error){status(error.message,true);}finally{busy=false;buttons();}
}
function projectCommand(command){return projectAction("command",command);}
function act(callback){try{callback();}catch(error){status(error.message,true);}}
function addPiece(){return projectCommand({kind:"add",type:el("palette-types").value,position:coordinates("place"),yaw:fieldNumber("place-yaw")});}
el("new-project").onclick=()=>projectAction("new");el("open-project").onclick=()=>projectAction("open");
el("palette-search").oninput=palette;el("palette-category").onchange=palette;el("palette-types").onchange=()=>{clearSnap();lastPointer=null;renderConstructionScene(true);buttons();snapMessage();};
setFilter.onchange=palette;
el("snap-mode").onchange=()=>{clearSnap();buttons();snapMessage();if(lastPointer)act(()=>previewPlacement(...lastPointer));};
el("place-mode").onclick=()=>act(()=>{placing=!placing;clearSnap();lastPointer=null;renderConstructionScene(!!construction.pieces.length);buttons();snapMessage();if(placing)status("Gold mesh is a placement preview. Green edge marks a socket snap. Click to add; Escape cancels; Alt bypasses snapping.");});
function rotatePreview(){if(!placing||busy)return;const profile=connectionProfiles[el("palette-types").value],step=profile?.family==="wall"||["Stairs","Stairs_Half","Ramp_Wide"].includes(profile?.group)?180:90;el("place-yaw").value=String(fieldNumber("place-yaw")+step);const pointer=lastPointer;clearSnap();if(pointer)previewPlacement(...pointer);else renderConstructionScene(true);}
function cycleConnection(){if(!placing||busy||!autoConnections()||!lastPointer)return;connectionCycle++;previewPlacement(...lastPointer);}
el("preview-rotate").onclick=()=>act(rotatePreview);el("cycle-snap").onclick=()=>act(cycleConnection);
for(const id of ["place-x","place-y","place-z","place-yaw"])el(id).onchange=()=>{
  const pointer=id==="place-z"||id==="place-yaw"?lastPointer:null;
  clearSnap();lastPointer=null;renderConstructionScene(true);snapMessage();
  // Height/facing edits refresh the current hover even if the mouse remains
  // still. Explicit X/Y entry keeps its separate exact-coordinate behavior.
  if(pointer)act(()=>previewPlacement(...pointer));
};
el("foundation-snap").onchange=()=>{clearSnap();snapMessage();if(lastPointer)act(()=>previewPlacement(...lastPointer));else renderConstructionScene(true);};
el("place-exact").onclick=()=>act(()=>{clearSnap();return addPiece();});
el("rename-project").onclick=()=>projectCommand({kind:"rename",name:el("project-name").value});
for(const kind of ["undo","redo"])el(`${kind}-project`).onclick=()=>projectCommand({kind});
for(const kind of ["move","duplicate"])el(`${kind}-project`).onclick=()=>act(()=>projectCommand({kind,ids:[...selected],delta:coordinates("move")}));
el("rotate-project").onclick=()=>act(()=>projectCommand({kind:"rotate",ids:[...selected],degrees:fieldNumber("rotate-degrees")}));
el("delete-project").onclick=()=>projectCommand({kind:"delete",ids:[...selected]});
document.addEventListener("keydown",e=>{
  if(!construction||busy)return;
  if(e.key==="Escape"){placing=false;clearSnap();lastPointer=null;renderConstructionScene(true);snapMessage();return;}
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="s"){e.preventDefault();projectAction("save");return;}
  if(["INPUT","TEXTAREA","SELECT"].includes(e.target.tagName))return;
  if(placing&&!e.ctrlKey&&!e.metaKey&&(e.key.toLowerCase()==="r"||e.key==="Tab")){e.preventDefault();act(e.key==="Tab"?cycleConnection:rotatePreview);return;}
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="z"){e.preventDefault();projectCommand({kind:e.shiftKey?"redo":"undo"});}
  else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="y"){e.preventDefault();projectCommand({kind:"redo"});}
  else if(e.key==="Delete"&&selected.size){e.preventDefault();projectCommand({kind:"delete",ids:[...selected]});}
});
function drawSnapGuide(){
  const svg=el("snap-guide"),snap=snapState?.snap;
  if(!construction||!placing||!snap){svg.setAttribute("hidden", "");return;}
  const target=viewport.model?.rows.find(r=>r.key===snap.targetId);
  if(!target||!visible(target)){svg.setAttribute("hidden", "");return;}
  const canvas=el("viewport"),r=canvas.getBoundingClientRect(),parent=canvas.parentElement.getBoundingClientRect();
  Object.assign(svg.style,{left:`${r.left-parent.left}px`,top:`${r.top-parent.top}px`,width:`${r.width}px`,height:`${r.height}px`});svg.setAttribute("viewBox",`0 0 ${r.width} ${r.height}`);
  const [a,b]=snap.line.map(p=>viewport.projectPoint(p)),center=viewport.projectPoint(snap.socket);
  for(const [key,value] of Object.entries({x1:a[0],y1:a[1],x2:b[0],y2:b[1]}))el("snap-edge").setAttribute(key,value);
  el("snap-socket").setAttribute("cx",center[0]);el("snap-socket").setAttribute("cy",center[1]);svg.removeAttribute("hidden");
}
function previewPlacement(x,y,alt=false){
  if(!construction||!placing||busy)return false;
  if(lastPointer&&Math.hypot(x-lastPointer[0],y-lastPointer[1])>5)connectionCycle=0;
  lastPointer=[x,y,alt];
  if(autoConnections()&&el("foundation-snap").checked&&!alt&&connectionProfiles[el("palette-types").value])return previewConnection(x,y);
  const type=el("palette-types").value,yaw=fieldNumber("place-yaw"),previous=snapState?.snap?.key||null,snapping=!alt&&el("foundation-snap").checked,wall=snapping&&snapProfiles[type]?.group==="Wall";
  const point=viewport.planePoint(x,y,snapping?FoundationSnap.cursorHeight(type,snapProfiles,fieldNumber("place-z")):fieldNumber("place-z"));
  if(!point){clearSnap();el("snap-status").textContent="Choose Top or Isometric: this view is parallel to the Z plane.";return false;}
  const result=snapping?FoundationSnap.find({type,point,yaw,pieces:construction.pieces,known:snapProfiles,radius:Math.min(FoundationSnap.MAX_CAPTURE,2*viewport.scale/Math.max(1,el("viewport").clientHeight)*32),previous,targetVisible:p=>visible(p)}):{snap:null,blocked:false};
  snapState={...result,point,yaw,previous,requiresSnap:wall};const position=result.snap?.position||point;
  el("place-x").value=String(position[0]);el("place-y").value=String(position[1]);
  const preview=viewport.model?.rows.find(r=>r.key===GHOST);if(preview){const angle=((result.snap?.yaw??yaw)%360)*Math.PI/360;preview.position=position;preview.quaternion=[0,0,Math.sin(angle),Math.cos(angle)];viewport.uploadInstances();}
  if(result.snap)el("snap-status").textContent=`Snapped to ${result.snap.targetType.replaceAll("_"," ")} · edge ${result.snap.edge+1} · Z ${result.snap.position[2]} · yaw ${result.snap.yaw}°`;
  else if(result.blocked)el("snap-status").textContent=wall?"This wall slot is occupied. Choose another foundation edge.":"Occupied foundation footprint. Choose another edge, or hold Alt for free placement.";
  else if(alt)el("snap-status").textContent="Alt: free placement. Edge snapping bypassed.";
  else snapMessage();
  drawSnapGuide();return true;
}
function previewConnection(x,y){
  const type=el("palette-types").value,yaw=fieldNumber("place-yaw");
  if(!connectionCache||connectionCache.type!==type||connectionCache.yaw!==yaw)connectionCache={type,yaw,all:ConnectedSnap.candidates({type,yaw,pieces:construction.pieces,known:connectionProfiles}),obstacles:ConnectedSnap.obstacleIndex(construction.pieces,connectionProfiles)};
  const r=el("viewport").getBoundingClientRect(),shown=new Set(rows.filter(visible).map(p=>p.key));
  const forward=viewport.basis().forward;
  const cameraKey=JSON.stringify([viewport.target,viewport.yaw,viewport.pitch,viewport.scale,r.width,r.height]),project=viewport.projector(),cursor=[x-r.left,y-r.top];
  if(connectionCache.cameraKey!==cameraKey){connectionCache.screen=ConnectedSnap.screenIndex(connectionCache.all,project);connectionCache.cameraKey=cameraKey;}
  const result=ConnectedSnap.choose({candidates:connectionCache.screen.near(cursor),screen:connectionCache.screen,point:cursor,project,obstacles:connectionCache.obstacles,depth:p=>p.reduce((n,v,i)=>n+v*forward[i],0),pieces:construction.pieces,known:connectionProfiles,previous:snapState?.snap?.key,cycle:connectionCycle,visible:id=>shown.has(id)});
  const free=viewport.planePoint(x,y,fieldNumber("place-z")),point=result.snap?.position||free;
  snapState={...result,point,yaw,connected:true,requiresSnap:construction.pieces.length>0||connectionProfiles[type].family!=="base"};
  if(point){el("place-x").value=String(point[0]);el("place-y").value=String(point[1]);const preview=viewport.model?.rows.find(row=>row.key===GHOST);if(preview){const angle=((result.snap?.yaw??yaw)%360)*Math.PI/360;preview.position=point;preview.quaternion=[0,0,Math.sin(angle),Math.cos(angle)];viewport.uploadInstances();}}
  if(result.snap){el("snap-status").textContent=`Connected to ${result.snap.targetType.replaceAll("_"," ")} · Z ${result.snap.position[2]} · yaw ${result.snap.yaw}° · ${result.alternatives.length} nearby choices (Tab)`;status("Connection ready. Click to place; R changes facing, Tab changes connection.");}
  else el("snap-status").textContent=result.blocked?"Connection occupied. Choose another socket.":snapState.requiresSnap?"Move closer to a supported edge or wall top. Alt bypasses snapping.":"Place the first foundation on the free Z plane.";
  drawSnapGuide();return !!point;
}
for(const event of ["keydown","keyup"])document.addEventListener(event,e=>{if(e.key==="Alt"&&lastPointer&&construction&&placing&&!busy){e.preventDefault();act(()=>previewPlacement(lastPointer[0],lastPointer[1],event==="keydown"));}});
window.addEventListener("blur",()=>{clearSnap();lastPointer=null;});
if(viewport){
  viewport.onDraw=drawSnapGuide;
  viewport.onHover=(x,y,alt)=>act(()=>previewPlacement(x,y,alt));
  viewport.onClick=(x,y,alt)=>{
    if(!construction||!placing)return false;
    if(!busy)act(()=>{if(!previewPlacement(x,y,alt))return;if(snapState.blocked)throw Error("This snap position is occupied. No piece was added.");
      if(snapState.requiresSnap&&!snapState.snap)throw Error("Move to a supported connection, or hold Alt for free placement.");
      if(snapState.connected&&snapState.snap){const s=snapState.snap;projectCommand({kind:"add-connected",type:s.type,targetId:s.targetId,targetSocket:s.targetSocket,ownSocket:s.ownSocket,turn:s.turn,yaw:s.inputYaw,position:s.position});}
      else if(snapState.snap)projectCommand({kind:"add-snapped",type:el("palette-types").value,point:snapState.point,yaw:snapState.yaw,targetId:snapState.snap.targetId,edge:snapState.snap.edge,previous:snapState.previous});else addPiece();
    });
    return true;
  };
}
el("export-blueprint").onclick=()=>projectAction("export");
window.ConstructionUI={active:()=>!!construction,buttons:constructionButtons,save:()=>projectAction("save"),updateView:()=>viewport?.setView(new Set([...selected,...(placing?[GHOST]:[])]),r=>r.preview||visible(r)),leave:()=>{clearSnap();lastPointer=null;construction=null;placing=false;constructionEntries=[];snapProfiles={};el("mode-badge").textContent="BLUEPRINT VIEWER";el("inspector-mode").textContent="READ ONLY";}};
buttons();
