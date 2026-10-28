import path from "node:path";
import type { NextConfig } from "next";

// Deliberately minimal: the prototype sandbox has no analytics, observability,
// or env wiring (docs/design/prototype-sandbox.md).
// `agentRules: false` keeps `next dev` from writing its managed agent-rules block into this
// app's AGENTS.md on every qualifying run, which dirties a tracked file (ISS-6097).
const nextConfig: NextConfig = {
  agentRules: false,
  // ISS-9687: the hosted Storybook is static output under `public/storybook/`.
  // Next serves `public/` by exact path and does not resolve a directory to its
  // index, so `/storybook` 404s on its own.
  //
  // A redirect, NOT a rewrite. Storybook's manager references every asset
  // relatively (`./sb-manager/runtime.js`), so the browser's base URL has to be
  // inside the directory. A rewrite keeps the address bar on `/storybook`, the
  // relative refs resolve to the domain root, and the manager silently never
  // boots — verified: the manager HTML returns 200 and no preview iframe is
  // ever created. Redirecting moves the base to `/storybook/index.html`, where
  // the same page loads and renders a story with no failed requests.
  redirects: () =>
    Promise.resolve([
      {
        destination: "/storybook/index.html",
        permanent: false,
        source: "/storybook",
      },
    ]),
};

if (process.env.E2E_STANDALONE_BUILD === "1") {
  nextConfig.output = "standalone";
}

nextConfig.outputFileTracingRoot = path.join(import.meta.dirname, "..", "..");

export default nextConfig;
