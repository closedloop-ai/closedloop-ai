import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RequiredCompatibilityMappingFields } from "../scripts/telemetry-contract-constants";

const README_PATH = new URL("../README.md", import.meta.url);
const PACKAGE_JSON_PATH = new URL("../package.json", import.meta.url);
const RELEASE_TAG_VERSION_PATTERN = /telemetry-contract-v(\d+)\.(\d+)\.(\d+)/g;
const STALE_VERSION_PATTERN = /\b0\.1\.[12]\b/;
const STALE_RELEASE_TAG_PATTERN = /telemetry-contract-v0\.1\.[12]/;
const OPTIONAL_REFINEMENT_PATTERN =
  /generate-json-schemas\.ts[\s\S]*addContractPatterns|addContractPatterns[\s\S]*generate-json-schemas\.ts/;
const PACKAGE_VALIDATION_PATTERN =
  /pnpm --filter @closedloop-ai\/telemetry-contract validate/;
const SCHEMA_OWNER_REVIEW_PATTERN = /schema owner[\s\S]*review/i;
const PACKAGE_SEMVER_EXAMPLE_PATTERN =
  /package semver[\s\S]*0\.2\.0[\s\S]*0\.2\.1[\s\S]*next minor[\s\S]*next major/i;
const JSON_SCHEMA_ID_EXAMPLE_PATTERN =
  /JSON Schema `\$id` version[\s\S]*v0\.2\.schema\.json[\s\S]*v0\.3\.schema\.json/i;
const OTEL_PIN_EXAMPLE_PATTERN =
  /OTel semantic-conventions pin[\s\S]*@opentelemetry\/semantic-conventions[\s\S]*1\.39\.0/i;
const ISS_9586_RELEASE_ENTRY_PATTERN = /^ISS-9586's optional .*$/gm;

describe("package README", () => {
  it("pins the newest release version the README declares to the package manifest", () => {
    const readme = readmeSource();
    const packageJson = packageManifest();

    expect(latestDeclaredReleaseVersion(readme)).toBe(packageJson.version);
    expect(readme).not.toMatch(STALE_VERSION_PATTERN);
    expect(readme).not.toMatch(STALE_RELEASE_TAG_PATTERN);
  });

  it("publishes the five ISS-9586 attributes in one 0.48.0 release", () => {
    const readme = readmeSource();
    const entries = readme.match(ISS_9586_RELEASE_ENTRY_PATTERN) ?? [];

    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain("`ipc.query_source`");
    expect(entries[0]).toContain("`ipc.query_execution`");
    expect(entries[0]).toContain("`ipc.query_refusal`");
    expect(entries[0]).toContain("`ipc.matched_count`");
    expect(entries[0]).toContain("`ipc.scanned_count`");
    expect(entries[0]).toContain("telemetry-contract-v0.48.0");
    expect(readme).not.toContain("telemetry-contract-v0.49.0");
    expect(packageManifest().version).toBe("0.48.0");
  });

  it("documents the schema update workflow and required companion files", () => {
    const readme = readmeSource();

    expect(readme).toContain("telemetry-contract-drift");
    expect(readme).toContain("packages/telemetry-contract/app.ts");
    expect(readme).toContain(
      "packages/telemetry-contract/__tests__/app.test.ts"
    );
    expect(readme).toContain("packages/telemetry-contract/src/resource.ts");
    expect(readme).toContain(
      "packages/telemetry-contract/__tests__/resource.test.ts"
    );
    expect(readme).toContain(
      "packages/telemetry-contract/scripts/check-json-schemas.ts"
    );
    expect(readme).toMatch(OPTIONAL_REFINEMENT_PATTERN);
    expect(readme).toMatch(PACKAGE_VALIDATION_PATTERN);
    expect(readme).toMatch(SCHEMA_OWNER_REVIEW_PATTERN);
  });

  it("documents worked versioning examples, schema id scope, adapter guidance, and mapping fields", () => {
    const readme = readmeSource();

    expect(readme).toMatch(PACKAGE_SEMVER_EXAMPLE_PATTERN);
    expect(readme).toMatch(JSON_SCHEMA_ID_EXAMPLE_PATTERN);
    expect(readme).toMatch(OTEL_PIN_EXAMPLE_PATTERN);
    expect(readme).toContain(
      "https://closedloop.ai/schemas/telemetry-contract/app/v0.3.schema.json"
    );
    expect(readme).toContain("app.operating_mode");
    expect(readme).toContain("app.lifecycle.event");
    expect(readme).toContain("$id");
    expect(readme).toContain("not resolvable");
    expect(readme).toContain("@repo/observability/telemetry/contract");
    for (const field of RequiredCompatibilityMappingFields) {
      expect(readme).toContain(field);
    }
  });
});

function readmeSource(): string {
  return readFileSync(README_PATH, "utf-8");
}

function packageManifest(): { version: string } {
  return JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf-8")) as {
    version: string;
  };
}

function latestDeclaredReleaseVersion(readme: string): string {
  let latest = "";
  let latestKey = -1;
  for (const [, major, minor, patch] of readme.matchAll(
    RELEASE_TAG_VERSION_PATTERN
  )) {
    const key =
      Number(major) * 1_000_000 + Number(minor) * 1000 + Number(patch);
    if (key > latestKey) {
      latestKey = key;
      latest = `${major}.${minor}.${patch}`;
    }
  }
  return latest;
}
