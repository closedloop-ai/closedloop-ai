import { resolve } from "node:path";
import { defineConfig } from "electron-vite";

// ---------------------------------------------------------------------------
// Desktop main + preload are bundled by electron-vite so workspace TypeScript
// is inlined from source and there is zero runtime workspace resolution — the
// `@repo/api/src/...js` `ERR_MODULE_NOT_FOUND`-at-load class that only this app
// (raw-tsc-then-run-in-Node) was exposed to (PLN-999).
//
// The renderer is intentionally NOT defined here: it keeps building via
// `vite.renderer.config.ts` (its `@repo/api`/`@repo/app` aliases + plugins are
// load-bearing). `electron-vite build` logs a benign "renderer config is
// missing" notice; `build:renderer` runs separately.
// ---------------------------------------------------------------------------

// Workspace packages bundled from SOURCE (excluded from auto-externalization so
// they are NOT resolved from node_modules at runtime):
//   - @repo/api — no `exports` map and `.ts`-only source, so a runtime
//     `@repo/api/src/...js` specifier resolves to a nonexistent file. It also
//     needs resolve.alias to point the bare specifier at the package source dir
//     (Vite then resolves `.../foo.js` → `.../foo.ts`).
//   - @repo/shared-platform (= @closedloop-ai/shared-platform) — a transitive
//     dep of @repo/api, also reached directly via
//     `@repo/shared-platform/relay-request-model`. It HAS an `exports` map, so
//     it needs no alias (exports resolution finds it); excluding it just forces
//     it to inline rather than externalize. Bundling it keeps it out of the
//     packaged runtime closure (packaging-workspace-deps.mjs), consistent with
//     it being absent from node_modules.
// Workspace packages that keep an `exports` map AND stay external, such as
// @closedloop-ai/loops-api and @closedloop-ai/telemetry-contract, ship through
// the staged runtime closure. Native modules (electron, @libsql/client,
// better-sqlite3, electron-store, electron-updater, …) are externalized by
// default (they are `dependencies`) and ship in node_modules.
const WORKSPACE_INLINE = ["@repo/api", "@repo/shared-platform"];

const workspaceAlias: Record<string, string> = {
  "@repo/api": resolve("../../packages/api"),
};

// Separately-spawned Node entry points. Each is loaded at runtime by PATH —
// `new URL("./<name>.js", import.meta.url)` handed to utilityProcess.fork /
// worker_threads — NOT by a static `import`, so rollup only emits them if they
// are declared entries. (The old per-file `tsc` build emitted every `.ts`, so
// these "just existed"; bundling drops anything outside the static graph, which
// is exactly the db-host-worker `ERR_MODULE_NOT_FOUND` boot crash — PLN-999.)
//
// They are emitted FLAT into dist/main under the exact basename the caller
// resolves to: the callers are bundled into flat dist/main chunks (Phase 3a),
// so `import.meta.url` is dist/main/<chunk>.js and `./<name>.js` resolves to
// dist/main/<name>.js. The basenames here MUST match the `new URL(...)`
// specifiers (asserted by the worker-entry guardrail test).
const MAIN_WORKER_ENTRIES: Record<string, string> = {
  "db-host-worker": resolve("src/main/database/db-host/db-host-worker.ts"),
  "agent-session-sync-payload-worker": resolve(
    "src/main/agent-session-sync-payload-worker.ts"
  ),
  "historical-parse-worker": resolve(
    "src/main/collectors/historical-parse-worker.ts"
  ),
};

export default defineConfig({
  main: {
    resolve: { alias: workspaceAlias },
    build: {
      outDir: "dist/main",
      sourcemap: true,
      externalizeDeps: { exclude: WORKSPACE_INLINE },
      rollupOptions: {
        input: { index: resolve("src/main/index.ts"), ...MAIN_WORKER_ENTRIES },
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
        },
      },
    },
  },
  preload: {
    resolve: { alias: workspaceAlias },
    build: {
      outDir: "dist/main",
      // Do NOT wipe dist/main — main is built first and writes index.js here.
      emptyOutDir: false,
      sourcemap: true,
      externalizeDeps: { exclude: WORKSPACE_INLINE },
      rollupOptions: {
        input: {
          "preload-design-system": resolve("src/main/preload-design-system.ts"),
        },
        output: {
          // CJS preload (single self-contained `.cjs`): synchronous evaluation
          // means `window.desktopApi` is exposed before the renderer's
          // first-render reads run — no async-ESM-preload startup race
          // (PLN-999 Phase 3). `.cjs` so Node treats it as CommonJS under the
          // package's `"type": "module"`.
          format: "cjs",
          entryFileNames: "[name].cjs",
          inlineDynamicImports: true,
        },
      },
    },
  },
});
