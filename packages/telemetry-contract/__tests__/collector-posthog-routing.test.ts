import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { evaluateCollectorPosthogRouting } from "../scripts/check-collector-posthog-routing";
import type { CollectorGuardFinding } from "../scripts/collector-codegen-common";
import {
  collectorPosthogRoutingArtifacts,
  POSTHOG_FILTER_PROCESSOR_NAME,
  POSTHOG_IDENTITY_PROCESSOR_NAME,
  PosthogIdentityAttribute,
  renderCollectorPosthogIdentityFragment,
  renderCollectorPosthogIdentityManifest,
  renderCollectorPosthogRoutingFragment,
  renderCollectorPosthogRoutingManifest,
} from "../scripts/generate-collector-posthog-routing";
import {
  CollectorProductSignalAttributeKeys,
  TelemetryAttribute,
} from "../src/attributes";

const MANIFEST_PATH = new URL(
  "../collector/posthog-product-signals.json",
  import.meta.url
);
const FRAGMENT_PATH = new URL(
  "../collector/keyless-telemetry-posthog-routing.yaml",
  import.meta.url
);
const IDENTITY_MANIFEST_PATH = new URL(
  "../collector/posthog-identity-transform.json",
  import.meta.url
);
const IDENTITY_FRAGMENT_PATH = new URL(
  "../collector/keyless-telemetry-posthog-identity.yaml",
  import.meta.url
);

const committedManifest = readFileSync(MANIFEST_PATH, "utf-8");
const committedFragment = readFileSync(FRAGMENT_PATH, "utf-8");
const committedIdentityManifest = readFileSync(IDENTITY_MANIFEST_PATH, "utf-8");
const committedIdentityFragment = readFileSync(IDENTITY_FRAGMENT_PATH, "utf-8");

const EMPTY_MARKER_ERROR = /empty/i;
const UNSAFE_KEY_ERROR = /not safe/i;

const messagesOf = (findings: CollectorGuardFinding[]): string =>
  findings.map((finding) => finding.message).join("\n");

describe("CollectorProductSignalAttributeKeys SSOT", () => {
  it("is the de-duplicated, lexically sorted product-signal marker set", () => {
    const expected = [
      ...new Set<string>([TelemetryAttribute.GenAiRequestModel]),
    ].sort();
    expect([...CollectorProductSignalAttributeKeys]).toEqual(expected);
  });

  it("designates the GenAI discriminator as the product signal", () => {
    expect(CollectorProductSignalAttributeKeys).toContain(
      TelemetryAttribute.GenAiRequestModel
    );
  });

  it("has no duplicate keys", () => {
    expect(new Set(CollectorProductSignalAttributeKeys).size).toBe(
      CollectorProductSignalAttributeKeys.length
    );
  });
});

describe("collector PostHog routing codegen", () => {
  it("renders a manifest carrying exactly the contract marker keys", () => {
    const manifest = JSON.parse(renderCollectorPosthogRoutingManifest());
    expect(manifest.markerKeys).toEqual([
      ...CollectorProductSignalAttributeKeys,
    ]);
  });

  it("renders a filter fragment that drops spans lacking every marker", () => {
    const parsed = YAML.parse(renderCollectorPosthogRoutingFragment());
    const processor = parsed[POSTHOG_FILTER_PROCESSOR_NAME];
    expect(processor.error_mode).toBe("ignore");
    expect(processor.traces.span).toEqual([
      'attributes["gen_ai.request.model"] == nil',
    ]);
  });

  it("conjoins one nil-clause per marker for a multi-marker set", () => {
    const fragment = renderCollectorPosthogRoutingFragment([
      TelemetryAttribute.GenAiRequestModel,
      TelemetryAttribute.GenAiResponseId,
    ]);
    const [condition] =
      YAML.parse(fragment)[POSTHOG_FILTER_PROCESSOR_NAME].traces.span;
    expect(condition).toBe(
      'attributes["gen_ai.request.model"] == nil and attributes["gen_ai.response.id"] == nil'
    );
  });

  it("is deterministic across renders", () => {
    expect(collectorPosthogRoutingArtifacts()).toEqual(
      collectorPosthogRoutingArtifacts()
    );
  });

  it("renders a PostHog identity manifest for installation-id attribution", () => {
    const manifest = JSON.parse(renderCollectorPosthogIdentityManifest());
    expect(manifest).toMatchObject({
      processorName: POSTHOG_IDENTITY_PROCESSOR_NAME,
      sourceKey: TelemetryAttribute.AppInstallationId,
      targetKey: PosthogIdentityAttribute.DistinctId,
    });
  });

  it("renders a PostHog identity transform guarded on the source key", () => {
    const parsed = YAML.parse(renderCollectorPosthogIdentityFragment());
    const processor = parsed[POSTHOG_IDENTITY_PROCESSOR_NAME];
    expect(processor.error_mode).toBe("ignore");
    expect(processor.trace_statements).toEqual([
      {
        context: "resource",
        statements: [
          'set(attributes["posthog.distinct_id"], attributes["app.installation.id"]) where attributes["app.installation.id"] != nil',
        ],
      },
    ]);
  });

  it("keeps the PostHog identity key out of the public telemetry attributes", () => {
    expect(Object.values(TelemetryAttribute)).not.toContain(
      PosthogIdentityAttribute.DistinctId
    );
  });

  it("keeps the committed artifacts in sync with the generator", () => {
    const fresh = collectorPosthogRoutingArtifacts();
    expect(committedManifest).toBe(fresh.manifestJson);
    expect(committedFragment).toBe(fresh.fragmentYaml);
    expect(committedIdentityManifest).toBe(fresh.identityManifestJson);
    expect(committedIdentityFragment).toBe(fresh.identityFragmentYaml);
  });

  it("refuses to render an empty marker set (would drop every span)", () => {
    expect(() => renderCollectorPosthogRoutingFragment([])).toThrow(
      EMPTY_MARKER_ERROR
    );
  });

  it("refuses a marker key that is not safe as a bare OTTL/YAML scalar", () => {
    expect(() =>
      renderCollectorPosthogRoutingFragment(["gen_ai.request.model'; drop"])
    ).toThrow(UNSAFE_KEY_ERROR);
  });
});

describe("collector PostHog routing drift guard", () => {
  it("reports no findings when the committed artifacts match the contract", () => {
    const findings = evaluateCollectorPosthogRouting({
      expectedKeys: CollectorProductSignalAttributeKeys,
      manifestSource: committedManifest,
      fragmentSource: committedFragment,
      identityManifestSource: committedIdentityManifest,
      identityFragmentSource: committedIdentityFragment,
    });
    expect(findings).toEqual([]);
  });

  it("fails when the identity manifest omits the installation-id source", () => {
    const manifest = JSON.parse(committedIdentityManifest) as Record<
      string,
      unknown
    >;
    const tampered = `${JSON.stringify(
      { ...manifest, sourceKey: "app.installation.other" },
      null,
      2
    )}\n`;

    const findings = evaluateCollectorPosthogRouting({
      expectedKeys: CollectorProductSignalAttributeKeys,
      manifestSource: committedManifest,
      fragmentSource: committedFragment,
      identityManifestSource: tampered,
      identityFragmentSource: committedIdentityFragment,
    });

    expect(messagesOf(findings)).toContain(
      TelemetryAttribute.AppInstallationId
    );
  });

  it("fails when the identity transform omits the PostHog distinct-id target", () => {
    const tampered = committedIdentityFragment.replace(
      PosthogIdentityAttribute.DistinctId,
      "posthog.user_id"
    );

    const findings = evaluateCollectorPosthogRouting({
      expectedKeys: CollectorProductSignalAttributeKeys,
      manifestSource: committedManifest,
      fragmentSource: committedFragment,
      identityManifestSource: committedIdentityManifest,
      identityFragmentSource: tampered,
    });

    expect(messagesOf(findings)).toContain(PosthogIdentityAttribute.DistinctId);
  });

  it("flags malformed identity manifest JSON instead of throwing", () => {
    const findings = evaluateCollectorPosthogRouting({
      expectedKeys: CollectorProductSignalAttributeKeys,
      manifestSource: committedManifest,
      fragmentSource: committedFragment,
      identityManifestSource: "{ not json",
      identityFragmentSource: committedIdentityFragment,
    });

    expect(messagesOf(findings)).toContain("not valid JSON");
  });

  it("flags malformed identity transform YAML instead of throwing", () => {
    const findings = evaluateCollectorPosthogRouting({
      expectedKeys: CollectorProductSignalAttributeKeys,
      manifestSource: committedManifest,
      fragmentSource: committedFragment,
      identityManifestSource: committedIdentityManifest,
      identityFragmentSource: "transform/posthog_identity: : invalid: {{{",
    });

    expect(messagesOf(findings)).toContain("not valid YAML");
  });

  it("fails when the contract marker set diverges from the committed artifacts", () => {
    // Contract now designates a different marker; the committed artifacts still
    // carry the old one — both the missing-marker and stale-marker branches fire.
    const findings = evaluateCollectorPosthogRouting({
      expectedKeys: ["gen_ai.other.model"],
      manifestSource: committedManifest,
      fragmentSource: committedFragment,
    });

    const message = messagesOf(findings);
    expect(message).toContain("gen_ai.other.model");
    expect(message).toContain("gen_ai.request.model");
    expect(message).toContain("stale");
  });

  it("fails when the fragment no longer references a contract marker", () => {
    const tamperedFragment = renderCollectorPosthogRoutingFragment([
      "gen_ai.other.model",
    ]);

    const findings = evaluateCollectorPosthogRouting({
      expectedKeys: CollectorProductSignalAttributeKeys,
      manifestSource: committedManifest,
      fragmentSource: tamperedFragment,
    });

    const fragmentFindings = findings.filter(
      (finding) =>
        finding.file === "collector/keyless-telemetry-posthog-routing.yaml"
    );
    expect(messagesOf(fragmentFindings)).toContain("gen_ai.request.model");
  });

  it("fails when the manifest marker list is empty", () => {
    const manifest = JSON.parse(committedManifest) as Record<string, unknown>;
    const tampered = `${JSON.stringify({ ...manifest, markerKeys: [] }, null, 2)}\n`;

    const findings = evaluateCollectorPosthogRouting({
      expectedKeys: CollectorProductSignalAttributeKeys,
      manifestSource: tampered,
      fragmentSource: committedFragment,
    });

    expect(messagesOf(findings)).toContain("must not be empty");
  });

  it("flags a fragment missing the filter processor block", () => {
    const tampered = committedFragment.replace(
      `${POSTHOG_FILTER_PROCESSOR_NAME}:`,
      "some_other_processor:"
    );

    const findings = evaluateCollectorPosthogRouting({
      expectedKeys: CollectorProductSignalAttributeKeys,
      manifestSource: committedManifest,
      fragmentSource: tampered,
    });

    expect(messagesOf(findings)).toContain(POSTHOG_FILTER_PROCESSOR_NAME);
  });

  it("flags malformed manifest JSON instead of throwing", () => {
    const findings = evaluateCollectorPosthogRouting({
      expectedKeys: CollectorProductSignalAttributeKeys,
      manifestSource: "{ not json",
      fragmentSource: committedFragment,
    });

    expect(messagesOf(findings)).toContain("not valid JSON");
  });

  it("flags malformed fragment YAML instead of throwing", () => {
    const findings = evaluateCollectorPosthogRouting({
      expectedKeys: CollectorProductSignalAttributeKeys,
      manifestSource: committedManifest,
      fragmentSource: "filter/product_signals: : invalid: {{{",
    });

    expect(messagesOf(findings)).toContain("not valid YAML");
  });

  it("treats an unreadable/empty committed fragment as drift", () => {
    const findings = evaluateCollectorPosthogRouting({
      expectedKeys: CollectorProductSignalAttributeKeys,
      manifestSource: committedManifest,
      fragmentSource: "",
    });

    expect(findings.length).toBeGreaterThan(0);
  });

  it("flags a structurally-valid manifest that differs only in formatting", () => {
    // Same markerKeys, reserialized compactly: the structural set-comparison
    // passes, so only the byte-identity ("not up to date") branch fires.
    const reformatted = `${JSON.stringify(JSON.parse(committedManifest))}\n`;

    const findings = evaluateCollectorPosthogRouting({
      expectedKeys: CollectorProductSignalAttributeKeys,
      manifestSource: reformatted,
      fragmentSource: committedFragment,
    });

    const manifestFindings = findings.filter(
      (finding) => finding.file === "collector/posthog-product-signals.json"
    );
    expect(manifestFindings).toHaveLength(1);
    expect(messagesOf(manifestFindings)).toContain("not up to date");
  });

  it("returns a finding (does not throw) when expectedKeys is empty", () => {
    // A zero-marker contract would make the fresh-render comparison throw; the
    // guard must surface it as a finding instead so the build fails cleanly.
    expect(() =>
      evaluateCollectorPosthogRouting({
        expectedKeys: [],
        manifestSource: committedManifest,
        fragmentSource: committedFragment,
      })
    ).not.toThrow();

    const findings = evaluateCollectorPosthogRouting({
      expectedKeys: [],
      manifestSource: committedManifest,
      fragmentSource: committedFragment,
    });
    expect(findings).toHaveLength(1);
    expect(messagesOf(findings)).toContain("No product-signal markers");
  });
});
