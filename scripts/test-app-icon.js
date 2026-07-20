const assert = require("assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const mainSource = fs.readFileSync(path.join(root, "electron", "main.js"), "utf8");
const iconRelative = "assets/alphanine-suite-icon-v2.png";
const iconPath = path.join(root, ...iconRelative.split("/"));
const selectedIconSha256 = "12e014503ff98d034a8e9945eceb28c43487e02ae4e29f88c823ab015823ba76";

assert.equal(packageJson.build?.win?.icon, iconRelative, "Windows executable and installer must use the selected Suite icon.");
assert.equal(packageJson.build?.win?.signAndEditExecutable, true, "Executable resource editing must remain enabled so Windows receives the icon.");
assert.equal(packageJson.build?.win?.signExecutable, false, "Unsigned local builds should still edit Windows icon resources.");
assert.ok(packageJson.build?.files?.includes("assets/**"), "The selected icon must be bundled into every install and update package.");
assert.ok(fs.existsSync(iconPath), `Suite icon is missing: ${iconPath}`);

const signature = fs.readFileSync(iconPath).subarray(0, 8).toString("hex");
assert.equal(signature, "89504e470d0a1a0a", "Suite icon must remain a valid PNG file.");
assert.ok(fs.statSync(iconPath).size > 10000, "Suite icon appears to be empty or truncated.");
assert.equal(
  crypto.createHash("sha256").update(fs.readFileSync(iconPath)).digest("hex"),
  selectedIconSha256,
  "The selected first-design icon changed unexpectedly."
);
assert.match(mainSource, /const SUITE_ICON_PATH = path\.join\("assets", "alphanine-suite-icon-v2\.png"\)/);
assert.match(mainSource, /new BrowserWindow\(\{[\s\S]*?icon: iconPath/);
assert.match(mainSource, /tray = new Tray\(iconPath\)/);

console.log("Suite icon packaging and runtime wiring tests passed.");
