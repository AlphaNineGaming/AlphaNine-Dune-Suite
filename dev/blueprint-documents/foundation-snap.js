(function(root,factory){if(typeof module==="object"&&module.exports)module.exports=factory();else root.FoundationSnap=factory();})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";
  // Factual native data from build 24654038; see FOUNDATION_SNAPPING.md.
  // Socket setup Foundation: four BP_DuneBuildingSocket_C edge transforms.
  // This is editor alignment only, not a game placement/collision validator.
  const SOURCES={
    Atreides_Outpost_Foundation:["d426942e9c74733d76d226c95a0a72867174917a471f1771693331daa9cf7406","635de44e456a4a2840c0e3bff194bd357730bce60d23c806f91ead33f3f5190e","8af1ab72e84df4159806d348c736b2fef5844405f1e91ef8369d2252bf048401","ac320b0f6f03c3191899d9590d9bc81d0158c42d42cdba4b294d9268ec45cddd"],
    MTX_Smug_Foundation:["1460ebbe4bac1ffaca085e65abbd591a94233a750da01048f8bedfabfae39273","d153e12b1180fd2b360f62b8435b75dcf953f3135f5eb0c58eb8fd5abdf09763","e59b94b51b9502acf933de006aab90e3920dd45146794f85aa38e524d71e2dd3","82423b90a792a4fd32728236bfca15ded24bfe1208974528134b3c7d85ed3611"]
  };
  const EDGES=[[0,-256,384],[0,256,384],[256,0,384],[-256,0,384]];
  const WALL_SOURCES={
    Atreides_Outpost_Wall_01:["9803b03081685809791402e85137404718fe15867f7a970ee988e29a4f1641f8","a7e4cddb946dbcece32d6fcf33924a56cf58bcae338ca5925bc6f541cdedd618"],
    Atreides_Outpost_Wall_02:["48c7a7d83158a8bba748bdb5930ba41383e946859acaf8f377296295027327f5","f976323ef23996436bc3cd55af0ea760758360e0addd32e798b903b7aaa51c19"],
    Atreides_Outpost_Wall_03:["91d6e304e7af799201cd0c4933e6e5415ed92959ebfb723338b4690fb46bae36","cb8a88ce58b1e2809908131957e8dd062184b1f4378e525f607e3fb04f8be633"],
    Atreides_Outpost_Wall_04:["7a4f1cee9ea1d14b6dcfce853cb27ee1febe85803e5d6ecd98e8fbe7fdb1508d","eef5e5168b7b2b5348454c5590f398a094b966285b99bf95282ffb3bf8158dc6"],
    MTX_Atre_BreakfastRoom_Wall_01:["ffb0cd80fce2e40234b346e862f152d3787a5051d63f876328c435d29b6b7f9a","4b4f4e7e09c82e3cedeec2e22d02084bc61c80cc77641580f92cfdbc794ad246"]
  };
  const MAX_CAPTURE=96,RELEASE_FACTOR=1.5,EPS=1e-4;
  const get=(known,type)=>Object.hasOwn(known,type)?known[type]:null;
  function profiles(catalog){
    if(catalog?.schema!==1||catalog.buildId!=="24654038")return {};
    const result=Object.create(null);
    for(const e of catalog.entries||[]){const hashes=get(SOURCES,e.id);if(hashes&&e.status==="available"&&e.geometry?.kind==="native-render-lod"&&[e.source?.uassetSha256,e.source?.uexpSha256,e.tableSource?.uassetSha256,e.tableSource?.uexpSha256].every((v,i)=>v===hashes[i]))result[e.id]={group:"Foundation",half:256,edges:EDGES.map(p=>[...p])};}
    for(const e of catalog.entries||[]){const mesh=get(WALL_SOURCES,e.id),hashes=mesh&&[...mesh,...SOURCES.Atreides_Outpost_Foundation.slice(2)];if(hashes&&e.status==="available"&&e.geometry?.kind==="native-render-lod"&&[e.source?.uassetSha256,e.source?.uexpSha256,e.tableSource?.uassetSha256,e.tableSource?.uexpSha256].every((v,i)=>v===hashes[i]))result[e.id]={group:"Wall",bottom:[0,0,0],bottomYaw:90};}
    return result;
  }
  function rotate(p,yaw){const degrees=((yaw%360)+360)%360,a=degrees*Math.PI/180,index=degrees/90,c=Number.isInteger(index)?[1,0,-1,0][index]:Math.cos(a),s=Number.isInteger(index)?[0,1,0,-1][index]:Math.sin(a);return [p[0]*c-p[1]*s,p[0]*s+p[1]*c,p[2]];}
  const plus=(a,b)=>a.map((n,i)=>n+b[i]);
  const dot=(a,b)=>a[0]*b[0]+a[1]*b[1];
  function valid(p){return Array.isArray(p)&&p.length===3&&p.every(n=>Number.isFinite(n)&&Math.abs(n)<=1e7);}
  // Socket footprint overlap at the same origin elevation; intentionally not
  // mesh collision or overlap detection against other building families.
  function occupied(position,yaw,type,pieces,known){
    const a=get(known,type);if(a?.group!=="Foundation")return false;
    const ax=rotate([1,0,0],yaw),ay=rotate([0,1,0],yaw);
    return pieces.some(p=>{
      const b=get(known,p.type);if(b?.group!=="Foundation"||Math.abs(p.position[2]-position[2])>EPS||Math.hypot(p.position[0]-position[0],p.position[1]-position[1])>2*(a.half+b.half))return false;
      const bx=rotate([1,0,0],p.yaw),by=rotate([0,1,0],p.yaw),delta=p.position.map((n,i)=>n-position[i]);
      return [ax,ay,bx,by].every(axis=>Math.abs(dot(delta,axis))<a.half*(Math.abs(dot(ax,axis))+Math.abs(dot(ay,axis)))+b.half*(Math.abs(dot(bx,axis))+Math.abs(dot(by,axis)))-EPS);
    });
  }
  function cursorHeight(type,known,base){return base+(get(known,type)?.group==="Wall"?EDGES[0][2]:0);}
  function wallOccupied(position,yaw,pieces,known){return pieces.some(p=>get(known,p.type)?.group==="Wall"&&Math.hypot(...p.position.map((n,i)=>n-position[i]))<EPS&&Math.abs(Math.sin((p.yaw-yaw)*Math.PI/180))<1e-6);}
  function findWall({type,point,yaw,pieces,known,radius,previous,onlyTarget,onlyEdge,targetVisible}){
    const profile=get(known,type),candidates=[];let blocked=false;
    for(const target of pieces){const other=get(known,target.type);if(other?.group!=="Foundation"||!targetVisible(target)||(onlyTarget&&target.id!==onlyTarget))continue;
      for(let edge=0;edge<other.edges.length;edge++){
        if(onlyEdge!==null&&edge!==onlyEdge)continue;
        const local=other.edges[edge],socket=plus(target.position,rotate(local,target.yaw));
        if(Math.abs(point[2]-socket[2])>EPS)continue;
        const baseYaw=target.yaw+Math.atan2(local[1],local[0])*180/Math.PI-profile.bottomYaw,alignedYaw=baseYaw+Math.round((yaw-baseYaw)/180)*180;
        const position=socket.map((n,i)=>n-rotate(profile.bottom,alignedYaw)[i]),distance=Math.hypot(...position.map((n,i)=>n-point[i])),key=`${target.id}:${edge}:wall`,limit=key===previous?radius*RELEASE_FACTOR:radius;
        if(distance>limit||!valid(position))continue;
        if(wallOccupied(position,alignedYaw,pieces,known)){blocked=true;continue;}
        const normal=rotate([local[0]/other.half,local[1]/other.half,0],target.yaw),tangent=[-normal[1]*other.half,normal[0]*other.half,0];
        candidates.push({key,targetId:target.id,targetType:target.type,edge,own:0,position,yaw:alignedYaw,distance,socket,line:[plus(socket,tangent),socket.map((n,i)=>n-tangent[i])]});
      }
    }
    candidates.sort((a,b)=>a.distance-b.distance||a.key.localeCompare(b.key));const snap=candidates.find(c=>c.key===previous)||candidates[0]||null;
    return {snap,blocked:!snap&&blocked};
  }
  function find({type,point,yaw,pieces,known,radius=MAX_CAPTURE,previous=null,onlyTarget=null,onlyEdge=null,targetVisible=()=>true}){
    const profile=get(known,type);if(!profile||!valid(point)||!Number.isFinite(yaw))return {snap:null,blocked:false};
    radius=Math.max(0,Math.min(MAX_CAPTURE,Number.isFinite(radius)?radius:0));
    if(profile.group==="Wall")return findWall({type,point,yaw,pieces,known,radius,previous,onlyTarget,onlyEdge,targetVisible});
    const candidates=[];let blockedNear=false;
    for(const target of pieces){
      const other=get(known,target.type);if(other?.group!=="Foundation"||!targetVisible(target)||onlyTarget&&target.id!==onlyTarget||Math.abs(target.position[2]-point[2])>EPS)continue;
      if(Math.hypot(target.position[0]-point[0],target.position[1]-point[1])>other.half*2+profile.half*2+radius*RELEASE_FACTOR)continue;
      const alignedYaw=target.yaw+Math.round((yaw-target.yaw)/90)*90;
      for(let edge=0;edge<other.edges.length;edge++){
        if(onlyEdge!==null&&edge!==onlyEdge)continue;
        const local=other.edges[edge],normal=rotate([local[0]/other.half,local[1]/other.half,0],target.yaw),socket=plus(target.position,rotate(local,target.yaw));
        for(let own=0;own<profile.edges.length;own++){
          const offset=profile.edges[own],ownNormal=rotate([offset[0]/profile.half,offset[1]/profile.half,0],alignedYaw);
          if(dot(normal,ownNormal)>-1+1e-8)continue;
          const rotated=rotate(offset,alignedYaw),position=socket.map((n,i)=>n-rotated[i]),distance=Math.hypot(...position.map((n,i)=>n-point[i]));
          const key=`${target.id}:${edge}:${own}`,limit=key===previous?radius*RELEASE_FACTOR:radius;
          if(distance>limit||!valid(position))continue;
          if(occupied(position,alignedYaw,type,pieces,known)){blockedNear=true;continue;}
          const tangent=[-normal[1]*other.half,normal[0]*other.half,0];
          candidates.push({key,targetId:target.id,targetType:target.type,edge,own,position,yaw:alignedYaw,distance,socket,line:[plus(socket,tangent),socket.map((n,i)=>n-tangent[i])]});
        }
      }
    }
    candidates.sort((a,b)=>a.distance-b.distance||a.key.localeCompare(b.key));
    const snap=candidates.find(c=>c.key===previous)||candidates[0]||null;
    return {snap,blocked:!snap&&(blockedNear||occupied(point,yaw,type,pieces,known))};
  }
  return {profiles,find,occupied,wallOccupied,cursorHeight,rotate,MAX_CAPTURE,RELEASE_FACTOR};
});
