import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { resolve } from "node:path";
import { defineConfig, type Plugin, type UserConfig } from "vite";

// Desktop MAIN process bundle — plain Vite (ISS-10357). Workspace TypeScript is
// inlined from source so there is zero runtime workspace resolution — the
// `@repo/api/src/...js` ERR_MODULE_NOT_FOUND class that only this app
// (raw-tsc-then-run-in-Node) was exposed to (PLN-999).
//
// The renderer builds via `vite.renderer.config.ts`; the preload via
// `vite.preload.config.ts`, which imports the shared pieces from here.

// Workspace packages bundled from SOURCE (excluded from dependency
// externalization so they are NOT resolved from node_modules at runtime):
//   - @repo/api — no `exports` map and `.ts`-only source, so a runtime
//     `@repo/api/src/...js` specifier resolves to a nonexistent file. It also
//     needs resolve.alias to point the bare specifier at the package source dir
//     (Vite then resolves `.../foo.js` → `.../foo.ts`).
//   - @repo/shared-platform — a transitive dep of @repo/api, also reached
//     directly via `@repo/shared-platform/relay-request-model`. Its `exports`
//     map resolves to `.ts` source, so it needs no alias; excluding it just
//     forces it to inline rather than externalize.
//   - @closedloop-ai/loops-api — same shape: `exports` resolve to `.ts` source.
//   - @repo/lib — `.ts`-only, no `exports`, same inline + alias treatment as
//     @repo/api (FEA-2717 deep-imports `@repo/lib/harness/...`).
//   - @repo/cost — `exports` resolve to `.ts` source. Its runtime dep
//     `@pydantic/genai-prices` is NOT carried by this inline; it resolves from
//     packaged node_modules because `apps/desktop` declares it directly.
//   - @repo/realtime-client, @repo/realtime-contract — `exports` resolve to
//     `.ts` source (PLN-2162 M4: main holds the realtime socket). The client's
//     runtime dep `socket.io-client` resolves from packaged node_modules
//     because `apps/desktop` declares it directly.
// Workspace packages that keep a pre-built `dist` AND stay external, namely
// @closedloop-ai/telemetry-contract, ship through the staged runtime closure.
// Native modules (electron, @libsql/client, electron-store, electron-updater,
// …) are externalized because they are `dependencies`, and ship in
// node_modules.
export const WORKSPACE_INLINE = [
  "@repo/api",
  "@repo/lib",
  "@repo/shared-platform",
  "@closedloop-ai/loops-api",
  "@repo/cost",
  "@repo/realtime-client",
  "@repo/realtime-contract",
];

export const workspaceAlias: Record<string, string> = {
  "@repo/api": resolve("../../packages/api"),
  "@repo/lib": resolve("../../packages/lib"),
};

// Separately-spawned Node entry points. Each is loaded at runtime by PATH —
// `new URL("./<name>.js", import.meta.url)` handed to utilityProcess.fork /
// worker_threads — NOT by a static `import`, so rollup only emits them if they
// are declared entries (PLN-999).
//
// They are emitted FLAT into dist/main under the exact basename the caller
// resolves to: the callers are bundled into flat dist/main chunks, so
// `import.meta.url` is dist/main/<chunk>.js and `./<name>.js` resolves to
// dist/main/<name>.js. The basenames here MUST match the `new URL(...)`
// specifiers (asserted by the worker-entry guardrail test).
const MAIN_WORKER_ENTRIES: Record<string, string> = {
  "db-host-worker": resolve("src/main/database/db-host/db-host-worker.ts"),
  "db-store-worker": resolve("src/main/database/db-host/db-store-worker.ts"),
  "agent-session-sync-payload-worker": resolve(
    "src/main/agent-sync/agent-session-sync-payload-worker.ts"
  ),
  "historical-parse-worker": resolve(
    "src/main/collectors/engine/historical-parse-worker.ts"
  ),
  "pack-scan-worker": resolve("src/main/packs/pack-scan-worker.ts"),
  "opencode-materialize-worker": resolve(
    "src/main/transcript-sync/opencode-materialize-worker.ts"
  ),
  "transcript-inventory-worker": resolve(
    "src/main/transcript-sync/transcript-inventory-worker.ts"
  ),
};

/**
 * The Node ABI the packaged main process runs on: Electron 43 embeds Node 24.
 * Bump alongside the `electron` devDependency major.
 */
export const ELECTRON_NODE_TARGET = "node24";

/**
 * Emitted-asset naming, shared by both Node bundles so the two
 * `rollupOptions.output` blocks cannot drift apart.
 */
export const ASSET_FILE_NAMES = "chunks/[name]-[hash].[ext]";

export const PACKAGE_MANIFEST_PATH = resolve("package.json");

const ELECTRON_SUBPATH = /^electron\/.+/;

// A declared dependency name can carry regex metacharacters — `socket.io-client`
// does — so each is escaped before it joins the subpath alternation below.
const REGEX_METACHARACTER = /[.*+?^${}()|[\]\\]/g;

/**
 * Everything the bundle must leave as a runtime `import`: Electron, Node
 * builtins (bare and `node:`-prefixed), and every registry dependency the app
 * declares — except the workspace packages inlined from source above. A subpath
 * import of an external (`electron-log/main.js`,
 * `@prisma/client/runtime/client`) is external too.
 */
export function runtimeExternals(
  inlined: readonly string[]
): (string | RegExp)[] {
  const manifest = JSON.parse(readFileSync(PACKAGE_MANIFEST_PATH, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const dependencies = Object.keys(manifest.dependencies ?? {}).filter(
    (name) => !inlined.includes(name)
  );
  const subpathAlternation = dependencies
    .map((name) => name.replace(REGEX_METACHARACTER, String.raw`\$&`))
    .join("|");
  return [
    "electron",
    ELECTRON_SUBPATH,
    ...builtinModules.flatMap((name) => [name, `node:${name}`]),
    ...dependencies,
    new RegExp(`^(${subpathAlternation})/.+`),
  ];
}

/**
 * The shape both Node-side bundles share: a server-consumer (SSR) build with
 * Vite's dependency externalization OFF so the rollup `external` list above is
 * the only thing deciding what stays a runtime import, and `process.env.*` left
 * alone for the runtime to read rather than inlined at build time.
 */
export const electronNodeBuildBase: UserConfig = {
  publicDir: false,
  define: {
    "process.env": "process.env",
    "global.process.env": "global.process.env",
    "globalThis.process.env": "globalThis.process.env",
  },
  envPrefix: ["MAIN_VITE_", "VITE_"],
  ssr: { noExternal: true },
  build: {
    target: ELECTRON_NODE_TARGET,
    ssr: true,
    ssrEmitAssets: true,
    minify: false,
    reportCompressedSize: false,
    copyPublicDir: false,
    modulePreload: false,
    sourcemap: true,
  },
};

/**
 * `import.meta.url` / `.filename` / `.dirname` inside a CommonJS output chunk
 * (the preload). Rollup leaves `import.meta` in place for `cjs`, where it is a
 * syntax error, so the preload build rewrites the three properties it uses.
 */
export function importMetaForCommonJs(): Plugin {
  return {
    name: "desktop:import-meta-cjs",
    apply: "build",
    enforce: "pre",
    resolveImportMeta(property, { format }) {
      if (format !== "cjs") {
        return null;
      }
      if (property === "url") {
        return 'require("url").pathToFileURL(__filename).href';
      }
      if (property === "filename") {
        return "__filename";
      }
      if (property === "dirname") {
        return "__dirname";
      }
      return null;
    },
  };
}

export default defineConfig({
  ...electronNodeBuildBase,
  resolve: {
    alias: workspaceAlias,
    conditions: ["node"],
    mainFields: ["module", "jsnext:main", "jsnext"],
  },
  build: {
    ...electronNodeBuildBase.build,
    outDir: "dist/main",
    rollupOptions: {
      input: { index: resolve("src/main/index.ts"), ...MAIN_WORKER_ENTRIES },
      external: runtimeExternals(WORKSPACE_INLINE),
      output: {
        format: "es",
        entryFileNames: "[name].js",
        // Keep split chunks flat in dist/main (not dist/main/chunks/) so that
        // any module landing in a chunk still resolves `import.meta.url` /
        // `__dirname` to dist/main — identical to the per-file tsc layout the
        // app's resource-path derivation relies on (PLN-999 Phase 3a). This
        // also keeps the forked worker entries (MAIN_WORKER_ENTRIES) and the
        // flat-bundled callers that `new URL("./<name>.js", import.meta.url)`
        // them in the SAME directory, so those paths resolve.
        chunkFileNames: "[name]-[hash].js",
        assetFileNames: ASSET_FILE_NAMES,
      },
    },
  },
});
