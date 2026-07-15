import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RequiredCompatibilityMappingFields } from "../scripts/telemetry-contract-constants";

const README_PATH = new URL("../README.md", import.meta.url);
const PACKAGE_JSON_PATH = new URL("../package.json", import.meta.url);
const RELEASE_TAG_PREFIX = "telemetry-contract-v";
const STALE_VERSION_PATTERN = /\b0\.1\.[12]\b/;
const STALE_RELEASE_TAG_PATTERN = /telemetry-contract-v0\.1\.[12]/;
const CODEOWNERS_PATTERN = /CODEOWNERS/;
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

describe("package README", () => {
  it("keeps package version and release tag examples aligned with package metadata", () => {
    const readme = readmeSource();
    const packageJson = packageManifest();
    const releaseTag = `${RELEASE_TAG_PREFIX}${packageJson.version}`;

    expect(readme).toContain(packageJson.version);
    expect(readme).toContain(releaseTag);
    expect(readme).not.toMatch(STALE_VERSION_PATTERN);
    expect(readme).not.toMatch(STALE_RELEASE_TAG_PATTERN);
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

  it("does not claim CODEOWNERS coverage for schema updates", () => {
    expect(readmeSource()).not.toMatch(CODEOWNERS_PATTERN);
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
