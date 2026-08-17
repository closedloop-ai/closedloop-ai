import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { type Alias as AliasEntry, defineConfig, type Plugin } from "vite";
import { CONTENT_SECURITY_POLICY_META } from "./src/shared/content-security-policy";
import { isProfilingRendererBuildEnabled } from "./src/shared/profiling";

// ISS-5278 — render-commit capture needs a PROFILING React DOM, not a launch flag.
//
// React ships `<Profiler onRender>` only in its development and profiling
// builds; `react-dom-client.production.js` contains no `onRender` call site at
// all. A production renderer therefore never invokes the callback that
// `useRenderCommitInstrumentation` returns, so the render-commit chain is dead
// at its first link and `render-commits.jsonl` is never written — regardless of
// OTEL_SDK_DISABLED, the observability tier, or any other launch-time env var.
//
// Only `react-dom/client` is swapped. `react-dom/profiling` is the reconciler
// build and is a drop-in for it, but it `require("react-dom")` itself for the
// shared `__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE` module,
// so aliasing the ROOT specifier too points that dependency back at the
// profiling bundle and makes it depend on itself. That cycle leaves the
// internals object undefined and the renderer dies before React mounts with
// `TypeError: Cannot read properties of undefined (reading 'd')`. The base
// `react-dom` package is shared infrastructure here, not a second reconciler —
// leave it resolving normally.
//
// Opt-in only. With the flag unset — every normal and packaged build — this
// contributes no entries at all and the alias list is exactly the workspace one
// it has always been, so a shipping renderer never pays the profiler's
// per-commit timing overhead. Both branches are asserted against the real config
// in test/profiling-renderer-build-alias.test.ts.
//
// Matched as an ANCHORED regex, not a bare string. Vite/Rollup treat a string
// `find` as a PREFIX (`id === find || id.startsWith(find + "/")`), so a
// `"react-dom"` entry would capture `react-dom/client`, `react-dom/server` and
// `react-dom/profiling` alike — rewriting them to nonexistent paths and
// re-creating the self-cycle above. The exact pattern swaps the one specifier
// that carries the reconciler and lets every other subpath resolve normally.
const reactProfilingAliasEntries: AliasEntry[] =
  isProfilingRendererBuildEnabled(process.env)
    ? [{ find: /^react-dom\/client$/, replacement: "react-dom/profiling" }]
    : [];

function stripCrossorigin(): Plugin {
  return {
    name: "strip-crossorigin",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        return html.replace(/\s+crossorigin(=["'][^"']*["'])?/g, "");
      },
    },
  };
}

// Inject the defense-in-depth `<meta>` CSP into the built index.html only. The
// header-delivered policy (main/content-security-policy.ts) is the primary
// control; this mirrors it for the packaged renderer. Build-only on purpose:
// the Vite dev server injects its own inline HMR/react-refresh scripts that a
// strict `script-src` would block, and the dev document is never served over
// `app://` so the header policy does not apply to it either.
function injectContentSecurityPolicyMeta(): Plugin {
  return {
    name: "inject-csp-meta",
    apply: "build",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        if (!html.includes("</head>")) {
          // Fail the build rather than silently shipping a renderer with no
          // <meta> CSP if index.html is ever restructured.
          throw new Error(
            "inject-csp-meta: no </head> found in index.html; cannot inject the CSP meta tag"
          );
        }
        const meta = `<meta content="${CONTENT_SECURITY_POLICY_META}" http-equiv="Content-Security-Policy">`;
        return html.replace("</head>", `    ${meta}\n  </head>`);
      },
    },
  };
}

export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [
    tailwindcss(),
    react({
      babel: {
        plugins: [["babel-plugin-react-compiler", { target: "19" }]],
      },
    }),
    stripCrossorigin(),
    injectContentSecurityPolicyMeta(),
  ],
  resolve: {
    // Array form (not the object map this used to be) so the react-dom entries
    // above can use anchored regexes. The string `find`s below keep the exact
    // prefix semantics the object map had, and order is preserved, so workspace
    // deep imports resolve as before.
    alias: [
      ...reactProfilingAliasEntries,
      { find: "@", replacement: path.resolve("src/renderer") },
      { find: "@repo/api", replacement: path.resolve("../../packages/api") },
      // packages/app uses self-referencing `@repo/app/<feature>/…` imports for
      // its cross-slice convention. The package has no `exports` field, so
      // Node-style self-resolution fails inside the package and Rollup silently
      // externalizes the bare specifier — which then throws at runtime when the
      // chunk loads. Alias to the package source so those imports bundle.
      { find: "@repo/app", replacement: path.resolve("../../packages/app") },
      // FEA-2717: the shared session-detail transcript panel (in `@repo/app`)
      // deep-imports the harness parser cores as `@repo/lib/harness/...`. Same
      // no-`exports` `.ts`-only shape as `@repo/api`, so alias to source so the
      // renderer bundles it (mirrors the main/preload `workspaceAlias`).
      { find: "@repo/lib", replacement: path.resolve("../../packages/lib") },
      // `@closedloop-ai/design-system` is source-consumed with NO `exports` map (it was
      // de-published from `@closedloop-ai/design-system`, dropping the dist
      // `exports` the renderer previously resolved through). Its deep subpath
      // imports (`@closedloop-ai/design-system/components/ui/…`) therefore fail Node-style
      // resolution and Rollup silently externalizes them — a bare specifier that
      // throws at runtime in the `app://` renderer. Alias to source so they
      // bundle. (loops-api/shared-platform keep `exports` maps and resolve on
      // their own, so they need no alias here.)
      {
        find: "@closedloop-ai/design-system",
        replacement: path.resolve("../../packages/design-system"),
      },
    ],
  },
  build: {
    outDir: path.resolve("dist/renderer"),
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      input: path.resolve("src/renderer/design-system/index.html"),
      onLog(level, log) {
        if (
          level === "warn" &&
          log.code === "MODULE_LEVEL_DIRECTIVE" &&
          log.message.includes("use client")
        ) {
          return;
        }
      },
      output: {
        manualChunks(id) {
          if (
            id.includes("recharts") ||
            id.includes("d3-") ||
            id.includes("d3/")
          ) {
            return "vendor-charts";
          }
          if (id.includes("lucide-react")) {
            return "vendor-icons";
          }
          if (id.includes("radix-ui") || id.includes("@radix-ui")) {
            return "vendor-radix";
          }
          if (id.includes("@closedloop-ai/design-system")) {
            return "vendor-ds";
          }
        },
      },
    },
  },
});
