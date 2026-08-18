import { register } from "node:module";
import path from "node:path";

/**
 * ISS-6781: the `--import` preload for the Prisma CLI when it is SPAWNED out of
 * a Vercel serverless bundle. Registers `esm-store-resolver-hooks.mjs`, which
 * gives ES-module `import`s the pnpm-store resolution that `NODE_PATH` already
 * gives CommonJS `require`s.
 *
 * Why this exists at all: the tracing globs copy every store package the CLI
 * needs but none of the symlinks pnpm wires them together with. ISS-6728
 * bridged that for `require` by putting every store directory on `NODE_PATH`,
 * and the CLI started — then died one layer further in, because Node's ESM
 * resolver never consults `NODE_PATH`. `@prisma/config` does
 * `await import("c12")`, and `c12` does `import { createJiti } from "jiti"`;
 * with no sibling symlink to walk up to, that import either fails or (in
 * production, observed as ISS-6781) lands on a copy of `jiti` that is not the
 * one `c12` depends on. Same failure class as ISS-6728, one module system over.
 *
 * The store directories are read off `NODE_PATH` deliberately: it is the ONE
 * place `applyMigrateRuntimeLayout` already publishes them, so the two module
 * systems cannot disagree about which store the bundle carries. Non-store
 * entries — the Lambda runtime's own — are dropped here rather than in the
 * hook, so the hook thread receives only what it can use.
 *
 * Dependency-free on purpose, like the sibling `prisma.config.mjs`: this file
 * runs inside the spawned CLI, where Next's file tracing cannot see it, so it
 * may import nothing but `node:` builtins and its sibling.
 */

const STORE_MODULE_DIR = /[\\/]\.pnpm[\\/][^\\/]+[\\/]node_modules$/;

const storeDirs = (process.env.NODE_PATH ?? "")
  .split(path.delimiter)
  .filter((entry) => STORE_MODULE_DIR.test(entry));

register("./esm-store-resolver-hooks.mjs", import.meta.url, {
  data: { storeDirs },
});
