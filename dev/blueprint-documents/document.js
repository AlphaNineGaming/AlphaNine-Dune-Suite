"use strict";

// Original lossless JSON document implementation. Numbers are syntax tokens,
// never JS Numbers. The source text, not an import-normalized object, is saved.
const { TextDecoder } = require("node:util");
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_DEPTH = 128;
const MAX_NODES = 250000;

class DocumentError extends Error {
  constructor(message) { super(message); this.name = "DocumentError"; }
}

function parse(text) {
  let cursor = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let nodes = 0;
  const fail = (message) => { throw new DocumentError(`${message} at character ${cursor + 1}.`); };
  const whitespace = () => { while (/[\x20\t\r\n]/.test(text[cursor] || "\0")) cursor++; };
  function string() {
    const start = cursor++;
    while (cursor < text.length) {
      const char = text[cursor++];
      if (char === '"') {
        let value;
        try { value = JSON.parse(text.slice(start, cursor)); }
        catch { fail("Malformed JSON string"); }
        for (let i = 0; i < value.length; i++) {
          const code = value.charCodeAt(i);
          if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(++i);
            if (!(next >= 0xdc00 && next <= 0xdfff)) fail("Unpaired Unicode surrogate is unsupported");
          } else if (code >= 0xdc00 && code <= 0xdfff) fail("Unpaired Unicode surrogate is unsupported");
        }
        return value;
      }
      if (char === "\\") {
        const escape = text[cursor++];
        if (escape === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(cursor, cursor + 4))) fail("Malformed Unicode escape");
          cursor += 4;
        } else if (!'"\\/bfnrt'.includes(escape || "\0")) fail("Malformed JSON escape");
      } else if (char.charCodeAt(0) < 32) fail("Unescaped control character");
    }
    fail("Unterminated JSON string");
  }
  function value(depth) {
    whitespace();
    if (depth > MAX_DEPTH) fail(`Nesting beyond ${MAX_DEPTH} levels is unsupported`);
    if (++nodes > MAX_NODES) fail(`Documents beyond ${MAX_NODES} values are unsupported`);
    const start = cursor;
    const char = text[cursor];
    let node;
    if (char === "{") {
      cursor++;
      const children = new Map();
      whitespace();
      if (text[cursor] !== "}") {
        while (true) {
          whitespace();
          if (text[cursor] !== '"') fail("Expected an object key");
          const key = string();
          if (children.has(key)) fail("Duplicate object keys are unsupported");
          whitespace();
          if (text[cursor++] !== ":") fail("Expected a colon");
          children.set(key, value(depth + 1));
          whitespace();
          if (text[cursor] !== ",") break;
          cursor++;
        }
      }
      if (text[cursor++] !== "}") fail("Expected a closing object brace");
      node = { type: "object", children };
    } else if (char === "[") {
      cursor++;
      const children = [];
      whitespace();
      if (text[cursor] !== "]") {
        while (true) {
          children.push(value(depth + 1));
          whitespace();
          if (text[cursor] !== ",") break;
          cursor++;
        }
      }
      if (text[cursor++] !== "]") fail("Expected a closing array bracket");
      node = { type: "array", children };
    } else if (char === '"') {
      node = { type: "string", value: string() };
    } else {
      const literal = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(cursor));
      if (!literal) fail("Expected a JSON value");
      cursor += literal[0].length;
      node = /^(true|false|null)$/.test(literal[0])
        ? { type: "literal", value: JSON.parse(literal[0]) }
        : { type: "number" };
    }
    return { ...node, start, end: cursor };
  }
  const root = value(0);
  whitespace();
  if (cursor !== text.length) fail("Unexpected trailing content");
  return root;
}

function validateEnvelope(root) {
  if (root.type !== "object") throw new DocumentError("Blueprint JSON must be an object.");
  const names = ["instances", "placeables", "pentashields"];
  if (!names.some(name => root.children.has(name))) {
    throw new DocumentError("Unsupported blueprint envelope: expected instances, placeables, or pentashields.");
  }
  for (const name of names) {
    const node = root.children.get(name);
    // A null collection has no rows to project, but remains literal null in
    // the source. Never normalize it to [] (observed in local Fortress.json).
    if (!node || (node.type === "literal" && node.value === null)) continue;
    if (node.type !== "array" || node.children.some(row => row.type !== "object")) {
      throw new DocumentError(`Blueprint ${name} must be an array of objects or null; no values were normalized.`);
    }
  }
}

class BlueprintDocument {
  #text;
  #root;
  constructor(bytes) {
    if (!Buffer.isBuffer(bytes)) throw new DocumentError("Open requires a byte buffer.");
    if (bytes.length > MAX_BYTES) throw new DocumentError("Files over 32 MiB are unsupported.");
    try { this.#text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new DocumentError("Only valid UTF-8 JSON is supported; the file was not changed."); }
    this.#root = parse(this.#text);
    validateEnvelope(this.#root);
    Object.freeze(this);
  }
  toBuffer() { return Buffer.from(this.#text, "utf8"); }
  referenceRecords() {
    const records = [];
    for (const group of ["instances", "placeables", "pentashields"]) {
      const rows = this.#root.children.get(group)?.children || [];
      rows.forEach((row, index) => {
        const fields = Object.create(null);
        for (const key of ["instance_id", "placeable_id", "building_type", "x", "y", "z", "rotation", "rx", "ry", "rz", "transform", "scale"]) {
          const node = row.children.get(key);
          if (node) fields[key] = Object.freeze({ type: node.type, raw: this.#text.slice(node.start, node.end), ...(node.type === "string" ? { text: node.value } : {}) });
        }
        records.push(Object.freeze({ key: `${group}:${index}`, group, index, fields: Object.freeze(fields) }));
      });
    }
    return Object.freeze(records);
  }
  summary() {
    const name = this.#root.children.get("name");
    return Object.freeze({
      name: name?.type === "string" ? name.value : "Untitled blueprint",
      bytes: Buffer.byteLength(this.#text),
      ...Object.fromEntries(["instances", "placeables", "pentashields"].map(key => [key, this.#root.children.get(key)?.children?.length || 0]))
    });
  }
  // Future commands supply exact JSON tokens. No insertion, deletion, ID
  // allocation, or game transform semantics are inferred in this phase.
  replaceValue(path, jsonToken) {
    if (!Array.isArray(path) || !path.length || typeof jsonToken !== "string") {
      throw new DocumentError("Replacement requires an existing property path and exact JSON text.");
    }
    let node = this.#root;
    for (const key of path) {
      if (node?.type === "object" && typeof key === "string") node = node.children.get(key);
      else if (node?.type === "array" && Number.isSafeInteger(key) && key >= 0) node = node.children[key];
      else node = undefined;
      if (!node) throw new DocumentError("Replacement path does not exist.");
    }
    if (jsonToken.charCodeAt(0) === 0xfeff) throw new DocumentError("A BOM is only supported at the start of a file.");
    parse(jsonToken);
    return new BlueprintDocument(Buffer.from(this.#text.slice(0, node.start) + jsonToken + this.#text.slice(node.end)));
  }
}

module.exports = { BlueprintDocument, DocumentError, MAX_BYTES, parseJsonStructure: parse };
