import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "detection-store": "./src/detection-store.ts",
    "gateway-constants": "./src/gateway-constants.ts",
    "gateway-dispatch": "./src/gateway-dispatch.ts",
    "gateway-fetch-shim": "./src/gateway-fetch-shim.ts",
    "gateway-probe": "./src/gateway-probe.ts",
    "keyless-telemetry": "./src/keyless-telemetry.ts",
    "parse-env-ms": "./src/parse-env-ms.ts",
    "relay-request-model": "./src/relay-request-model.ts",
    "routing-store": "./src/routing-store.ts",
    storage: "./src/storage.ts",
    types: "./src/types.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  esbuildOptions(options) {
    options.jsx = "automatic";
  },
});
