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
  RoutineAuditTelemetryAttributes,
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

/**
 * ISS-6313: the wire names of the routine/audit group, written out as literals
 * rather than projected from `TelemetryAttribute`.
 *
 * The duplication IS the test. Every other assertion in this file derives its
 * expectation from the same const the artifacts are generated from, so renaming
 * an attribute's VALUE — the string Datadog dashboards and the collector
 * allow-list key off — keeps them all green as long as the TypeScript key is
 * untouched. Pinning the strings here is what makes a rename, a deletion, or a
 * regenerate this PR forgot fail in CI instead of in a customer's pipeline.
 */
const ROUTINE_AUDIT_WIRE_KEYS = [
  "audit.actor_kind",
  "audit.decision",
  "audit.event",
  "routine.event",
  "routine.failure_reason",
  "routine.id",
  "routine.outcome",
  "routine.step_index",
  "routine.trigger",
] as const;

const isRoutineAuditKey = (key: string): boolean =>
  key.startsWith("routine.") || key.startsWith("audit.");

describe("routine/audit attribute group reaches the collector allow-list", () => {
  it("publishes exactly the pinned wire names in the committed manifest", () => {
    const manifest = JSON.parse(committedManifest);
    const published: string[] = manifest.allowedKeys.filter(isRoutineAuditKey);

    expect(published).toEqual([...ROUTINE_AUDIT_WIRE_KEYS]);
  });

  it("publishes exactly the pinned wire names in the committed redaction fragment", () => {
    const parsed = YAML.parse(committedFragment);
    const published: string[] =
      parsed.redaction.allowed_keys.filter(isRoutineAuditKey);

    expect(published).toEqual([...ROUTINE_AUDIT_WIRE_KEYS]);
    // Positive control for the deny-by-default claim below: the same fragment
    // this filter read really does carry keys, so an empty routine/audit slice
    // would mean the group is missing, not that the parse produced nothing.
    expect(parsed.redaction.allowed_keys.length).toBeGreaterThan(
      ROUTINE_AUDIT_WIRE_KEYS.length
    );
    expect(parsed.redaction.allow_all_keys).toBe(false);
  });

  it("keeps the group's declared members and its published keys in agreement", () => {
    const declared = RoutineAuditTelemetryAttributes.filter(isRoutineAuditKey);

    expect([...declared].sort()).toEqual([...ROUTINE_AUDIT_WIRE_KEYS]);
  });

  it("reuses the canonical duration attribute instead of a routine-namespaced twin", () => {
    expect(RoutineAuditTelemetryAttributes).toContain(
      TelemetryAttribute.DurationMs
    );
    expect(CollectorAllowedAttributeKeys).toContain(
      TelemetryAttribute.DurationMs
    );
    expect(
      RoutineAuditTelemetryAttributes.filter(isRoutineAuditKey)
    ).not.toContain("routine.duration_ms");
  });
});
