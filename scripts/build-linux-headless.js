const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { version } = require("../package.json");

const root = path.join(__dirname, "..");
const outputDir = path.join(root, "dist", "linux");
const packageName = `alphanine-dune-suite-${version}-linux-x64`;
const stage = path.join(outputDir, packageName);
const artifact = path.join(outputDir, `AlphaNine-Dune-Suite-${version}-linux-x64.tar.gz`);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

const files = [
  "server.js", "package.json", "package-lock.json", "README.md", "LINUX_TEST_GUIDE.md", "LICENSE",
  "manifest.webmanifest", "service-worker.js", "config.example.json", ".env.example"
];
const directories = ["assets", "data", "gear-codex", "lib", "manager", "receivers", "linux"];
for (const file of files) fs.copyFileSync(path.join(root, file), path.join(stage, file));
for (const directory of directories) fs.cpSync(path.join(root, directory), path.join(stage, directory), { recursive: true });
fs.mkdirSync(path.join(stage, "scripts"), { recursive: true });
fs.copyFileSync(path.join(root, "scripts", "set-remote-password.js"), path.join(stage, "scripts", "set-remote-password.js"));

const install = spawnSync(npmCommand, ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", path.join(root, ".npm-cache")], {
  cwd: stage,
  stdio: "inherit",
  shell: process.platform === "win32"
});
if (install.error) throw install.error;
if (install.status !== 0) process.exit(install.status || 1);

fs.rmSync(artifact, { force: true });
const packed = spawnSync("tar", ["-czf", artifact, "-C", outputDir, packageName], { cwd: root, stdio: "inherit", shell: false });
if (packed.status !== 0) process.exit(packed.status || 1);

const bytes = fs.readFileSync(artifact);
const digest = crypto.createHash("sha256").update(bytes).digest("hex");
fs.writeFileSync(`${artifact}.sha256`, `${digest}  ${path.basename(artifact)}\n`);
console.log(`Linux test artifact: ${artifact}`);
console.log(`SHA-256: ${digest}`);
