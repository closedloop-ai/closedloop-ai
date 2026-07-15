import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { CONTENT_SECURITY_POLICY_META } from "./src/shared/content-security-policy";

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
    alias: {
      "@": path.resolve("src/renderer"),
      "@repo/api": path.resolve("../../packages/api"),
      // packages/app uses self-referencing `@repo/app/<feature>/…` imports for
      // its cross-slice convention. The package has no `exports` field, so
      // Node-style self-resolution fails inside the package and Rollup silently
      // externalizes the bare specifier — which then throws at runtime when the
      // chunk loads. Alias to the package source so those imports bundle.
      "@repo/app": path.resolve("../../packages/app"),
      // FEA-2717: the shared session-detail transcript panel (in `@repo/app`)
      // deep-imports the harness parser cores as `@repo/lib/harness/...`. Same
      // no-`exports` `.ts`-only shape as `@repo/api`, so alias to source so the
      // renderer bundles it (mirrors the main/preload `workspaceAlias`).
      "@repo/lib": path.resolve("../../packages/lib"),
      // `@closedloop-ai/design-system` is source-consumed with NO `exports` map (it was
      // de-published from `@closedloop-ai/design-system`, dropping the dist
      // `exports` the renderer previously resolved through). Its deep subpath
      // imports (`@closedloop-ai/design-system/components/ui/…`) therefore fail Node-style
      // resolution and Rollup silently externalizes them — a bare specifier that
      // throws at runtime in the `app://` renderer. Alias to source so they
      // bundle. (loops-api/shared-platform keep `exports` maps and resolve on
      // their own, so they need no alias here.)
      "@closedloop-ai/design-system": path.resolve(
        "../../packages/design-system"
      ),
    },
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
