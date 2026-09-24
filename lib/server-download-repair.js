"use strict";

const { cleanUpdateLine, SERVER_UPDATE_TIMEOUTS } = require("./server-update");

function serverDownloadRepairCommand() {
  return `
set -eu
if [ "$(id -un)" != dune ]; then echo "Repair must run as the dune account. Check the Suite SSH user setting." >&2; exit 1; fi
download=/home/dune/.dune/download
if [ ! -d "$download/steamapps" ]; then echo "The existing Dune download directory was not found." >&2; exit 1; fi
if [ ! -w "$download" ] || [ ! -w "$download/steamapps" ]; then echo "The dune account cannot write to the existing download directory. Check its ownership and permissions." >&2; exit 1; fi
command -v flock >/dev/null || { echo "The flock utility is required to protect this repair." >&2; exit 1; }
command -v pgrep >/dev/null || { echo "The pgrep utility is required to check for an active updater." >&2; exit 1; }
exec 9>"$download/.alphanine-validation.lock"
flock -n 9 || { echo "A download repair is already running." >&2; exit 1; }
if pgrep -x steamcmd >/dev/null || pgrep -x steamcmd.sh >/dev/null; then echo "SteamCMD is already running. Wait for that update to finish." >&2; exit 1; fi
printf 'Checking download storage and permissions\\n'
df -h "$download"
df -i "$download"
steamcmd_path=$(command -v steamcmd || true)
if [ -z "$steamcmd_path" ]; then steamcmd_path=/home/dune/.local/share/Steam/steamcmd/steamcmd.sh; fi
if [ ! -x "$steamcmd_path" ]; then echo "SteamCMD could not be found. Repair cannot start." >&2; exit 1; fi
mkdir -p /home/dune/.steam
printf 'Validating Dune server download\\n'
"$steamcmd_path" +force_install_dir "$download" +login anonymous +app_update 4754530 validate +quit
`;
}

function classifyDownloadRepairResult(result = {}) {
  const lines = [result.stdout, result.stderr].filter(Boolean).join("\n").split(/\r?\n/).map(cleanUpdateLine);
  const steamError = lines.find(line => /^Error!\s+App\s+'4754530'\s+state is\s+0x[0-9a-f]+\s+after update job\b/i.test(line));
  const verified = lines.some(line => /^Success!\s+App\s+'4754530'\s+fully installed\.$/i.test(line));
  if (!steamError && result.ok && !result.timedOut && !result.signal && verified) return result;
  const error = steamError || result.underlyingError || result.error || result.stderr
    || "SteamCMD did not confirm that the Dune server download was fully installed.";
  return { ...result, ok: false, error, underlyingError: error };
}

function downloadRepairProgress(line, previous = 1) {
  const text = cleanUpdateLine(line);
  const match = text.match(/Update state .*?progress:\s*([0-9.]+)/i);
  const percent = match ? Math.min(100, Math.max(0, Number(match[1]) || 0)) : 0;
  // Verification starts again at zero after the download finishes.
  const value = /verifying|committing/i.test(text) ? 70 + percent * 0.25 : 5 + percent * 0.65;
  return Math.min(95, Math.max(previous, match ? Math.round(value) : 1));
}

async function runDownloadRepair(execute, onLine) {
  const result = await execute(serverDownloadRepairCommand(), {
    timeout: SERVER_UPDATE_TIMEOUTS.updateCommandMs,
    maxBuffer: 4 * 1024 * 1024,
    onLine
  });
  return classifyDownloadRepairResult(result);
}

module.exports = { serverDownloadRepairCommand, classifyDownloadRepairResult, downloadRepairProgress, runDownloadRepair };
