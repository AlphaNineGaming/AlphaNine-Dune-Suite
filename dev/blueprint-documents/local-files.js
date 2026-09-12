"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { BlueprintDocument, MAX_BYTES } = require("./document");

function samePath(a, b) {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function localPath(value) {
  if (typeof value !== "string" || !value.trim() || /^(?:[\\/]{2}|[a-z][a-z0-9+.-]*:\/\/)/i.test(value)) {
    throw new Error("Choose a local filesystem path; URLs and network share paths are unsupported.");
  }
  return path.resolve(value);
}

// No server modules, normalizer, credentials, or database adapters here.
function createLocalFiles(io = fs, Document = BlueprintDocument) {
  const sessions = new WeakMap();
  async function open(sourcePath) {
    const source = await io.realpath(localPath(sourcePath));
    localPath(source);
    const handle = await io.open(source, "r");
    let bytes;
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error("Choose a regular local JSON file.");
      if (stat.size > MAX_BYTES) throw new Error("Files over 32 MiB are unsupported.");
      const buffer = Buffer.alloc(Math.min(stat.size + 1, MAX_BYTES + 1));
      let offset = 0;
      while (offset < buffer.length) {
        const result = await handle.read(buffer, offset, buffer.length - offset, null);
        if (!result.bytesRead) break;
        offset += result.bytesRead;
      }
      if (offset !== stat.size) throw new Error("The file changed while opening; reopen the completed file.");
      bytes = buffer.subarray(0, offset);
    } finally { await handle.close(); }
    const document = new Document(bytes);
    const session = Object.freeze({ source, document, summary: document.summary() });
    sessions.set(session, { source, openedPath: path.resolve(sourcePath) });
    return session;
  }

  async function saveCopy(session, destinationPath, document = session?.document) {
    const original = sessions.get(session);
    if (!original || !(document instanceof Document)) throw new Error("Open a valid local blueprint first.");
    // Revalidate before creating any file, even for future edited documents.
    const bytes = new Document(document.toBuffer()).toBuffer();
    const requested = localPath(destinationPath);
    const directory = await io.realpath(path.dirname(requested));
    localPath(directory);
    const destination = path.join(directory, path.basename(requested));
    if ((original.openedPath && samePath(requested, original.openedPath)) || (original.source && samePath(destination, original.source))) {
      throw new Error("Save Copy cannot overwrite the source. Choose a new file name.");
    }
    // Colon rejects Windows alternate data streams; trailing dots/spaces and
    // device names have alias semantics rather than ordinary file semantics.
    const basename = path.basename(destination);
    if (process.platform === "win32" && (/[<>:"|?*\x00-\x1f]/.test(basename) || /[. ]$/.test(basename)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(basename))) {
      throw new Error("Choose a regular destination filename; device names and alternate streams are unsupported.");
    }
    try {
      await io.lstat(destination);
      throw new Error("Save Copy requires a new destination; existing files and links are never overwritten.");
    } catch (error) { if (error.code !== "ENOENT") throw error; }

    const temporary = path.join(directory, `.alphanine-copy-${crypto.randomUUID()}.tmp`);
    let handle;
    let created = false;
    let published = false;
    let failure;
    let cleanupWarning = "";
    try {
      handle = await io.open(temporary, "wx", 0o600);
      created = true;
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      // Same-directory hard-link publication is atomic and refuses an existing
      // destination, including one created after the check above. rename() can
      // overwrite files; there is deliberately no unsafe fallback.
      await io.link(temporary, destination);
      published = true;
    } catch (error) {
      failure = new Error(error.code === "EEXIST"
        ? "The destination appeared during save. Nothing was overwritten. Choose a new file name."
        : `Save Copy failed: ${error.message}. Atomic no-overwrite publication requires a filesystem with hard-link support.`);
    } finally {
      if (handle) await handle.close().catch(() => {});
      if (created) {
        try { await io.unlink(temporary); }
        catch (error) { cleanupWarning = `Temporary file cleanup failed at ${temporary}: ${error.message}`; }
      }
    }
    if (failure) {
      if (cleanupWarning) failure.message += ` ${cleanupWarning}`;
      throw failure;
    }
    return { destination, bytes: bytes.length, published, cleanupWarning };
  }
  function create(document) {
    if (!(document instanceof Document)) throw new Error("Invalid local document.");
    const session = Object.freeze({ source: null, document, summary: document.summary() });
    sessions.set(session, { source: null, openedPath: null });
    return session;
  }
  return { open, saveCopy, create };
}

module.exports = { createLocalFiles, localPath };
