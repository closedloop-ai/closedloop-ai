import { fileURLToPath } from "node:url";

const LOADER = fileURLToPath(
  new URL("./trusted-label-loader.cjs", import.meta.url)
);
const JSX_SOURCE = /\.[jt]sx$/;
const DEPENDENCY_DIRECTORY = /node_modules/;
const TURBOPACK_PATTERNS = ["*.tsx", "*.jsx"];

/** Installs the click-label provenance loader in both Next compilers. */
export function withTrustedLabels(nextConfig) {
  const previousWebpack = nextConfig.webpack;
  const rules = { ...nextConfig.turbopack?.rules };
  for (const pattern of TURBOPACK_PATTERNS) {
    rules[pattern] = withLabelLoader(rules[pattern], pattern);
  }
  return {
    ...nextConfig,
    turbopack: { ...nextConfig.turbopack, rules },
    webpack: (webpackConfig, context) => {
      webpackConfig.module.rules.unshift({
        test: JSX_SOURCE,
        exclude: DEPENDENCY_DIRECTORY,
        enforce: "pre",
        use: [LOADER],
      });
      return previousWebpack
        ? previousWebpack(webpackConfig, context)
        : webpackConfig;
    },
  };
}

// Our loader goes first in an existing rule, as `enforce: "pre"` places it in
// webpack. That rule's own condition is kept, never narrowed: the transform
// already skips dependency files itself.
function withLabelLoader(existing, pattern) {
  if (existing === undefined) {
    return { loaders: [LOADER], condition: { not: "foreign" } };
  }
  if (!Array.isArray(existing)) {
    return { ...existing, loaders: [LOADER, ...(existing.loaders ?? [])] };
  }
  if (existing.every(isLoaderItem)) {
    return { loaders: [LOADER, ...existing] };
  }
  throw new Error(
    `withTrustedLabels cannot merge the multi-rule Turbopack config for ${pattern}`
  );
}

function isLoaderItem(entry) {
  return typeof entry === "string" || typeof entry?.loader === "string";
}
