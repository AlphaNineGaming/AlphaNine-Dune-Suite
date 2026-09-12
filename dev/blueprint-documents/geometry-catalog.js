"use strict";
// Main-process only: no renderer file access, network APIs, or generic GLB loading.
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto"),assert=require("node:assert/strict");
const {localPath}=require("./local-files"),GLB=require("./native-glb");
function readFile(file,limit){
  const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.size>limit)throw Error("Choose a regular local catalog/model within the size limit");
  const bytes=fs.readFileSync(file);if(bytes.length!==s.size||bytes.length>limit)throw Error("Local catalog/model changed during reading");return bytes;
}
function loadCatalog(file){
  file=localPath(file);const catalog=JSON.parse(readFile(file,32*1024*1024).toString("utf8"));
  if(catalog.schema!==1||catalog.buildId!=="24654038"||!Array.isArray(catalog.entries)||catalog.entries.length>1024)throw Error("Unsupported native geometry catalog");
  const ids=new Set();for(const e of catalog.entries){if(typeof e?.id!=="string"||!e.id||ids.has(e.id))throw Error("Invalid or duplicate native catalog identifier");ids.add(e.id);}
  if(catalog.format===undefined)return catalog; // Existing inline native catalogs.
  if(catalog.format!=="alphanine-native-glb-library")throw Error("Unsupported native library format");
  const dir=fs.realpathSync(path.dirname(file)),models=path.join(dir,"models");
  if(fs.lstatSync(models).isSymbolicLink()||!fs.statSync(models).isDirectory())throw Error("Native models must be a local regular directory");
  let total=0;
  const entries=catalog.entries.map(entry=>{
    if(entry.status==="unresolved")return entry;
    const g=entry.glb;
    if(entry.status!=="available"||!/^models\/[a-f0-9]{64}\.glb$/.test(g?.file)||!/^[a-f0-9]{64}$/.test(g?.sha256)||!Number.isSafeInteger(g.bytes)||g.bytes<32||g.bytes>GLB.MAX)throw Error("Invalid native GLB manifest entry");
    total+=g.bytes;if(total>128*1024*1024)throw Error("Native library exceeds 128 MiB of GLBs");
    const bytes=readFile(path.join(dir,g.file),g.bytes);
    if(bytes.length!==g.bytes||crypto.createHash("sha256").update(bytes).digest("hex")!==g.sha256)throw Error(`Native GLB hash mismatch: ${entry.id}`);
    const decoded=GLB.decode(bytes),{glb,vertices,triangles,...metadata}=entry,{geometry,...actual}=decoded;
    assert.deepEqual(actual,metadata,"GLB identifier or provenance differs from its manifest");
    if(geometry.vertices.length!==vertices||geometry.indices.length/3!==triangles)throw Error("Native GLB manifest geometry counts differ");
    return decoded;
  });
  return {...catalog,entries};
}
module.exports={loadCatalog};
