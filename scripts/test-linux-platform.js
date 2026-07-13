const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const manager = fs.readFileSync(path.join(__dirname, "..", "manager", "manager-server.py"), "utf8");
const service = fs.readFileSync(path.join(__dirname, "..", "linux", "alphanine-dune-suite.service"), "utf8");
const installer = fs.readFileSync(path.join(__dirname, "..", "linux", "install.sh"), "utf8");

assert.match(server, /XDG_DATA_HOME[\s\S]*?alphanine-dune-suite/, "Linux XDG data path is missing.");
assert.match(server, /commandPath\("python3"\)/, "Python 3 discovery is missing.");
assert.match(server, /run\("sh", \["-c", `command -v ss/, "Linux listener discovery is missing.");
assert.match(server, /process\.kill\(Number\(listenerPid\), "SIGTERM"\)/, "Linux receiver termination is missing.");
assert.match(server, /Hyper-V controls are only available on Windows/, "Linux must safely report Hyper-V as unsupported.");
assert.match(server, /!release\?\.draft && !release\?\.prerelease/, "Stable updater must ignore Linux test pre-releases.");
assert.match(manager, /XDG_DATA_HOME/, "Manager Linux data path is missing.");
assert.match(manager, /os\.kill\(int\(pid\), signal\.SIGTERM\)/, "Manager Linux stale-process cleanup is missing.");
assert.match(service, /User=alphanine-suite/);
assert.match(service, /NoNewPrivileges=true/);
assert.match(service, /ProtectSystem=strict/);
assert.match(service, /ALPHANINE_DATA_DIR=\/var\/lib\/alphanine-dune-suite/);
assert.match(installer, /Node\.js 20 or newer is required/);
assert.match(installer, /chown -R root:alphanine-suite "\$INSTALL_DIR" "\$CONFIG_DIR"/, "Installed files must be readable by the service group.");
assert.match(installer, /chmod 0640 "\$CONFIG_DIR\/env"/, "Service environment permissions are incorrect.");
assert.match(installer, /systemctl enable --now alphanine-dune-suite\.service/);
const runtime = spawnSync(process.execPath, [path.join(__dirname, "test-remote-access.js")], {
  cwd: path.join(__dirname, ".."),
  env: { ...process.env, ALPHANINE_PLATFORM_OVERRIDE: "linux" },
  encoding: "utf8",
  timeout: 60000
});
assert.strictEqual(runtime.status, 0, `Linux-mode runtime integration failed:\n${runtime.stdout}\n${runtime.stderr}`);
assert.match(runtime.stdout, /Remote access HTTPS.*checks passed/);
console.log("Linux platform adapter and service hardening checks passed.");
