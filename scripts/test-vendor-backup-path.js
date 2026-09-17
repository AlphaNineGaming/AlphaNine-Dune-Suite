"use strict";
const assert = require("assert/strict");
const { resolveDumpVolumePath } = require("../lib/vendor-backup-path");
function fixture() {
 return {
  pod: {metadata:{namespace:"ns",ownerReferences:[{kind:"DatabaseOperation",name:"dump",uid:"op"}]},status:{phase:"Succeeded"},spec:{containers:[{args:["--dump_path=/root/Saved/DatabaseDumps/test.backup"],volumeMounts:[{name:"data",mountPath:"root/Saved/DatabaseDumps/",subPath:"Saved/DatabaseDumps"}]}],volumes:[{name:"data",persistentVolumeClaim:{claimName:"claim"}}]}},
  pvc: {metadata:{namespace:"ns",name:"claim",uid:"claim-id"},status:{phase:"Bound"},spec:{volumeName:"pv"}},
  pv: {spec:{claimRef:{namespace:"ns",name:"claim",uid:"claim-id"},local:{path:"/storage/pvc"}}}
 };
}
const op={metadata:{name:"dump",namespace:"ns",uid:"op"}};
const identity={fileName:"test.backup",path:"/old/test.backup"};
async function resolve(f) {return resolveDumpVolumePath(op,identity,async kind=>f[kind]);}
(async()=>{
 assert.equal((await resolve(fixture())).path,"/storage/pvc/Saved/DatabaseDumps/test.backup");
 for(const mutate of [
 f=>f.pod.metadata.ownerReferences[0].uid="other",
 f=>f.pod.status.phase="Running",
 f=>f.pod.spec.containers[0].args=["--dump_path=/root/Saved/DatabaseDumps/other.backup"],
 f=>f.pod.spec.containers[0].volumeMounts[0].subPath="../escape",
 f=>f.pod.spec.containers.push(f.pod.spec.containers[0]),
 f=>f.pvc.status.phase="Pending",
 f=>f.pv.spec.claimRef.uid="wrong",
 f=>delete f.pv.spec.local
 ]) {const f=fixture();mutate(f);await assert.rejects(resolve(f));}
 console.log("PASS: updated vendor dump volume, relative mount path, ownership, filename, traversal, ambiguity and binding guards");
})().catch(e=>{console.error(e);process.exitCode=1;});
