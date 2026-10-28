"use strict";
const path = require("node:path");
function rootCommand(root) {
  if (typeof root !== "string" || root.length > 1024 || /[\x00-\x1f\x7f]/.test(root) || !path.posix.isAbsolute(root) || path.posix.normalize(root) !== root) throw new Error("invalid_runtime_root");
  const quoted = "'" + root.replace(/'/g, "'\"'\"'") + "'";
  return `if test -d ${quoted} && test -r ${quoted}; then printf 'readable\\n'; else printf 'unavailable\\n'; fi`;
}
module.exports = { rootCommand };
