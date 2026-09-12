"use strict";
// Original, deliberately narrow GLB 2 writer/reader for our native mesh cache.
// No third-party model registry, loader, transforms or assets are used.
const { TextDecoder } = require("node:util");
const PROFILE = "alphanine-native-mesh/1", MAX = 32 * 1024 * 1024;
// Display convention only. Accessors retain the original native float32 values.
// The desktop reads those values directly; this node never changes game records.
const MATRIX = [0.01,0,0,0, 0,0,-0.01,0, 0,0.01,0,0, 0,0,0,1];
function encode(entry) {
  const g = entry?.geometry;
  if (typeof entry?.id !== "string" || entry.status !== "available" || g?.kind !== "native-render-lod" || !Array.isArray(g.vertices) || !g.vertices.length || g.vertices.length > 1000000 || !Array.isArray(g.indices) || !g.indices.length || g.indices.length > 3000000 || g.indices.length % 3) throw Error("Unsupported native GLB geometry");
  const low=[Infinity,Infinity,Infinity], high=[-Infinity,-Infinity,-Infinity];
  const binary = Buffer.alloc(g.vertices.length * 12 + g.indices.length * 4);
  g.vertices.forEach((v,i) => {
    if (!Array.isArray(v) || v.length !== 3) throw Error("Invalid GLB vertex");
    v.forEach((n,a) => {
      if (!Number.isFinite(n) || !Object.is(Math.fround(n),n)) throw Error("Native GLB positions must be exact finite float32 values");
      binary.writeFloatLE(n,i*12+a*4); low[a]=Math.min(low[a],n); high[a]=Math.max(high[a],n);
    });
  });
  const offset=g.vertices.length*12;
  g.indices.forEach((n,i) => { if (!Number.isSafeInteger(n) || n<0 || n>=g.vertices.length) throw Error("Invalid GLB triangle index"); binary.writeUInt32LE(n,offset+i*4); });
  const {geometry,...metadata}=entry, {vertices,indices,...nativeGeometry}=geometry;
  const json={asset:{version:"2.0",generator:"AlphaNine original native GLB writer"},
    scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0,name:entry.id,matrix:MATRIX}],
    meshes:[{name:entry.id,primitives:[{attributes:{POSITION:0},indices:1,material:0,mode:4}]}],
    materials:[{name:"AlphaNine white preview",doubleSided:true,pbrMetallicRoughness:{baseColorFactor:[1,1,1,1],metallicFactor:0,roughnessFactor:0.85}}],
    buffers:[{byteLength:binary.length}],bufferViews:[{buffer:0,byteOffset:0,byteLength:offset,target:34962},{buffer:0,byteOffset:offset,byteLength:g.indices.length*4,target:34963}],
    accessors:[{bufferView:0,componentType:5126,count:g.vertices.length,type:"VEC3",min:low,max:high},{bufferView:1,componentType:5125,count:g.indices.length,type:"SCALAR"}],
    extras:{profile:PROFILE,entry:metadata,geometry:nativeGeometry,displayConvention:"Preview only: (x,z,-y) at 0.01 scale. Native accessor coordinates/pivot retained; game units and placement compatibility are not established by this GLB."}};
  const text=Buffer.from(JSON.stringify(json)), padded=Buffer.alloc(Math.ceil(text.length/4)*4,0x20);text.copy(padded);
  const out=Buffer.alloc(28+padded.length+binary.length);
  if(out.length>MAX)throw Error("Native GLB exceeds 32 MiB");
  out.writeUInt32LE(0x46546c67,0);out.writeUInt32LE(2,4);out.writeUInt32LE(out.length,8);
  out.writeUInt32LE(padded.length,12);out.writeUInt32LE(0x4e4f534a,16);padded.copy(out,20);
  out.writeUInt32LE(binary.length,20+padded.length);out.writeUInt32LE(0x004e4942,24+padded.length);binary.copy(out,28+padded.length);
  return out;
}
function decode(bytes) {
  if(!Buffer.isBuffer(bytes)||bytes.length<32||bytes.length>MAX||bytes.readUInt32LE(0)!==0x46546c67||bytes.readUInt32LE(4)!==2||bytes.readUInt32LE(8)!==bytes.length)throw Error("Invalid native GLB header");
  const length=bytes.readUInt32LE(12),start=28+length;
  if(length%4||start>bytes.length||bytes.readUInt32LE(16)!==0x4e4f534a||bytes.readUInt32LE(24+length)!==0x004e4942||bytes.readUInt32LE(20+length)!==bytes.length-start)throw Error("Invalid native GLB chunks");
  const json=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes.subarray(20,20+length)));
  const v=json.accessors?.[0]?.count,i=json.accessors?.[1]?.count;
  if(json.extras?.profile!==PROFILE||!Number.isInteger(v)||v<1||v>1000000||!Number.isInteger(i)||i<3||i>3000000||i%3||v*12+i*4!==bytes.length-start)throw Error("Unsupported native GLB profile or buffer counts");
  const entry={...json.extras.entry,geometry:{...json.extras.geometry,
    vertices:Array.from({length:v},(_,n)=>Array.from({length:3},(_,a)=>bytes.readFloatLE(start+n*12+a*4))),
    indices:Array.from({length:i},(_,n)=>bytes.readUInt32LE(start+v*12+n*4))}};
  // Reject external URIs, extensions, altered transforms, extra fields/chunks,
  // malformed accessors and unsupported materials instead of ignoring them.
  if(!encode(entry).equals(bytes))throw Error("GLB is outside the canonical AlphaNine native profile");
  return entry;
}
module.exports={encode,decode,PROFILE,MAX};
