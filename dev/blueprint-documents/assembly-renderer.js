"use strict";
const el=id=>document.getElementById(id),api=window.blueprintDocuments;
let opened=null,rows=[],filtered=[],selected=new Set(),busy=false,viewport=null;
try{viewport=new AssemblyViewport(el("viewport"),select,text=>el("draw-status").textContent=text);}catch(error){el("empty").textContent=error.message;}
function status(text,error=false){el("status").textContent=text;el("status").className=error?"error":"";}
function buttons(){el("open").disabled=busy;el("save").disabled=busy||!opened;el("focus").disabled=!rows.some(r=>r.resolved&&selected.has(r.key));window.ConstructionUI?.buttons();}
function visible(row){
  const percent=Number(el("height").value);if(percent===100)return true;
  const box=viewport?.model?.box;if(!box)return false;
  return row.position[2]<=box.low[2]+(box.high[2]-box.low[2])*percent/100;
}
function updateView(){if(window.ConstructionUI?.active())window.ConstructionUI.updateView();else viewport?.setView(selected,visible);buttons();}
function select(key,additive=false){
  if(key!==null&&!rows.some(r=>r.key===key))return;
  selected=BlueprintScene.select(selected,key,additive);
  if(el("filter").value==="selected")filter();
  const index=filtered.findIndex(r=>r.key===key),list=el("piece-list");
  if(index>=0&&(index*61<list.scrollTop||(index+1)*61>list.scrollTop+list.clientHeight))list.scrollTop=Math.max(0,index*61-list.clientHeight/2);
  renderList();inspect();updateView();
}
function filter(){const query=el("search").value.trim().toLowerCase(),mode=el("filter").value;filtered=rows.filter(r=>(!query||`${r.type} ${r.identifier} ${r.key}`.toLowerCase().includes(query))&&(mode==="all"||mode==="resolved"&&r.resolved||mode==="unresolved"&&!r.resolved||mode==="selected"&&selected.has(r.key)));el("piece-list").scrollTop=0;renderList();}
function renderList(){
  const list=el("piece-list"),start=Math.max(0,Math.floor(list.scrollTop/61)-3),end=Math.min(filtered.length,start+Math.ceil(list.clientHeight/61)+7);el("list-spacer").style.height=`${filtered.length*61}px`;
  const items=el("list-items");items.style.transform=`translateY(${start*61}px)`;items.replaceChildren();
  for(const r of filtered.slice(start,end)){const button=document.createElement("button");button.className="piece"+(selected.has(r.key)?" selected":"")+(!r.resolved?" unresolved":"");button.dataset.key=r.key;button.setAttribute("aria-pressed",String(selected.has(r.key)));button.title=r.type;const name=document.createElement("strong"),sub=document.createElement("small");name.textContent=r.type.replaceAll("_"," ");sub.textContent=`${r.identifier} · ${r.resolved?"Native mesh":"Unresolved"}`;button.append(name,sub);button.onclick=e=>select(r.key,e.ctrlKey||e.metaKey);items.append(button);}
  el("count").textContent=`${filtered.length} / ${rows.length}`;el("selection-count").textContent=`${selected.size} selected · Ctrl-click to add`;
}
function inspect(){const root=el("inspect");root.replaceChildren();const r=rows.find(r=>r.key===[...selected].at(-1));if(!r){const p=document.createElement("p");p.textContent="Select a piece in the scene or list.";root.append(p);return;}
  const title=document.createElement("h2");title.textContent=r.type;root.append(title);
  const p=document.createElement("p");p.textContent=`${selected.size} selected · ${r.key}`;root.append(p);
  if(!r.resolved){const note=document.createElement("p");note.className="warning";note.textContent=r.reasons.join("; ");root.append(note);}
  for(const [name,value] of Object.entries(r.raw)){const label=document.createElement("label"),pre=document.createElement("pre");label.textContent=name+(window.ConstructionUI?.active()?" · local project":" · original JSON");pre.textContent=value;root.append(label,pre);}
  const entry=opened?.scene?.entries.find(e=>e.id===r.type);if(entry?.source){const heading=document.createElement("h3"),source=document.createElement("p");heading.textContent="NATIVE MESH";source.textContent=entry.source.assetPath;root.append(heading,source);}
}
async function open(){if(busy)return;busy=true;buttons();try{
  let result=await api.open();if(result.canceled)return;
  window.ConstructionUI?.leave();
  opened=null;rows=[];filtered=[];selected=new Set();viewport?.setScene(null);
  if(result.error)throw Error(result.error);
  if(result.scene?.entries)result={...result,scene:{...result.scene,entries:NativeMeshTransfer.unpack(result.scene.entries)}};
  opened=result;const resolved=new Map((result.scene?.instances||[]).map(r=>[r.key,r])),unresolved=new Map((result.scene?.unresolved||[]).map(r=>[r.key,r]));
  rows=result.reference.records.map(r=>({key:r.key,type:r.typeLabel,identifier:r.fields.instance_id?.raw??r.fields.placeable_id?.raw??"No ID",raw:Object.fromEntries(Object.entries(r.fields).map(([k,v])=>[k,v.raw])),resolved:resolved.has(r.key),reasons:unresolved.get(r.key)?.reasons||[result.sceneError||"Unresolved transform"]}));
  el("height").value="100";el("height-label").textContent="All";el("search").value="";el("filter").value="all";
  el("title").textContent=result.name||result.scene?.name||"Local blueprint";
  el("summary").textContent=`${rows.length.toLocaleString()} entries · ${resolved.size.toLocaleString()} structural meshes · ${rows.length-resolved.size} unresolved`;
  el("convention").textContent="Native meshes · Suite display convention · In-game alignment not yet validated";
  el("evidence").textContent=result.scene?`${result.scene.evidence.position}. ${result.scene.evidence.rotation}. ${result.scene.evidence.limitation}`:result.sceneError;
  if(viewport&&result.scene)viewport.setScene(result.scene);
  el("empty").hidden=Boolean(viewport&&result.scene?.instances.length);if(!result.scene)el("empty").textContent=result.sceneError;
  status(`Opened locally. ${result.bytes?.toLocaleString()||"Original"} bytes preserved. Camera and selection are display state only.`);
}catch(error){status(error.message,true);el("empty").hidden=false;el("empty").textContent=error.message;el("title").textContent="No preview available";el("summary").textContent="The source file has not been changed.";
}finally{busy=false;filter();inspect();buttons();}}
el("open").onclick=open;
el("save").onclick=async()=>{if(window.ConstructionUI?.active())return window.ConstructionUI.save();if(!opened||busy)return;busy=true;buttons();try{const result=await api.saveCopy();if(result.error)throw Error(result.error);if(!result.canceled)status(`Copy saved: ${result.destination||result.path}. Original preserved.`);}catch(error){status(error.message,true);}finally{busy=false;buttons();}};
el("search").oninput=filter;el("filter").onchange=filter;el("piece-list").onscroll=renderList;
el("fit").onclick=()=>viewport?.fit();el("focus").onclick=()=>viewport?.focus();el("angle").onchange=()=>viewport?.setAngle(el("angle").value);
el("piece-color").disabled=!viewport;el("piece-color").onchange=()=>viewport?.setPieceColor(el("piece-color").value);
el("height").oninput=()=>{el("height-label").textContent=el("height").value==="100"?"All":el("height").value+"%";updateView();};
el("runtime").textContent=api.runtime.sandboxed&&api.runtime.contextIsolated?"Sandbox enabled":"Sandbox status unavailable";
new ResizeObserver(renderList).observe(el("piece-list"));
if (new URLSearchParams(location.search).get("start") !== "empty") open();
