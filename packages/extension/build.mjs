import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });
await build({
  entryPoints: { background: "src/background.ts", popup: "src/popup/popup.ts" },
  outdir: "dist",
  bundle: true,
  format: "esm",
  target: "chrome116",
  logLevel: "info",
});
copyFileSync("manifest.json", "dist/manifest.json");
copyFileSync("src/popup/popup.html", "dist/popup.html");
copyFileSync("src/popup/popup.css", "dist/popup.css");
