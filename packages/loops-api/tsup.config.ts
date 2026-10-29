import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    attachment: "./src/attachment.ts",
    "branch-view": "./src/branch-view.ts",
    "column-limits": "./src/column-limits.ts",
    common: "./src/common.ts",
    "compute-target": "./src/compute-target.ts",
    "context-pack": "./src/context-pack.ts",
    currency: "./src/currency.ts",
    document: "./src/document.ts",
    "error-codes": "./src/error-codes.ts",
    "execution-result": "./src/execution-result.ts",
    "friendly-error": "./src/friendly-error.ts",
    github: "./src/github.ts",
    insights: "./src/insights.ts",
    "insights-branch-coverage": "./src/insights-branch-coverage.ts",
    "observability/truncate-utf8": "./src/observability/truncate-utf8.ts",
    "secret-value-pattern": "./src/secret-value-pattern.ts",
    "security/plain-record": "./src/security/plain-record.ts",
    "security/proto-safe-record": "./src/security/proto-safe-record.ts",
    "stable-stringify": "./src/stable-stringify.ts",
    "stable-utc-window": "./src/stable-utc-window.ts",
    "stream-types": "./src/stream-types.ts",
    "test-fixtures/stable-utc-window-parity":
      "./src/test-fixtures/stable-utc-window-parity.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  esbuildOptions(options) {
    options.jsx = "automatic";
  },
});
