(function(r,f){if(typeof module==="object"&&module.exports)module.exports=f(require("./connection-data"),require("./foundation-snap"));else r.ConnectedSnap=f(r.ConnectionData,r.FoundationSnap);})(typeof globalThis!=="undefined"?globalThis:this,function(Data,MathSnap){
  "use strict";
  const EPS=1e-4,rotate=MathSnap.rotate,plus=(a,b)=>a.map((v,i)=>v+b[i]),minus=(a,b)=>a.map((v,i)=>v-b[i]);
  const get=(map,key)=>Object.hasOwn(map,key)?map[key]:null;
  const straightWall=p=>p.family==="wall"&&["Wall","Wall_Half","Door_Frame","Door_Frame_Tall","Door_Frame_Wide","Door_Frame_Garage"].includes(p.socketGroup);
  const flatGuard=p=>["Floor","Angled_Half"].includes(p.socketGroup)&&["slab","slope"].includes(p.family);
  function profiles(catalog){
    const out=Object.create(null);if(catalog?.schema!==1||catalog.buildId!==Data.buildId)return out;
    for(const entry of catalog.entries||[]){const evidence=Data.entries.find(e=>e.id===entry.id);if(!evidence||entry.status!=="available"||entry.geometry?.kind!=="native-render-lod")continue;
      if(!["source","tableSource"].every(k=>["pak","assetPath","uassetSha256","uexpSha256"].every(field=>entry[k]?.[field]===evidence[k][field])))continue;
      const sockets=Data.setups[evidence.socketGroup].sockets.map(s=>({...s,position:[...s.position]})),edges=sockets.filter(s=>s.own.includes("BP_DuneBuildingSocket_C")),maxZ=Math.max(0,...edges.map(s=>s.position[2]));
      // Socket span supports an editor overlap guard, not mesh dimensions.
      const half=Data.setups[evidence.socketGroup].halfWidth;
      out[entry.id]={family:evidence.family,group:evidence.group,socketGroup:evidence.socketGroup,sockets,maxZ,half};
    }return out;
  }
  function pairAllowed(own,target,a,b){
    // The moving socket declares the target classes it accepts. Native
    // inclined railings have no own classes, and their receivers have no
    // targets; requiring reciprocity incorrectly discarded those sockets.
    // This directional alignment also occurs in the native prefab evidence.
    if(!a.target.some(type=>b.own.includes(type)))return false;
    const generic=a.target.includes("BP_DuneBuildingSocket_C")&&b.own.includes("BP_DuneBuildingSocket_C");
    if(!generic)return true;
    if(own.family==="stair"||own.family==="ramp")return ["base","slab","stair","ramp"].includes(target.family);
    if(target.family==="stair"||target.family==="ramp")return own.family==="slab";
    if(own.family==="base")return target.family==="base";
    if(own.family==="wall"&&a.position[2]!==0)return false;
    if(target.family==="wall"&&b.position[2]!==target.maxZ)return false;
    // Walls attach to horizontal levels, not an inferred roof-slope wall rule.
    if(own.family==="wall"&&target.family==="slope")return false;
    return true;
  }
  function candidates({type,yaw=0,pieces,known,targetVisible=()=>true}){
    const own=get(known,type),out=[];if(!own||!Number.isFinite(yaw))return out;
    for(const target of pieces){const other=get(known,target.type);if(!other||!targetVisible(target))continue;
      for(const b of other.sockets)for(const a of own.sockets){if(!pairAllowed(own,other,a,b))continue;
        for(const turn of [0,90,120,180,240,270]){
          if(!a.turns.includes(turn)||!b.turns.includes(turn))continue;
          // Opposing generic edges join landings without folding a stair
          // back into its landing. Side classes retain native 0/180 options.
          const generic=a.target.includes("BP_DuneBuildingSocket_C")&&b.own.includes("BP_DuneBuildingSocket_C");
          if(generic&&(["stair","ramp"].includes(own.family)||["stair","ramp"].includes(other.family))&&turn!==180)continue;
          if(generic&&(own.family==="base"||((own.family==="slab"||own.family==="slope")&&other.family!=="wall"))&&turn!==180)continue;
          const aligned=target.yaw+b.yaw-a.yaw+turn,angle=aligned+Math.round((yaw-aligned)/360)*360,socket=plus(target.position,rotate(b.position,target.yaw)),position=minus(socket,rotate(a.position,angle));
          if(position.some(n=>!Number.isFinite(n)||Math.abs(n)>1e7)||Math.abs(angle)>1e7)continue;
          const tangent=rotate([0,other.half,0],target.yaw+b.yaw),key=`${target.id}:${b.index}:${a.index}:${turn}`;
          // Only the earlier square-edge workflow has a verified straight
          // guide span. Other native connections display their exact anchor.
          const straight=["Foundation","Floor","Wall","Wall_Half","Door_Frame","Door_Frame_Tall","Door_Frame_Wide"].includes(other.socketGroup);
          const poseKey=position.map(n=>Math.round(n*1e4)).join()+":"+((angle%360+360)%360);
          out.push({key,poseKey,type,targetId:target.id,targetType:target.type,targetSocket:b.index,ownSocket:a.index,turn,inputYaw:yaw,yaw:angle,position,socket,priority:generic?0:8,line:generic&&straight?[plus(socket,tangent),minus(socket,tangent)]:[socket,socket]});
        }
      }
    }return out;
  }
  function occupied(candidate,pieces,known){
    const a=get(known,candidate.type);if(!a)return true;
    for(const p of pieces){const b=get(known,p.type);if(!b)continue;
      const same=a.socketGroup===b.socketGroup,linear=straightWall(a)&&straightWall(b),square=a.socketGroup==="Foundation"&&b.socketGroup==="Foundation",flat=flatGuard(a)&&flatGuard(b);
      if(!same&&!linear&&!square&&!flat)continue;
      const delta=minus(p.position,candidate.position),angle=(p.yaw-candidate.yaw)*Math.PI/180;
      if(same&&Math.hypot(...delta)<EPS&&Math.abs(Math.sin(angle/2))<1e-6)return true;
      if(linear){
        const local=rotate(delta,-candidate.yaw);
        if(Math.abs(Math.sin(angle))<1e-6&&Math.abs(local[1])<EPS&&Math.abs(local[0])<a.half+b.half-EPS&&Math.min(candidate.position[2]+a.maxZ,p.position[2]+b.maxZ)>Math.max(candidate.position[2],p.position[2])+EPS)return true;
      }else if(square){
        const knownBases={[candidate.type]:{group:"Foundation",half:a.half},[p.type]:{group:"Foundation",half:b.half}};
        if(MathSnap.occupied(candidate.position,candidate.yaw,candidate.type,[p],knownBases))return true;
      }else if(flat){
        if(Math.hypot(...delta)<EPS&&(a.family===b.family||a.family==="slab"||b.family==="slab"))return true;
      }
    }return false;
  }
  function obstacleIndex(pieces,known){
    const largest=Math.max(1,...Object.values(known).map(p=>p.half)),cell=largest*2,buckets=new Map(),keys=p=>["socket:"+p.socketGroup,...straightWall(p)?["wall"]:[],...flatGuard(p)?["flat"]:[]];
    for(const p of pieces){const a=get(known,p.type);if(!a)continue;for(const group of keys(a)){const key=`${group}:${Math.floor(p.position[0]/cell)}:${Math.floor(p.position[1]/cell)}`;if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(p);}}
    return c=>{const a=get(known,c.type);if(!a)return [];const radius=(a.half+largest)*Math.SQRT2,out=new Set();for(const group of keys(a))for(let x=Math.floor((c.position[0]-radius)/cell);x<=Math.floor((c.position[0]+radius)/cell);x++)for(let y=Math.floor((c.position[1]-radius)/cell);y<=Math.floor((c.position[1]+radius)/cell);y++)for(const p of buckets.get(`${group}:${x}:${y}`)||[])out.add(p);return [...out];};
  }
  // Screen-space capture is an editor choice. Geometry and document data are
  // untouched. Return alternatives so the user can cycle ambiguous connections.
  function screenIndex(all,project,radius=42){
    const cell=radius,buckets=new Map(),positions=new Map();
    for(const c of all){const center=project(c.position),anchor=project(c.socket);positions.set(c,{center,anchor});const keys=new Set([center,anchor].map(p=>`${Math.floor(p[0]/cell)}:${Math.floor(p[1]/cell)}`));for(const key of keys){if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(c);}}
    return {positions,near(point){const found=new Set(),range=radius*1.4;for(let x=Math.floor((point[0]-range)/cell);x<=Math.floor((point[0]+range)/cell);x++)for(let y=Math.floor((point[1]-range)/cell);y<=Math.floor((point[1]+range)/cell);y++)for(const c of buckets.get(`${x}:${y}`)||[])found.add(c);return [...found];}};
  }
  function choose({candidates:all,point,project,pieces,known,radius=42,previous=null,cycle=0,visible=()=>true,depth=p=>p[2],obstacles=null,screen=null}){
    const poses=new Map();let blocked=false;
    const compare=(a,b)=>Math.abs(a.score-b.score)>.001?a.score-b.score:depth(b.c.socket)-depth(a.c.socket)||a.c.key.localeCompare(b.c.key);
    for(const c of all){if(!visible(c.targetId))continue;const cached=screen?.positions.get(c),center=cached?.center||project(c.position),anchor=cached?.anchor||project(c.socket),dc=Math.hypot(center[0]-point[0],center[1]-point[1]),da=Math.hypot(anchor[0]-point[0],anchor[1]-point[1]);
      const distance=Math.min(dc,da);if(distance>radius*(c.key===previous?1.4:1))continue;
      const turnDifference=Math.abs(((c.yaw-c.inputYaw+540)%360+360)%360-180);
      const entry={c,score:distance+dc*.15+turnDifference*.002+(c.priority||0)},key=c.poseKey||c.position.map(n=>Math.round(n*1e4)).join()+":"+((c.yaw%360+360)%360),old=poses.get(key);
      if(!old||compare(entry,old)<0)poses.set(key,entry);
    }
    const near=[...poses.values()].sort(compare),unique=[],query=obstacles||obstacleIndex(pieces,known);for(const {c,score} of near){
      if(occupied(c,query(c),known)){blocked=true;continue;}unique.push({c,score});
    }
    if(!unique.length)return {snap:null,blocked,alternatives:[]};
    const options=unique.filter(v=>v.score<=unique[0].score+16),held=cycle===0&&options.find(v=>v.c.key===previous&&v.score<=unique[0].score+5);
    const selected=held||options[((cycle%options.length)+options.length)%options.length];return {snap:selected.c,blocked:false,alternatives:options.map(v=>v.c)};
  }
  function resolve(command,pieces,known){
    const target=pieces.find(p=>p.id===command.targetId);if(!target)return null;
    const result=candidates({type:command.type,yaw:command.yaw,pieces:[target],known}).find(c=>c.targetSocket===command.targetSocket&&c.ownSocket===command.ownSocket&&c.turn===command.turn);
    if(!result||occupied(result,pieces,known)||result.position.some((v,i)=>v!==command.position[i]))return null;return result;
  }
  return {profiles,candidates,choose,occupied,obstacleIndex,screenIndex,resolve};
});
