import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { evaluateCollectorAllowlist } from "../scripts/check-collector-allowlist";
import type { CollectorGuardFinding } from "../scripts/collector-codegen-common";
import {
  collectorAllowlistArtifacts,
  renderCollectorAllowlistManifest,
  renderCollectorRedactionFragment,
} from "../scripts/generate-collector-allowlist";
import {
  CollectorAllowedAttributeKeys,
  TelemetryAttribute,
} from "../src/attributes";

const MANIFEST_PATH = new URL(
  "../collector/allowed-attributes.json",
  import.meta.url
);
const FRAGMENT_PATH = new URL(
  "../collector/keyless-telemetry-redaction.yaml",
  import.meta.url
);

const committedManifest = readFileSync(MANIFEST_PATH, "utf-8");
const committedFragment = readFileSync(FRAGMENT_PATH, "utf-8");

const messagesOf = (findings: CollectorGuardFinding[]): string =>
  findings.map((finding) => finding.message).join("\n");

describe("CollectorAllowedAttributeKeys SSOT", () => {
  it("is every published attribute, de-duplicated and lexically sorted", () => {
    const expected = [...new Set(Object.values(TelemetryAttribute))].sort();
    expect([...CollectorAllowedAttributeKeys]).toEqual(expected);
  });

  it("has no duplicate keys", () => {
    expect(new Set(CollectorAllowedAttributeKeys).size).toBe(
      CollectorAllowedAttributeKeys.length
    );
  });

  it("preserves the multiplayer organization id so the collector does not redact it (FEA-1996)", () => {
    expect(CollectorAllowedAttributeKeys).toContain(
      TelemetryAttribute.AppOrganizationId
    );
    expect(committedManifest).toContain(TelemetryAttribute.AppOrganizationId);
    expect(committedFragment).toContain(TelemetryAttribute.AppOrganizationId);
  });
});

describe("collector allow-list codegen", () => {
  it("renders a deny-by-default manifest carrying exactly the contract keys", () => {
    const manifest = JSON.parse(renderCollectorAllowlistManifest());
    expect(manifest.allowAllKeys).toBe(false);
    expect(manifest.allowedKeys).toEqual([...CollectorAllowedAttributeKeys]);
  });

  it("renders a redaction fragment that parses to the same key set", () => {
    const parsed = YAML.parse(renderCollectorRedactionFragment());
    expect(parsed.redaction.allow_all_keys).toBe(false);
    expect(parsed.redaction.allowed_keys).toEqual([
      ...CollectorAllowedAttributeKeys,
    ]);
  });

  it("is deterministic across renders", () => {
    expect(collectorAllowlistArtifacts()).toEqual(
      collectorAllowlistArtifacts()
    );
  });

  it("keeps the committed artifacts in sync with the generator", () => {
    const fresh = collectorAllowlistArtifacts();
    expect(committedManifest).toBe(fresh.manifestJson);
    expect(committedFragment).toBe(fresh.fragmentYaml);
  });
});

describe("collector allow-list drift guard", () => {
  it("reports no findings when the committed artifacts match the contract", () => {
    const findings = evaluateCollectorAllowlist({
      expectedKeys: CollectorAllowedAttributeKeys,
      manifestSource: committedManifest,
      fragmentSource: committedFragment,
    });
    expect(findings).toEqual([]);
  });

  it("fails when the contract gains an attribute the committed allow-list lacks", () => {
    const findings = evaluateCollectorAllowlist({
      expectedKeys: [...CollectorAllowedAttributeKeys, "app.brand_new"],
      manifestSource: committedManifest,
      fragmentSource: committedFragment,
    });

    const message = messagesOf(findings);
    expect(message).toContain("app.brand_new");
    expect(message).toContain("silently dropped");
    // Both the manifest and the fragment are missing the new key, and both are
    // stale against a fresh render.
    expect(findings.length).toBeGreaterThanOrEqual(2);
  });

  it("fails when a key is hand-removed from the committed manifest", () => {
    const manifest = JSON.parse(committedManifest) as {
      allowedKeys: string[];
    };
    const [removed, ...rest] = manifest.allowedKeys;
    const tampered = `${JSON.stringify({ ...manifest, allowedKeys: rest }, null, 2)}\n`;

    const findings = evaluateCollectorAllowlist({
      expectedKeys: CollectorAllowedAttributeKeys,
      manifestSource: tampered,
      fragmentSource: committedFragment,
    });

    const manifestFindings = findings.filter(
      (finding) => finding.file === "collector/allowed-attributes.json"
    );
    expect(messagesOf(manifestFindings)).toContain(removed);
  });

  it("fails when the fragment disables deny-by-default", () => {
    const tampered = committedFragment.replace(
      "allow_all_keys: false",
      "allow_all_keys: true"
    );

    const findings = evaluateCollectorAllowlist({
      expectedKeys: CollectorAllowedAttributeKeys,
      manifestSource: committedManifest,
      fragmentSource: tampered,
    });

    expect(messagesOf(findings)).toContain("deny-by-default");
  });

  it("flags malformed manifest JSON instead of throwing", () => {
    const findings = evaluateCollectorAllowlist({
      expectedKeys: CollectorAllowedAttributeKeys,
      manifestSource: "{ not json",
      fragmentSource: committedFragment,
    });

    expect(messagesOf(findings)).toContain("not valid JSON");
  });

  it("flags malformed fragment YAML instead of throwing", () => {
    const findings = evaluateCollectorAllowlist({
      expectedKeys: CollectorAllowedAttributeKeys,
      manifestSource: committedManifest,
      fragmentSource: "redaction: : invalid: {{{",
    });

    expect(messagesOf(findings)).toContain("not valid YAML");
  });

  it("fails when the manifest disables deny-by-default", () => {
    const manifest = JSON.parse(committedManifest) as Record<string, unknown>;
    const tampered = `${JSON.stringify({ ...manifest, allowAllKeys: true }, null, 2)}\n`;

    const findings = evaluateCollectorAllowlist({
      expectedKeys: CollectorAllowedAttributeKeys,
      manifestSource: tampered,
      fragmentSource: committedFragment,
    });

    expect(messagesOf(findings)).toContain("deny-by-default");
  });

  it("fails when a key is hand-removed from the committed fragment", () => {
    const [removed, ...rest] = CollectorAllowedAttributeKeys;
    const tamperedFragment = renderCollectorRedactionFragment(rest);

    const findings = evaluateCollectorAllowlist({
      expectedKeys: CollectorAllowedAttributeKeys,
      manifestSource: committedManifest,
      fragmentSource: tamperedFragment,
    });

    const fragmentFindings = findings.filter(
      (finding) => finding.file === "collector/keyless-telemetry-redaction.yaml"
    );
    expect(messagesOf(fragmentFindings)).toContain(removed);
  });

  it("fails when the committed allow-list carries a key the contract dropped", () => {
    // Contract shrank (first key removed) but the committed artifacts still
    // carry it — the "stale" extra-key branch of the diff must fire.
    const [dropped, ...remaining] = CollectorAllowedAttributeKeys;

    const findings = evaluateCollectorAllowlist({
      expectedKeys: remaining,
      manifestSource: committedManifest,
      fragmentSource: committedFragment,
    });

    const message = messagesOf(findings);
    expect(message).toContain("stale");
    expect(message).toContain(dropped);
  });
});
