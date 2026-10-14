import { build } from "esbuild";

// Bundle our sources (including the workspace protocol package); keep npm deps external.
await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["@modelcontextprotocol/sdk", "ws", "zod"],
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "info",
});
