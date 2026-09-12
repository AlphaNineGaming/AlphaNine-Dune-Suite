"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { BlueprintDocument, MAX_BYTES } = require("../document");
const { createLocalFiles } = require("../local-files");
const fixture = path.join(__dirname, "../fixtures/precision.json");
const minimal = Buffer.from('{"instances":[]}');

async function sandbox(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alphanine-document-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
async function sourceFile(t, bytes = minimal) {
  const directory = await sandbox(t);
  const source = path.join(directory, "source.json");
  await fs.writeFile(source, bytes);
  return { directory, source };
}

test("no-op open/save preserves every byte, nested field, identifier, and number token", async t => {
  const bytes = await fs.readFile(fixture);
  const { directory, source } = await sourceFile(t, bytes);
  const files = createLocalFiles();
  const session = await files.open(source);
  assert.equal(session.summary.instances, 1);
  const destination = path.join(directory, "copy.json");
  const result = await files.saveCopy(session, destination);
  assert.equal(result.bytes, bytes.length);
  assert.deepEqual(await fs.readFile(source), bytes);
  assert.deepEqual(await fs.readFile(destination), bytes);
  const srcStat = await fs.stat(source);
  const copyStat = await fs.stat(destination);
  assert.notEqual(srcStat.ino, copyStat.ino, "Copy must not be hard-linked to the source");
  assert.deepEqual((await fs.readdir(directory)).sort(), ["copy.json", "source.json"]);
});

test("UTF-8 BOM, CRLF, escaped strings, negative zero, and whitespace survive", () => {
  const bytes = Buffer.from('\ufeff {\r\n"instances": [], "metadata": [1E+04, -0, 9.000, "\\u0061", "שלום"]\r\n}\t\r\n');
  assert.deepEqual(new BlueprintDocument(bytes).toBuffer(), bytes);
});

test("null collections remain literal null through local open, projection and Save Copy", async t => {
  const bytes = Buffer.from('\ufeff{\r\n"instances":[{"instance_id":9007199254740993,"unknown":{"nested":[1.0000000000000000001,null]}}],"placeables":null,"pentashields":null\r\n}\r\n');
  const { directory, source } = await sourceFile(t, bytes);
  const files = createLocalFiles(), session = await files.open(source);
  assert.equal(session.summary.instances, 1);
  assert.equal(session.summary.placeables, 0);
  assert.equal(session.summary.pentashields, 0);
  assert.deepEqual(session.document.referenceRecords().map(r => r.key), ["instances:0"]);
  const destination = path.join(directory, "null-copy.json");
  await files.saveCopy(session, destination);
  assert.deepEqual(await fs.readFile(destination), bytes);
  assert.deepEqual(await fs.readFile(source), bytes);
  await assert.rejects(files.saveCopy(session, source), /source/);
  for (const group of ["instances", "placeables", "pentashields"]) {
    const emptyBytes = Buffer.from(`{"${group}":null}`), doc = new BlueprintDocument(emptyBytes);
    assert.equal(doc.summary()[group], 0);
    assert.deepEqual(doc.referenceRecords(), []);
    assert.deepEqual(doc.toBuffer(), emptyBytes);
  }
});

test("exact-token edits create a new document and leave all untouched spans intact", async () => {
  const bytes = await fs.readFile(fixture);
  const original = new BlueprintDocument(bytes);
  const edited = original.replaceValue(["instances", 0, "x"], "12345678901234567890.000000000001");
  assert.equal(edited.toBuffer().toString(), bytes.toString().replace("0.123456789012345678901234567890", "12345678901234567890.000000000001"));
  assert.deepEqual(original.toBuffer(), bytes);
  assert.throws(() => original.replaceValue(["missing"], "1"), /does not exist/);
  assert.throws(() => original.replaceValue(["instances"], "{}"), /array of objects/);
  assert.throws(() => original.replaceValue(["name"], "NaN"), /JSON value/);
  assert.throws(() => original.replaceValue(["name"], "1,2"), /trailing/);
});

test("malformed and unsupported content fails before any copy or staging file exists", async t => {
  const { directory, source } = await sourceFile(t);
  const files = createLocalFiles();
  const invalid = [
    "", "[]", "{}", '{"instances":{}}', '{"instances":[null]}',
    '{"instances":[],"placeables":false}', '{"instances":[],"placeables":0}',
    '{"instances":[],"placeables":"null"}', '{"instances":[],"placeables":{"0":{}}}',
    '{"instances":[],}', '{"instances":[]}//comment', '{"instances":[],"x":01}',
    '{"instances":[],"x":NaN}', '{"instances":[],"x":Infinity}',
    '{"instances":[],"x":1,"\\u0078":2}', '{"instances":[],"nested":{"a":1,"a":2}}',
    '{"instances":[],"text":"\\uD800"}', '{"instances":[],"text":"\\q"}',
    '{"instances":[],"text":"a\nb"}', '{"instances":[],"text":"unterminated}',
    '{"instances":[],"deep":' + "[".repeat(130) + "0" + "]".repeat(130) + "}",
    Buffer.from([0xff, 0xfe, 0x7b, 0x00]), Buffer.from([0x7b, 0xc3, 0x28, 0x7d])
  ];
  for (const value of invalid) {
    await fs.writeFile(source, value);
    await assert.rejects(async () => {
      const session = await files.open(source);
      await files.saveCopy(session, path.join(directory, "must-not-exist.json"));
    });
    assert.deepEqual(await fs.readdir(directory), ["source.json"]);
    assert.deepEqual(await fs.readFile(source), Buffer.isBuffer(value) ? value : Buffer.from(value));
  }
});

test("oversize input and excessive value counts are explicitly rejected", () => {
  assert.throws(() => new BlueprintDocument(Buffer.alloc(MAX_BYTES + 1)), /32 MiB/);
  assert.throws(() => new BlueprintDocument(Buffer.from('{"instances":[],"a":[' + Array(250000).fill("0").join(",") + "]}")), /250000/);
});

test("source path, equivalent path, and every pre-existing destination are refused", async t => {
  const { directory, source } = await sourceFile(t);
  const files = createLocalFiles();
  const session = await files.open(source);
  await assert.rejects(files.saveCopy(session, source), /source/);
  await assert.rejects(files.saveCopy(session, path.join(directory, ".", "source.json")), /source/);
  if (process.platform === "win32") await assert.rejects(files.saveCopy(session, source.toUpperCase()), /source/);
  const existing = path.join(directory, "existing.json");
  const hardlink = path.join(directory, "alias.json");
  await fs.writeFile(existing, "pre-existing content");
  await fs.link(source, hardlink);
  await assert.rejects(files.saveCopy(session, hardlink), /existing/);
  await assert.rejects(files.saveCopy(session, existing), /existing/);
  assert.equal(await fs.readFile(existing, "utf8"), "pre-existing content");
  assert.deepEqual(await fs.readFile(source), minimal);
});

test("directory aliases cannot bypass source protection", async t => {
  const { directory, source } = await sourceFile(t);
  const alias = path.join(await sandbox(t), "alias");
  await fs.symlink(directory, alias, process.platform === "win32" ? "junction" : "dir");
  const files = createLocalFiles();
  const session = await files.open(source);
  await assert.rejects(files.saveCopy(session, path.join(alias, "source.json")), /source/);
  assert.deepEqual(await fs.readFile(source), minimal);
});

test("destination appearing during publication is not overwritten", async t => {
  const { directory, source } = await sourceFile(t);
  const destination = path.join(directory, "race.json");
  const files = createLocalFiles({ ...fs, link: async (temporary, target) => {
    await fs.writeFile(target, "another writer", { flag: "wx" });
    return fs.link(temporary, target);
  } });
  await assert.rejects(files.saveCopy(await files.open(source), destination), /appeared during save/);
  assert.equal(await fs.readFile(destination, "utf8"), "another writer");
  assert.deepEqual((await fs.readdir(directory)).sort(), ["race.json", "source.json"]);
});

for (const phase of ["write", "sync", "link"]) {
  test(`injected ${phase} failure leaves no partial destination or temporary file`, async t => {
    const { directory, source } = await sourceFile(t);
    const files = createLocalFiles({ ...fs,
      open: async (filename, flags, mode) => {
        const handle = await fs.open(filename, flags, mode);
        if (flags === "wx") {
          if (phase === "write") handle.writeFile = async bytes => {
            await handle.write(bytes.subarray(0, 5));
            throw new Error("injected partial write");
          };
          if (phase === "sync") handle.sync = async () => { throw new Error("injected flush failure"); };
        }
        return handle;
      },
      link: phase === "link" ? async () => { throw new Error("injected unsupported publication"); } : fs.link
    });
    await assert.rejects(files.saveCopy(await files.open(source), path.join(directory, "copy.json")), /Save Copy failed/);
    assert.deepEqual(await fs.readdir(directory), ["source.json"]);
    assert.deepEqual(await fs.readFile(source), minimal);
  });
}

test("a validated edited document can be saved without normalizing source IDs", async t => {
  const bytes = await fs.readFile(fixture);
  const { directory, source } = await sourceFile(t, bytes);
  const files = createLocalFiles();
  const session = await files.open(source);
  const edited = session.document.replaceValue(["name"], '"Edited local copy"');
  const destination = path.join(directory, "edited.json");
  await files.saveCopy(session, destination, edited);
  assert.deepEqual(await fs.readFile(source), bytes);
  assert.deepEqual(await fs.readFile(destination), edited.toBuffer());
  await assert.rejects(files.saveCopy({}, path.join(directory, "invalid.json")), /Open a valid/);
});

test("network share paths and URLs fail before filesystem access", async () => {
  const files = createLocalFiles({ realpath: () => { throw new Error("must not access filesystem"); } });
  for (const value of ["\\\\server\\share\\blueprint.json", "//server/share/file.json", "https://example.com/test.json", "file:///c:/test.json"]) {
    await assert.rejects(files.open(value), /local filesystem/);
  }
});

test("designer stays isolated from server APIs and only explicit runtime files are packaged", async () => {
  const root = path.join(__dirname, "../../..");
  const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  assert.ok(packageJson.build.files.includes("!dev/blueprint-documents/**"));
  assert.equal(packageJson.main, "electron/main.js");
  for (const file of ["electron/main.js", "electron/preload.js", "server.js"]) {
    assert.doesNotMatch(await fs.readFile(path.join(root, file), "utf8"), /blueprint-document:|dev[\\/]blueprint-documents/);
  }
  for (const file of ["document.js", "local-files.js", "desktop.js", "preload.js", "renderer.js"]) {
    assert.doesNotMatch(await fs.readFile(path.join(__dirname, "..", file), "utf8"), /require\(["'][^"']*(?:server|lib\/blueprints|electron\/main)["']\)|\/api\/blueprints|fetch\(|https?\.request\(/);
  }
});
