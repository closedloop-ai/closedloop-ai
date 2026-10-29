import { resolve } from "node:path";
import { defineConfig } from "vite";
import {
  ASSET_FILE_NAMES,
  electronNodeBuildBase,
  importMetaForCommonJs,
  runtimeExternals,
  WORKSPACE_INLINE,
  workspaceAlias,
} from "./vite.main.config.ts";

// Desktop PRELOAD bundle — plain Vite, sharing the main build's inline list,
// alias, and externals (vite.main.config.ts). Runs AFTER `build:main` writes
// dist/main, so it must not empty that directory.
export default defineConfig({
  ...electronNodeBuildBase,
  plugins: [importMetaForCommonJs()],
  resolve: { alias: workspaceAlias },
  ssr: {
    ...electronNodeBuildBase.ssr,
    resolve: {
      conditions: ["module", "browser", "development|production"],
      mainFields: ["browser", "module", "jsnext:main", "jsnext"],
    },
  },
  build: {
    ...electronNodeBuildBase.build,
    outDir: "dist/main",
    emptyOutDir: false,
    rollupOptions: {
      input: {
        "preload-design-system": resolve("src/main/preload-design-system.ts"),
      },
      external: runtimeExternals(WORKSPACE_INLINE),
      output: {
        // CJS preload (single self-contained `.cjs`): synchronous evaluation
        // means `window.desktopApi` is exposed before the renderer's
        // first-render reads run — no async-ESM-preload startup race
        // (PLN-999 Phase 3). `.cjs` so Node treats it as CommonJS under the
        // package's `"type": "module"`.
        format: "cjs",
        entryFileNames: "[name].cjs",
        codeSplitting: false,
        assetFileNames: ASSET_FILE_NAMES,
      },
    },
  },
});
