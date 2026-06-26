import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SAMPLE_EXPORT_PATH,
  SAMPLE_EXPORT_TARGET,
} from "../scripts/sample-export-constants";

const PACKAGE_JSON_PATH = new URL("../package.json", import.meta.url);
const EXPECTED_PACKAGE_VERSION = "0.5.0";
const EXPECTED_OTEL_SEMCONV_VERSION = "1.39.0";
const IMPORT_TYPES_PATTERN = /^\.\/dist\/.*\.d\.ts$/;
const REQUIRE_TYPES_PATTERN = /^\.\/dist\/.*\.d\.cts$/;
const IMPORT_DEFAULT_PATTERN = /^\.\/dist\/.*\.js$/;
const REQUIRE_DEFAULT_PATTERN = /^\.\/dist\/.*\.cjs$/;
const CODE_EXPORT_PATHS = [
  "./attributes",
  "./app",
  "./app-exception-origin",
  "./resource",
  "./span",
  "./gen-ai",
  "./sync",
  "./permission",
  "./schema-name",
  "./schema-shape",
  "./validate",
  "./emit",
  "./test-fixtures",
] as const;
const SCHEMA_EXPORT_PATHS = [
  "./schemas/resource.schema.json",
  "./schemas/app.schema.json",
  "./schemas/span.schema.json",
  "./schemas/gen-ai.schema.json",
  "./schemas/sync.schema.json",
  "./schemas/permission.schema.json",
] as const;
const HTTP_URL_PATTERN = /^https?:/;

describe("package metadata", () => {
  it("defines the expected package contract metadata and exports", () => {
    const packageJson = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf-8"));

    expect(packageJson.name).toBe("@closedloop-ai/telemetry-contract");
    expect(packageJson.version).toBe(EXPECTED_PACKAGE_VERSION);
    expect(packageJson.files).toEqual(["dist"]);
    expect(packageJson.publishConfig.registry).toBe(
      "https://npm.pkg.github.com"
    );
    expect(Object.hasOwn(packageJson.exports, ".")).toBe(false);

    for (const exportPath of CODE_EXPORT_PATHS) {
      const entry = packageJson.exports[exportPath];

      // Dual-mode types: each subpath must serve correctly-typed bundles
      // to both ESM (import) and CJS (require) consumers under
      // moduleResolution: node16 / nodenext. Top-level "types" is not
      // sufficient — the type declaration must be conditioned the same
      // way the JS module is, or CJS callers get module-format mismatch
      // errors against an ESM .d.ts.
      expect(entry.import.types).toMatch(IMPORT_TYPES_PATTERN);
      expect(entry.import.types).not.toContain("./src/");
      expect(entry.import.default).toMatch(IMPORT_DEFAULT_PATTERN);
      expect(entry.require.types).toMatch(REQUIRE_TYPES_PATTERN);
      expect(entry.require.types).not.toContain("./src/");
      expect(entry.require.default).toMatch(REQUIRE_DEFAULT_PATTERN);
    }

    for (const exportPath of SCHEMA_EXPORT_PATHS) {
      expect(packageJson.exports[exportPath]).toEqual({
        default: `./dist${exportPath.slice(1)}`,
      });
    }

    expect(Object.keys(packageJson.exports[SAMPLE_EXPORT_PATH])).toEqual([
      "default",
    ]);
    expect(packageJson.exports[SAMPLE_EXPORT_PATH].default).toBe(
      SAMPLE_EXPORT_TARGET
    );
    expect(packageJson.exports[SAMPLE_EXPORT_PATH].default).not.toContain(
      "./samples/"
    );
    expect(packageJson.exports[SAMPLE_EXPORT_PATH].default).not.toContain(
      "./src/"
    );
    expect(packageJson.exports[SAMPLE_EXPORT_PATH].default).not.toMatch(
      HTTP_URL_PATTERN
    );
    expect(packageJson.exports[SAMPLE_EXPORT_PATH].default).not.toBeNull();

    expect(packageJson.telemetryContract.otelSemanticConventionsVersion).toBe(
      EXPECTED_OTEL_SEMCONV_VERSION
    );
    expect(
      packageJson.devDependencies["@opentelemetry/semantic-conventions"]
    ).toBe(EXPECTED_OTEL_SEMCONV_VERSION);
  });
});
