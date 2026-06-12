const http = require("http");

const baseUrl = process.env.SUITE_URL || "http://127.0.0.1:8810";

function request(pathName, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathName, baseUrl);
    const body = options.body ? Buffer.from(JSON.stringify(options.body)) : null;
    const req = http.request(url, {
      method: options.method || "GET",
      headers: body ? { "Content-Type": "application/json", "Content-Length": body.length } : {}
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
        resolve({ statusCode: res.statusCode, data, text });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  const probe = await request("/api/admin/probe");
  if (probe.statusCode !== 200) throw new Error(`Probe failed with ${probe.statusCode}: ${probe.text}`);
  const requiredProbeFields = ["transport", "configured", "reachable", "missingEnv", "liveGiveAvailable", "dryRunReason"];
  for (const field of requiredProbeFields) {
    if (!(field in probe.data)) throw new Error(`Probe response missing ${field}`);
  }

  const give = await request("/api/admin/give-item", {
    method: "POST",
    body: {
      playerId: "test-player",
      template: "Combat_Neut_AtreidesDeserterUnique04_Boots",
      qty: 1,
      quality: 0
    }
  });
  if (give.statusCode !== 200) throw new Error(`Give item endpoint failed with ${give.statusCode}: ${give.text}`);
  if (!("dryRun" in give.data)) throw new Error("Give item response missing dryRun");

  console.log(`Admin probe ok: transport=${probe.data.transport}, configured=${probe.data.configured}, reachable=${probe.data.reachable}, live=${probe.data.liveGiveAvailable}`);
  console.log(`Give item endpoint ok: dryRun=${give.data.dryRun}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
