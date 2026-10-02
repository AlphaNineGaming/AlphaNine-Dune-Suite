"use strict";
const crypto = require("crypto");
const PREFIX = "registry.funcom.com/funcom/self-hosting/";
const REF = /^registry\.funcom\.com\/funcom\/self-hosting\/(seabass-server(?:-[a-z0-9-]+)?):(\d+)(?:-\d+)?-shipping$/;
const normalize = value => String(value || "").replace(/^.*@sha256:/, "sha256:");
function references(value, refs = new Set(), builds = new Set()) {
  if (Array.isArray(value)) value.forEach(item => references(item, refs, builds));
  else if (value && typeof value === "object") Object.values(value).forEach(item => references(item, refs, builds));
  else {
    const text = String(value ?? "");
    if (text.startsWith(PREFIX) || /^sha256:[a-f0-9]{64}$/.test(text)) { refs.add(text); refs.add(normalize(text)); }
    const match = text.match(/^(\d{7,9})(?:(?:-\d+)?-shipping)?$/);
    if (match) builds.add(match[1]);
  }
  return { refs, builds };
}
function planInventory({ images, containers, workloads, battlegroups, disk }) {
  for (const [data, key] of [[images, "images"], [containers, "containers"], [workloads, "items"], [battlegroups, "items"]]) {
    if (!data || !Array.isArray(data[key])) throw new Error("Incomplete VM inventory; cleanup is disabled.");
  }
  const { refs, builds } = references([containers.containers, workloads.items, battlegroups.items]);
  // Container imageRef is a digest; the requested tag is also protected.
  for (const container of containers.containers) {
    refs.add(normalize(container.imageRef));
    refs.add(String(container.image?.image || ""));
  }
  const newest = new Map();
  for (const image of images.images) for (const tag of image.repoTags || []) {
    const match = tag.match(REF);
    if (match) { const list = newest.get(match[1]) || []; list.push(match[2]); newest.set(match[1], list); }
  }
  for (const [repo, versions] of newest) newest.set(repo, new Set([...new Set(versions)].sort((a,b) => Number(b)-Number(a)).slice(0,2)));
  const retained = [], candidates = [];
  for (const image of images.images) {
    const tags = image.repoTags || [], digests = image.repoDigests || [];
    const matches = tags.map(tag => tag.match(REF));
    if (!matches.some(Boolean)) continue;
    let reason = "";
    if (!/^sha256:[a-f0-9]{64}$/.test(image.id)) reason = "Unrecognized package identity";
    else if (image.pinned === true) reason = "Pinned by the container runtime";
    else if (!tags.length || matches.some(match => !match) || digests.some(ref => !ref.startsWith(PREFIX))) reason = "Shared with a package outside cleanup scope";
    else if ([image.id, ...tags, ...digests].some(ref => refs.has(ref) || refs.has(normalize(ref)))) reason = "Referenced by a container or workload";
    else if (matches.some(match => builds.has(match[2]))) reason = "Referenced by server configuration";
    else if (matches.some(match => newest.get(match[1]).has(match[2]))) reason = "One of the two newest versions";
    const entry = { id: image.id, tags, sizeBytes: Number(image.size) || 0, reason };
    (reason ? retained : candidates).push(entry);
  }
  return { candidates, retained, disk, imageIds: images.images.map(image => image.id), estimatedBytes: candidates.reduce((sum, image) => sum + image.sizeBytes, 0) };
}
async function readJson(execute, command) {
    const result = await execute(command);
    if (!result.ok) throw new Error(result.stderr || result.error || "VM inventory failed.");
    try { return JSON.parse(result.stdout); } catch { throw new Error("VM inventory returned invalid JSON; cleanup is disabled."); }
}
async function inventory(execute) {
  const json = command => readJson(execute, command);
  // Sequential calls keep each SSH command on the captured VM connection.
  const images = await json("sudo -n k3s crictl images -o json");
  const containers = await json("sudo -n k3s crictl ps -a -o json");
  const workloads = await json("sudo -n kubectl get pods,deployments,statefulsets,daemonsets,jobs,cronjobs,replicasets -A -o json --request-timeout=20s");
  const battlegroups = await json("sudo -n kubectl get igwbg,igwsss -A -o json --request-timeout=20s");
  const usage = await execute("sudo -n df -Pk /var/lib/rancher/k3s/agent/containerd");
  if (!usage.ok) throw new Error("Could not measure VM free space: " + (usage.stderr || usage.error || "df failed"));
  const fields = usage.stdout.trim().split(/\r?\n/).at(-1).trim().split(/\s+/);
  const availableBytes = Number(fields[3]) * 1024;
  if (!Number.isSafeInteger(availableBytes) || availableBytes < 0) throw new Error("Invalid VM disk usage response.");
  return planInventory({ images, containers, workloads, battlegroups, disk: { availableBytes } });
}
function createPackageCleanup({ now = Date.now, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const previews = new Map();
  return {
    async scan({ execute, target }) {
      const plan = await inventory(execute);
      for (const [id, preview] of previews) if (now() - preview.createdAt > 600000) previews.delete(id);
      const previewId = crypto.randomUUID();
      previews.set(previewId, { ...plan, target, createdAt: now() });
      while (previews.size > 20) previews.delete(previews.keys().next().value);
      return { ok: true, previewId, ...plan };
    },
    async clean({ execute, target, previewId, onProgress = () => {} }) {
      const preview = previews.get(previewId);
      if (!preview || preview.target !== target || now() - preview.createdAt > 600000) throw new Error("Scan again: the cleanup preview expired or the VM target changed.");
      previews.delete(previewId);
      const before = await inventory(execute), removed = [], skipped = [], errors = [];
      for (const [index, requested] of preview.candidates.entries()) {
        onProgress("Checking package " + (index + 1) + " of " + preview.candidates.length, requested.tags.join(", "));
        // Re-check all containers, desired workloads, and retained versions before each removal.
        const fresh = await inventory(execute);
        const candidate = fresh.candidates.find(image => image.id === requested.id);
        if (!candidate || JSON.stringify(candidate.tags.slice().sort()) !== JSON.stringify(requested.tags.slice().sort())) { skipped.push(requested); continue; }
        const result = await execute("sudo -n k3s crictl --timeout=120s rmi " + candidate.id, 180000);
        if (!result.ok) {
          const detail = result.stderr || result.error || result.stdout || "Removal failed";
          const timedOut = result.timedOut || /DeadlineExceeded|timed?\s*out|context deadline exceeded|RST_STREAM.*CANCEL/i.test(detail);
          if (timedOut) {
            onProgress("Checking timed-out removal", candidate.tags.join(", "));
            let absent = false, checkError = "";
            // A cancelled RPC may still complete on the runtime. Only retry read-only checks.
            for (const delay of [0, 1000, 3000, 5000]) {
              if (delay) await pause(delay);
              try {
                const imageList = await readJson(execute, "sudo -n k3s crictl --timeout=30s images -o json");
                if (!Array.isArray(imageList.images)) throw new Error("Incomplete image inventory");
                if (!imageList.images.some(image => image.id === candidate.id)) { absent = true; break; }
              } catch (error) { checkError = error.message; break; }
            }
            if (absent) { removed.push(candidate); continue; }
            errors.push({ id: candidate.id, error: checkError
              ? "A removal timed out and its result could not be verified. Scan again before continuing."
              : "A package removal timed out and the package is still present. Scan again to continue cleanup.", detail, verificationError: checkError });
          } else errors.push({ id: candidate.id, error: detail });
          break;
        }
        removed.push(candidate);
      }
      onProgress("Verifying cleanup", "Measuring free space and checking removed packages.");
      const after = await inventory(execute);
      const remainingIds = new Set(after.imageIds);
      const verified = removed.filter(image => !remainingIds.has(image.id));
      for (const image of removed) if (remainingIds.has(image.id)) errors.push({ id: image.id, error: "Package is still present after removal" });
      return { ok: errors.length === 0, removed: verified, skipped, errors, error: errors.length ? errors[0].error : undefined,
        beforeAvailableBytes: before.disk.availableBytes, afterAvailableBytes: after.disk.availableBytes,
        freedBytes: Math.max(0, after.disk.availableBytes - before.disk.availableBytes), remainingCandidates: after.candidates.length };
    }
  };
}
module.exports = { planInventory, inventory, createPackageCleanup };
