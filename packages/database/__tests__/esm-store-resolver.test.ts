import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/*
 * ISS-6781. The resolver preloaded into the bundled Prisma CLI, driven the way
 * the CLI drives it: a real `node --import` over a synthetic pnpm store that
 * carries package FILES but no linking symlinks, with the store directories on
 * `NODE_PATH` exactly as `applyMigrateRuntimeLayout` publishes them.
 *
 * Every case runs the SAME entry script under two spawns — with and without
 * the preload — so each assertion is anchored to a failure it observed, not to
 * a fixture that happened to be easy. The apps/api layout suite covers the
 * production-shaped chain (CJS CLI → `import("c12")` → named `jiti` export);
 * this one pins the resolver's own contract on the arms that chain does not
 * reach.
 */

const RESOLVER_ENTRY = pathToFileURL(
  path.join(
    import.meta.dirname,
    "..",
    "prisma-runtime",
    "esm-store-resolver.mjs"
  )
).href;

const root = mkdtempSync(path.join(tmpdir(), "esm-store-resolver-"));
const store = path.join(root, "node_modules", ".pnpm");

function writeStorePackage(
  storeEntry: string,
  packageName: string,
  manifest: Record<string, unknown>,
  files: Record<string, string>
): string {
  const packageDir = path.join(
    store,
    storeEntry,
    "node_modules",
    ...packageName.split("/")
  );
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({
      name: packageName,
      type: "module",
      main: "index.js",
      ...manifest,
    })
  );
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(path.join(packageDir, name), contents);
  }
  return packageDir;
}

// `app` imports three things: `left` (declared ^2, store holds 1 and 2, and a
// hoisted symlink points at 1), `right` (undeclared, only in the store), and
// `hoisted-only` (not in the store at all, reachable only through a hoisted
// symlink — the resolver must leave that resolution alone).
const appDir = writeStorePackage(
  "app@1.0.0",
  "app",
  { dependencies: { left: "^2.0.0" } },
  {
    "index.js": [
      'import { which as left } from "left";',
      'import { which as right } from "right";',
      'import { which as hoistedOnly } from "hoisted-only";',
      "process.stdout.write([left, right, hoistedOnly].join(','));",
    ].join("\n"),
  }
);
writeStorePackage(
  "left@1.5.0",
  "left",
  { version: "1.5.0" },
  { "index.js": 'export const which = "left@1";' }
);
writeStorePackage(
  "left@2.3.0",
  "left",
  { version: "2.3.0" },
  { "index.js": 'export const which = "left@2";' }
);
writeStorePackage(
  "right@4.0.0",
  "right",
  { version: "4.0.0" },
  { "index.js": 'export const which = "right@4";' }
);
const hoistedOnlyDir = path.join(root, "elsewhere", "hoisted-only");
mkdirSync(hoistedOnlyDir, { recursive: true });
writeFileSync(
  path.join(hoistedOnlyDir, "package.json"),
  JSON.stringify({ name: "hoisted-only", type: "module", main: "index.js" })
);
writeFileSync(
  path.join(hoistedOnlyDir, "index.js"),
  'export const which = "hoisted-only";'
);
const hoisted = path.join(store, "node_modules");
mkdirSync(hoisted, { recursive: true });
symlinkSync(
  path.join("..", "left@1.5.0", "node_modules", "left"),
  path.join(hoisted, "left"),
  "dir"
);
symlinkSync(hoistedOnlyDir, path.join(hoisted, "hoisted-only"), "dir");

const nodePath = [
  path.join(store, "app@1.0.0", "node_modules"),
  path.join(store, "left@1.5.0", "node_modules"),
  path.join(store, "left@2.3.0", "node_modules"),
  path.join(store, "right@4.0.0", "node_modules"),
  path.join(root, "node_modules"),
  // What AWS Lambda pre-sets; the resolver must ignore non-store entries.
  "/opt/nodejs/node_modules",
].join(path.delimiter);

function runEntry(withResolver: boolean) {
  const args = withResolver ? ["--import", RESOLVER_ENTRY] : [];
  return spawnSync(process.execPath, [...args, path.join(appDir, "index.js")], {
    encoding: "utf8",
    env: { ...process.env, NODE_PATH: nodePath, NODE_OPTIONS: "" },
    timeout: 30_000,
  });
}

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
});

describe("esm-store-resolver", () => {
  it("without the preload, the walk-up finds the wrong `left` and no `right` at all", () => {
    const spawned = runEntry(false);

    // The first failure node reports is `right`: undeclared, unlinked, and
    // absent from every ancestor `node_modules` — the ISS-6781 zeptomatch →
    // graphmatch shape. (`left` would resolve, to the hoisted 1.x.)
    expect(spawned.status).not.toBe(0);
    expect(spawned.stderr).toContain("ERR_MODULE_NOT_FOUND");
    expect(spawned.stderr).toContain("'right'");
  });

  it("with the preload: declared major over the hoisted copy, store fallback for the undeclared, default left alone", () => {
    const spawned = runEntry(true);

    expect(spawned.stderr).toBe("");
    expect(spawned.status).toBe(0);
    // `left@2`, not the hoisted `left@1` the walk-up would have taken — the
    // ISS-6781 wrong-`jiti` shape. `right@4` from the store, since nothing else
    // has it. `hoisted-only` through the hoisted symlink untouched, since the
    // store offers no candidate for that name.
    expect(spawned.stdout).toBe("left@2,right@4,hoisted-only");
  });
});
