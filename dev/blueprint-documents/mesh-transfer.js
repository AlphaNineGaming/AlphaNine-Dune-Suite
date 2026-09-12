(function(r,f){if(typeof module==="object"&&module.exports)module.exports=f();else r.NativeMeshTransfer=f();})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";
  // Strings cross Electron's isolated bridge without recursively freezing
  // millions of per-vertex arrays. These are display buffers, never documents.
  const cache=new WeakMap();
  function pack(entries){return entries.map(e=>{
    if(e.status!=="available")return e;if(cache.has(e))return cache.get(e);
    const {vertices,indices,...meta}=e.geometry,positions=Buffer.alloc(vertices.length*12),triangles=Buffer.alloc(indices.length*4);
    for(let i=0;i<vertices.length;i++)for(let a=0;a<3;a++){const n=vertices[i][a];if(!Number.isFinite(n)||!Object.is(Math.fround(n),n))throw Error("Unsupported native position buffer");positions.writeFloatLE(n,i*12+a*4);}
    for(let i=0;i<indices.length;i++)triangles.writeUInt32LE(indices[i],i*4);
    const result={...e,geometry:{...meta,transfer:"a9-native-mesh-buffers/1",positionBuffer:positions.toString("base64"),indexBuffer:triangles.toString("base64"),vertexCount:vertices.length,indexCount:indices.length}};cache.set(e,result);return result;
  });}
  function unpack(entries){return entries.map(e=>{
    const g=e.geometry;if(!g?.transfer)return e;
    if(g.transfer!=="a9-native-mesh-buffers/1"||!Number.isInteger(g.vertexCount)||g.vertexCount<1||g.vertexCount>1000000||!Number.isInteger(g.indexCount)||g.indexCount<3||g.indexCount>3000000||g.indexCount%3)throw Error("Invalid native mesh transfer");
    function bytes(text,count){if(typeof text!=="string"||text.length!==4*Math.ceil(count/3))throw Error("Invalid native display buffer size");const decoded=atob(text);if(decoded.length!==count)throw Error("Invalid native display buffer");const b=new Uint8Array(count);for(let i=0;i<count;i++)b[i]=decoded.charCodeAt(i);return new DataView(b.buffer);}
    const p=bytes(g.positionBuffer,g.vertexCount*12),t=bytes(g.indexBuffer,g.indexCount*4),vertices=Array.from({length:g.vertexCount},(_,i)=>Array.from({length:3},(_,a)=>p.getFloat32(i*12+a*4,true))),indices=Array.from({length:g.indexCount},(_,i)=>t.getUint32(i*4,true));
    if(vertices.some(v=>v.some(n=>!Number.isFinite(n)))||indices.some(i=>i>=vertices.length))throw Error("Invalid transferred native geometry");
    const {transfer,positionBuffer,indexBuffer,vertexCount,indexCount,...meta}=g;return {...e,geometry:{...meta,vertices,indices}};
  });}
  return {pack,unpack};
});
