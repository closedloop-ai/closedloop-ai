import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/gateway-probe.ts",
    "src/detection-store.ts",
    "src/routing-store.ts",
    "src/storage.ts",
    "src/types.ts",
    "src/relay-request-model.ts",
    "src/gateway-dispatch.ts",
    "src/gateway-fetch-shim.ts",
    "src/gateway-constants.ts",
    "src/keyless-telemetry.ts",
  ],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  outExtension({ format }) {
    return {
      js: format === "esm" ? ".js" : ".cjs",
    };
  },
  esbuildOptions(options) {
    options.jsx = "automatic";
  },
});
