const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const assetsDir = path.join(root, "assets");
const banners = [
  "theme-alpha-gold-banner",
  "theme-command-console-banner",
  "theme-purple-desert-banner",
  "theme-high-contrast-banner",
  "theme-royal-desert-banner"
];

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webSecurity: false
    }
  });

  async function convertBanner(name, quality) {
    const pngPath = path.join(assetsDir, `${name}.png`);
    const webpPath = path.join(assetsDir, `${name}.webp`);
    const pngBase64 = fs.readFileSync(pngPath).toString("base64");
    const result = await win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement("canvas");
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0);
          resolve({
            width: img.naturalWidth,
            height: img.naturalHeight,
            dataUrl: canvas.toDataURL("image/webp", ${Number(quality) || 0.82})
          });
        };
        img.onerror = () => reject(new Error("Image decode failed: ${name}"));
        img.src = "data:image/png;base64,${pngBase64}";
      })
    `);
    const base64 = String(result.dataUrl || "").replace(/^data:image\\/webp;base64,/, "");
    fs.writeFileSync(webpPath, Buffer.from(base64, "base64"));
    return {
      name,
      width: result.width,
      height: result.height,
      pngBytes: fs.statSync(pngPath).size,
      webpBytes: fs.statSync(webpPath).size
    };
  }

  await win.loadURL("about:blank");
  const rows = [];
  for (const name of banners) {
    rows.push(await convertBanner(name, 0.84));
  }
  console.table(rows.map((row) => ({
    name: row.name,
    size: `${row.width}x${row.height}`,
    pngKB: Math.round(row.pngBytes / 1024),
    webpKB: Math.round(row.webpBytes / 1024),
    savedKB: Math.round((row.pngBytes - row.webpBytes) / 1024)
  })));
  app.quit();
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
