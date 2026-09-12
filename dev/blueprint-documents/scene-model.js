(function(root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.BlueprintScene = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function() {
  "use strict";
  const dot = (a,b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
  const sub = (a,b) => a.map((v,i)=>v-b[i]);
  const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  function rotate(point,q) {
    const a=cross(q,point),b=cross(q,a);
    return point.map((v,i)=>v+2*(q[3]*a[i]+b[i]));
  }
  function transform(point,instance) {
    return rotate(point.map((n,i)=>n*instance.scale[i]),instance.quaternion).map((n,i)=>n+instance.position[i]);
  }
  function bounds(points) {
    const low=[Infinity,Infinity,Infinity],high=[-Infinity,-Infinity,-Infinity];
    for(const p of points){if(!Array.isArray(p)||p.length!==3)throw Error("Invalid scene vertex");for(let a=0;a<3;a++){if(!Number.isFinite(p[a]))throw Error("Invalid scene position");low[a]=Math.min(low[a],p[a]);high[a]=Math.max(high[a],p[a]);}}
    if(!Number.isFinite(low[0]))return null;
    return {low,high,center:low.map((n,i)=>(n+high[i])/2),radius:Math.max(1,Math.hypot(...sub(high,low))/2)};
  }
  function prepared(scene) {
    const meshes=new Map(),keys=new Set();
    for(const entry of scene.entries){
      if(meshes.has(entry.id))throw Error("Duplicate scene mesh ID");
      if(entry.status!=="available")continue;
      const g=entry.geometry;
      if(!g || !Array.isArray(g.vertices) || !Array.isArray(g.indices) || g.indices.length%3 || g.indices.some(i=>!Number.isSafeInteger(i)||i<0||i>=g.vertices.length))throw Error("Invalid scene triangles");
      const box=bounds(g.vertices);if(!box)throw Error("Empty scene mesh");
      meshes.set(entry.id,{entry,box});
    }
    const rows=scene.instances.map(instance=>{
      if(keys.has(instance.key))throw Error("Duplicate scene instance key");keys.add(instance.key);
      for(const [key,count] of [["position",3],["quaternion",4],["scale",3]])if(!Array.isArray(instance[key])||instance[key].length!==count||instance[key].some(n=>!Number.isFinite(n)))throw Error("Invalid scene transform");
      if(Math.abs(Math.hypot(...instance.quaternion)-1)>1e-5 || instance.scale.some(n=>n===0))throw Error("Invalid scene rotation or scale");
      const mesh=meshes.get(instance.type);if(!mesh)return {...instance,box:null};
      const corners=Array.from({length:8},(_,i)=>transform(mesh.box.low.map((n,a)=>((i>>a)&1)?mesh.box.high[a]:n),instance));
      return {...instance,box:bounds(corners)};
    });
    return {meshes,rows,box:bounds(rows.filter(r=>r.box).flatMap(r=>[r.box.low,r.box.high]))};
  }
  function intersectsBox(origin,direction,box,limit=Infinity) {
    let near=0,far=limit;
    for(let a=0;a<3;a++){
      if(Math.abs(direction[a])<1e-14){if(origin[a]<box.low[a]||origin[a]>box.high[a])return false;continue;}
      let x=(box.low[a]-origin[a])/direction[a],y=(box.high[a]-origin[a])/direction[a];if(x>y)[x,y]=[y,x];
      near=Math.max(near,x);far=Math.min(far,y);if(far<near)return false;
    }return true;
  }
  function rayTriangle(o,d,a,b,c) {
    const ab=sub(b,a),ac=sub(c,a),p=cross(d,ac),det=dot(ab,p);
    if(Math.abs(det)<1e-12)return null;
    const t=sub(o,a),u=dot(t,p)/det;if(u<0||u>1)return null;
    const q=cross(t,ab),v=dot(d,q)/det;if(v<0||u+v>1)return null;
    const distance=dot(ac,q)/det;return distance>=0?distance:null;
  }
  function pick(model,origin,direction,visible=()=>true) {
    let result=null,nearest=Infinity;
    for(const row of model.rows){
      if(!row.box||!visible(row)||!intersectsBox(origin,direction,row.box,nearest))continue;
      // Transform the ray into mesh space once; its parameter remains world
      // distance when the input direction is unit length, including scaling.
      const q=row.quaternion,norm=dot(q,q)+q[3]*q[3];
      // Retain near-unit native values. The direct world-space path matches
      // the forward GPU/box transform without pretending the inverse is unit.
      if(Math.abs(norm-1)>1e-10){
        const g=model.meshes.get(row.type).entry.geometry;
        for(let i=0;i<g.indices.length;i+=3){const v=g.indices.slice(i,i+3).map(j=>transform(g.vertices[j],row)),hit=rayTriangle(origin,direction,...v);if(hit!==null&&hit<nearest){nearest=hit;result=row;}}
        continue;
      }
      const inverse=[-q[0],-q[1],-q[2],q[3]],o=rotate(sub(origin,row.position),inverse).map((n,i)=>n/row.scale[i]),d=rotate(direction,inverse).map((n,i)=>n/row.scale[i]);
      const g=model.meshes.get(row.type).entry.geometry;
      for(let i=0;i<g.indices.length;i+=3){const hit=rayTriangle(o,d,g.vertices[g.indices[i]],g.vertices[g.indices[i+1]],g.vertices[g.indices[i+2]]);if(hit!==null&&hit<nearest){nearest=hit;result=row;}}
    }return result?.key||null;
  }
  function select(selection,key,additive=false) {
    const next=new Set(additive?selection:[]);
    if(key!==null){if(additive&&next.has(key))next.delete(key);else next.add(key);}return next;
  }
  function frame(rows,basis,aspect){
    const corners=rows.filter(r=>r.box).flatMap(r=>Array.from({length:8},(_,i)=>r.box.low.map((n,a)=>((i>>a)&1)?r.box.high[a]:n)));
    const box=bounds(corners);if(!box)return null;
    const projected=bounds(corners.map(p=>[dot(sub(p,box.center),basis.right),dot(sub(p,box.center),basis.up),0]));
    const target=box.center.map((n,i)=>n+basis.right[i]*projected.center[0]+basis.up[i]*projected.center[1]);
    const scale=1.1*Math.max(1,(projected.high[1]-projected.low[1])/2,(projected.high[0]-projected.low[0])/(2*Math.max(.01,aspect)));
    return {target,scale,radius:box.radius};
  }
  function planePoint(origin,direction,z){
    if(!Number.isFinite(z)||Math.abs(direction[2])<1e-8)return null;
    const t=(z-origin[2])/direction[2],point=origin.map((n,i)=>n+t*direction[i]);
    return point.every(n=>Number.isFinite(n)&&Math.abs(n)<=1e7)?point:null;
  }
  return {dot,sub,cross,rotate,transform,bounds,prepared,pick,select,rayTriangle,frame,planePoint};
});
