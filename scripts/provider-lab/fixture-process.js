"use strict";
// Deterministic local subprocess fixture, not a Linux or SSH implementation.
const [mode, id] = process.argv.slice(2);
if (mode === "hang") setTimeout(() => {}, 60000);
else if (mode === "fail") { console.error("secret:fixture-password"); process.exitCode = 7; }
else if (mode === "overflow") process.stdout.write("x".repeat(70000));
else if (mode === "malformed") process.stdout.write("secret:fixture-password");
else {
  const values = { os: "Linux\n", architecture: "x86_64\n", distribution: 'ID="alpine"\nNAME="Private host"\n', tools: "kubectl\npsql\n", root: "readable\n" };
  process.stdout.write(values[id] || "");
}
