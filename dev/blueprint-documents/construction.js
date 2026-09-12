"use strict";
// Original local project format. These IDs and transforms are editor data, not
// game records. No game import/export or blueprint normalization lives here.
const { randomUUID } = require("node:crypto");
const { TextDecoder } = require("node:util");
const { parseJsonStructure, MAX_BYTES } = require("./document");
const FoundationSnap = require("./foundation-snap");
const ConnectedSnap = require("./connected-snap");
const FORMAT = "alphanine-construction", BUILD = "24654038", LIMIT = 2500;
const clone = value => structuredClone(value);
function keys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("|") !== [...expected].sort().join("|")) throw Error("Unsupported project fields; no fields were discarded.");
}
function number(value) { if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1e7) throw Error("Project coordinates and angles must be finite numbers within ±10,000,000 (editor limit)."); }
function vector(value) { if (!Array.isArray(value) || value.length !== 3) throw Error("Expected three project coordinates."); value.forEach(number); }
function validate(value) {
  keys(value, ["format", "version", "buildId", "name", "pieces"]);
  if (value.format !== FORMAT || value.version !== 1 || value.buildId !== BUILD) throw Error("Unsupported construction project format or native mesh build.");
  if (typeof value.name !== "string" || !value.name.trim() || value.name.length > 120) throw Error("Use a project name between 1 and 120 characters.");
  if (!Array.isArray(value.pieces) || value.pieces.length > LIMIT) throw Error(`This development editor supports at most ${LIMIT} pieces.`);
  const ids = new Set();
  for (const piece of value.pieces) {
    keys(piece, ["id", "type", "position", "yaw"]);
    if (typeof piece.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(piece.id) || ids.has(piece.id)) throw Error("Invalid or duplicate local project ID.");
    ids.add(piece.id);
    if (typeof piece.type !== "string" || !piece.type.length || piece.type.length > 256) throw Error("Invalid project mesh identifier.");
    vector(piece.position); number(piece.yaw);
  }
  return value;
}
class ProjectDocument {
  #value;
  constructor(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES) throw Error("Choose a construction project under 32 MiB.");
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes).replace(/^\uFEFF/, "");
    const root = parseJsonStructure(text);
    // Our own project files use canonical JS numeric tokens. Reject rather
    // than silently round a manually supplied high-precision project number.
    function check(node) {
      if (node.type === "number" && JSON.stringify(Number(text.slice(node.start, node.end))) !== text.slice(node.start, node.end)) throw Error("Unsupported project numeric precision or spelling; use the editor-generated project format.");
      if (node.children) for (const child of node.children instanceof Map ? node.children.values() : node.children) check(child);
    }
    check(root); this.#value = validate(JSON.parse(text));
  }
  value() { return clone(this.#value); }
  summary() { return { name: this.#value.name, pieces: this.#value.pieces.length }; }
  toBuffer() { return Buffer.from(JSON.stringify(this.#value, null, 2) + "\n"); }
  static from(value) { validate(value); return new ProjectDocument(Buffer.from(JSON.stringify(value))); }
}
class Construction {
  #state; #past = []; #future = []; #saved; #available; #snapProfiles; #connectionProfiles;
  constructor(catalog, document = null) {
    if (catalog?.schema !== 1 || catalog.buildId !== BUILD || !Array.isArray(catalog.entries)) throw Error("A supported local native mesh catalog is required.");
    this.#available = new Set(catalog.entries.filter(e => e.status === "available" && e.geometry?.kind === "native-render-lod").map(e => e.id));
    this.#snapProfiles = FoundationSnap.profiles(catalog);
    this.#connectionProfiles = ConnectedSnap.profiles(catalog);
    this.#state = document ? document.value() : { format: FORMAT, version: 1, buildId: BUILD, name: "Untitled base", pieces: [] };
    validate(this.#state); this.#saved = JSON.stringify(this.#state);
  }
  document() { return ProjectDocument.from(this.#state); }
  markSaved() { this.#saved = JSON.stringify(this.#state); }
  snapshot() { return { ...clone(this.#state), canUndo: !!this.#past.length, canRedo: !!this.#future.length, dirty: JSON.stringify(this.#state) !== this.#saved }; }
  command(command) {
    if (!command || typeof command !== "object") throw Error("Invalid project command.");
    if (command.kind === "undo" || command.kind === "redo") {
      keys(command, ["kind"]);
      const from = command.kind === "undo" ? this.#past : this.#future, to = command.kind === "undo" ? this.#future : this.#past;
      if (from.length) { to.push(this.#state); this.#state = from.pop(); }
      return [];
    }
    const next = clone(this.#state); let selected = [];
    if (command.kind === "rename") { keys(command, ["kind", "name"]); next.name = command.name; }
    else if (command.kind === "add-connected") {
      keys(command,["kind","type","targetId","targetSocket","ownSocket","turn","yaw","position"]);
      vector(command.position);number(command.yaw);
      if(!this.#available.has(command.type)||typeof command.targetId!=="string"||![command.targetSocket,command.ownSocket].every(n=>Number.isInteger(n)&&n>=0&&n<100)||![0,90,120,180,240,270].includes(command.turn))throw Error("Invalid connection request.");
      const connection=ConnectedSnap.resolve(command,next.pieces,this.#connectionProfiles);
      if(!connection)throw Error("Connection is unavailable, changed or occupied. Refresh the placement preview.");
      const piece={id:randomUUID(),type:command.type,position:[...connection.position],yaw:connection.yaw};next.pieces.push(piece);selected=[piece.id];
    }
    else if (command.kind === "add" || command.kind === "add-snapped") {
      const snapping = command.kind === "add-snapped";
      keys(command, snapping ? ["kind", "type", "point", "yaw", "targetId", "edge", "previous"] : ["kind", "type", "position", "yaw"]);
      if (!this.#available.has(command.type)) throw Error("Choose an available native mesh from the palette.");
      vector(snapping ? command.point : command.position); number(command.yaw);
      let position = command.position, yaw = command.yaw;
      if (snapping) {
        if (typeof command.targetId !== "string" || !Number.isInteger(command.edge) || command.edge < 0 || command.edge > 3 || (command.previous !== null && typeof command.previous !== "string")) throw Error("Invalid socket snap target.");
        const result = FoundationSnap.find({ type: command.type, point: command.point, yaw, pieces: next.pieces, known: this.#snapProfiles, onlyTarget: command.targetId, onlyEdge: command.edge, previous: command.previous });
        if (!result.snap) throw Error("Socket snap is unavailable or occupied. Move the placement preview and try again.");
        position = result.snap.position; yaw = result.snap.yaw;
      }
      const piece = { id: randomUUID(), type: command.type, position: [...position], yaw }; next.pieces.push(piece); selected = [piece.id];
    } else {
      const fields = { move: ["delta"], rotate: ["degrees"], duplicate: ["delta"], delete: [] }[command.kind];
      if (!fields) throw Error("Unsupported project command.");
      keys(command, ["kind", "ids", ...fields]);
      if (!Array.isArray(command.ids) || !command.ids.length || new Set(command.ids).size !== command.ids.length || command.ids.some(id => !next.pieces.some(p => p.id === id))) throw Error("Select existing project pieces.");
      if (command.kind === "move" || command.kind === "duplicate") vector(command.delta);
      if (command.kind === "rotate") number(command.degrees);
      const chosen = new Set(command.ids); selected = [...chosen];
      if (command.kind === "delete") { next.pieces = next.pieces.filter(p => !chosen.has(p.id)); selected = []; }
      else for (const piece of [...next.pieces]) if (chosen.has(piece.id)) {
        if (command.kind === "move") piece.position = piece.position.map((n, i) => n + command.delta[i]);
        else if (command.kind === "rotate") piece.yaw += command.degrees;
        else { const copy = { ...piece, id: randomUUID(), position: piece.position.map((n, i) => n + command.delta[i]) }; next.pieces.push(copy); selected = selected.filter(id => id !== piece.id); selected.push(copy.id); }
      }
    }
    validate(next);
    if (JSON.stringify(next) !== JSON.stringify(this.#state)) { this.#past.push(this.#state); if (this.#past.length > 100) this.#past.shift(); this.#state = next; this.#future = []; }
    return selected;
  }
  scene(catalog) {
    const instances = [], unresolved = [];
    for (const p of this.#state.pieces) {
      const row = { key: p.id, type: p.type, raw: { local_id: JSON.stringify(p.id), position: JSON.stringify(p.position), yaw: JSON.stringify(p.yaw) } };
      if (!this.#available.has(p.type)) { unresolved.push({ ...row, reasons: ["Native mesh is absent from this local catalog"] }); continue; }
      const angle = (p.yaw % 360) * Math.PI / 360;
      instances.push({ ...row, position: [...p.position], quaternion: [0, 0, Math.sin(angle), Math.cos(angle)], scale: [1, 1, 1] });
    }
    return { entries: catalog.entries, instances, unresolved };
  }
}
module.exports = { ProjectDocument, Construction, LIMIT };
