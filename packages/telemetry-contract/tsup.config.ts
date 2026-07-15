import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    app: "app.ts",
    "app-exception-origin": "app-exception-origin.ts",
    attributes: "src/attributes.ts",
    "collector-tail-sampling-policy": "collector-tail-sampling-policy.ts",
    emit: "src/emit.ts",
    "gen-ai": "src/gen-ai.ts",
    ipc: "ipc.ts",
    resource: "src/resource.ts",
    permission: "permission.ts",
    "schema-name": "src/schema-name.ts",
    "schema-shape": "src/schema-shape.ts",
    span: "src/span.ts",
    sync: "sync.ts",
    "test-fixtures": "src/test-fixtures.ts",
    validate: "src/validate.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  // Private source is not part of the release artifact.
  sourcemap: false,
});
