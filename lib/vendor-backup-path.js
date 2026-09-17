"use strict";
const path = require("path").posix;

// Resolve only the successful operation's own dump pod and bound storage.
async function resolveDumpVolumePath(operation, identity, readResource) {
  const { name, namespace, uid } = operation.metadata || {};
  if (!name || !namespace || !uid) throw Error("Backup operation identity is incomplete.");
  const pod = await readResource("pod", `${name}-pod`, namespace);
  if (pod.metadata?.namespace !== namespace || pod.status?.phase !== "Succeeded" ||
      !pod.metadata?.ownerReferences?.some(o => o.kind === "DatabaseOperation" && o.name === name && o.uid === uid)) {
    throw Error("Backup dump pod is not the successful operation's own completed pod.");
  }
  const candidates = [];
  for (const container of pod.spec?.containers || []) {
    const args = [...(container.command || []), ...(container.args || [])];
    const dumps = args.filter(a => a.startsWith("--dump_path=")).map(a => a.slice(12));
    for (const dump of dumps) {
      if (!path.isAbsolute(dump) || dump.split("/").includes("..") || path.basename(dump) !== identity.fileName) continue;
      for (const mount of container.volumeMounts || []) {
        const root = path.resolve("/", mount.mountPath || "");
        const relative = path.relative(root, dump);
        if (!relative || relative.startsWith("../") || path.isAbsolute(relative) || mount.subPathExpr) continue;
        const sub = mount.subPath || "";
        if (path.isAbsolute(sub) || sub.split("/").includes("..")) continue;
        const volume = (pod.spec.volumes || []).find(v => v.name === mount.name);
        const claimName = volume?.persistentVolumeClaim?.claimName;
        if (claimName) candidates.push({ claimName, relative: path.join(sub, relative) });
      }
    }
  }
  if (candidates.length !== 1) throw Error("Backup dump storage mapping is missing or ambiguous.");
  const mapping = candidates[0];
  const pvc = await readResource("pvc", mapping.claimName, namespace);
  if (pvc.metadata?.namespace !== namespace || pvc.metadata?.name !== mapping.claimName || pvc.status?.phase !== "Bound" || !pvc.spec?.volumeName) throw Error("Backup storage claim is not bound.");
  const pv = await readResource("pv", pvc.spec.volumeName);
  const claim = pv.spec?.claimRef;
  if (!pvc.metadata?.uid || claim?.uid !== pvc.metadata.uid || claim.name !== mapping.claimName || claim.namespace !== namespace) throw Error("Backup volume does not belong to the dump storage claim.");
  const root = pv.spec?.local?.path || pv.spec?.hostPath?.path;
  if (!root || !path.isAbsolute(root) || root.split("/").includes("..")) throw Error("Backup volume is not supported local VM storage.");
  return { ...identity, path: path.join(root, mapping.relative), source: "database-operation-dump-pod-volume" };
}
module.exports = { resolveDumpVolumePath };
