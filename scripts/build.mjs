import { build } from "esbuild";

await build({
  entryPoints: { "seed-clients": "scripts/seed-clients.ts", "seed-demo": "scripts/seed-demo.ts" },
  outdir: "dist-scripts",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: true,
  banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
});
