#!/usr/bin/env node
/**
 * Assembles a Vercel Build Output API v3 directory from the Storybook static
 * export plus the Basic Auth edge middleware in `deploy/middleware.js`.
 *
 * Why this exists: `vercel.json` describes a plain static deployment
 * (`framework: null`, `outputDirectory: storybook-static`), and a static
 * deployment cannot run middleware. The password gate in front of
 * storybook.preview.closedloop-stage.ai therefore has to be hand-assembled as a
 * Build Output directory and pushed with `vercel deploy --prebuilt`.
 *
 * Before this script existed the middleware lived ONLY inside the deployed
 * artifact: it was not in the repo, so it could not be reviewed, rotated or
 * rebuilt without reading the running function back off Vercel.
 *
 * Usage, from apps/storybook:
 *
 *   pnpm build              # produces storybook-static/
 *   pnpm deploy:prepare     # produces .vercel/output/
 *   vercel deploy --prebuilt --prod --scope closed-loop
 */
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const staticSrc = join(appDir, "storybook-static");
const outDir = join(appDir, ".vercel", "output");
const fnDir = join(outDir, "functions", "middleware.func");

// Matches the routing the live deployment already used: send every request
// through the middleware, then continue on to the static file system.
const config = {
  version: 3,
  routes: [{ src: "/.*", middlewarePath: "middleware", continue: true }],
};

await rm(outDir, { recursive: true, force: true });
await mkdir(fnDir, { recursive: true });

await cp(staticSrc, join(outDir, "static"), { recursive: true });
await cp(join(appDir, "deploy", "middleware.js"), join(fnDir, "index.js"));

await writeFile(
  join(fnDir, ".vc-config.json"),
  `${JSON.stringify({ runtime: "edge", entrypoint: "index.js" }, null, 2)}\n`
);
await writeFile(
  join(outDir, "config.json"),
  `${JSON.stringify(config, null, 2)}\n`
);

console.log(`Build Output written to ${outDir}`);
