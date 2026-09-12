"use strict";
const themes = ["gold", "command", "purple", "contrast", "royal"];
function normalizeTheme(value) { return themes.includes(value) ? value : "gold"; }
function attachControls(window, input = process.stdin) {
  let pending = "";
  const receive = data => {
    pending += data.toString();
    const lines = pending.split("\n"); pending = lines.pop();
    if (pending.length > 256) pending = "";
    for (const line of lines) {
      if (window.isDestroyed()) return;
      if (line === "focus") { if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
      else if (line.startsWith("theme:") && themes.includes(line.slice(6))) window.setDesignerTheme(line.slice(6));
    }
  };
  input.on("data", receive);
  window.once("closed", () => input.removeListener("data", receive));
}
module.exports = { normalizeTheme, attachControls };
