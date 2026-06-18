const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const outputDir = path.join(root, "installer-output");
const appExe = path.join(outputDir, "win-unpacked", `${packageJson.build.productName}.exe`);
const installerExe = path.join(outputDir, `${packageJson.build.productName} Setup ${packageJson.version}.exe`);
const requiredLevel = "requireAdministrator";

function findRcedit() {
  const cacheRoot = path.join(process.env.LOCALAPPDATA || "", "electron-builder", "Cache", "winCodeSign");
  if (fs.existsSync(cacheRoot)) {
    for (const entry of fs.readdirSync(cacheRoot)) {
      const candidate = path.join(cacheRoot, entry, "rcedit-x64.exe");
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error(`electron-builder rcedit-x64.exe was not found under ${cacheRoot}`);
}

function assertFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} was not found: ${filePath}`);
  }
}

function verifyExecutionLevel(filePath, label) {
  assertFile(filePath, label);
  const content = fs.readFileSync(filePath).toString("utf8");
  if (!content.includes(`requestedExecutionLevel level="${requiredLevel}"`)) {
    throw new Error(`${label} manifest does not contain requestedExecutionLevel=${requiredLevel}: ${filePath}`);
  }
  console.log(`${label} manifest requests ${requiredLevel}: ${filePath}`);
}

function setExecutionLevel(filePath, label) {
  assertFile(filePath, label);
  execFileSync(rcedit, [filePath, "--set-requested-execution-level", requiredLevel], {
    stdio: "inherit"
  });
  verifyExecutionLevel(filePath, label);
}

const rcedit = findRcedit();

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;
  const productName = context.packager.appInfo.productFilename || packageJson.build.productName;
  setExecutionLevel(path.join(context.appOutDir, `${productName}.exe`), "Packaged app executable");
};

if (require.main === module) {
  setExecutionLevel(appExe, "Installed app executable");
  assertFile(installerExe, "NSIS installer");
}
