import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  assertValidPolicy,
  CollectorTailSamplingPolicy,
  type CollectorTailSamplingPolicy as CollectorTailSamplingPolicyType,
  ERROR_STATUS_CODE,
} from "../collector-tail-sampling-policy";
import { evaluateCollectorTailSampling } from "../scripts/check-collector-tail-sampling";
import type { CollectorGuardFinding } from "../scripts/collector-codegen-common";
import {
  collectorTailSamplingArtifacts,
  renderCollectorTailSamplingFragment,
} from "../scripts/generate-collector-tail-sampling";

const FRAGMENT_PATH = new URL(
  "../collector/tail-sampling.yaml",
  import.meta.url
);
const committedFragment = readFileSync(FRAGMENT_PATH, "utf-8");

const messagesOf = (findings: CollectorGuardFinding[]): string =>
  findings.map((finding) => finding.message).join("\n");

/** Strips the trailing baseline policy block from a rendered fragment. */
const BASELINE_POLICY_BLOCK = new RegExp(
  `\\s+- name: ${CollectorTailSamplingPolicy.policyNames.baseline}[\\s\\S]*$`
);

type ParsedPolicy = {
  name: string;
  type: string;
  status_code?: { status_codes: string[] };
  numeric_attribute?: { key: string; min_value: number; max_value: number };
  latency?: { threshold_ms: number };
  probabilistic?: { sampling_percentage: number };
};

const parseFragment = (
  source: string
): {
  decision_wait: string;
  decision_cache: {
    sampled_cache_size: number;
    non_sampled_cache_size: number;
  };
  policies: ParsedPolicy[];
} => YAML.parse(source).tail_sampling;

const policyByName = (policies: ParsedPolicy[], name: string): ParsedPolicy => {
  const match = policies.find((policy) => policy.name === name);
  if (!match) {
    throw new Error(`policy "${name}" not found`);
  }
  return match;
};

describe("collector tail-sampling codegen", () => {
  it("renders a valid tail_sampling block with the four expected policies", () => {
    const { policies } = parseFragment(renderCollectorTailSamplingFragment());
    expect(policies.map((policy) => policy.name)).toEqual([
      CollectorTailSamplingPolicy.policyNames.errorStatus,
      CollectorTailSamplingPolicy.policyNames.serverErrors,
      CollectorTailSamplingPolicy.policyNames.slow,
      CollectorTailSamplingPolicy.policyNames.baseline,
    ]);
    expect(policies.map((policy) => policy.type)).toEqual([
      "status_code",
      "numeric_attribute",
      "numeric_attribute",
      "probabilistic",
    ]);
  });

  it("retains errors (status ERROR) and HTTP 5xx at 100% via non-probabilistic policies", () => {
    const { policies } = parseFragment(renderCollectorTailSamplingFragment());

    const errorStatus = policyByName(
      policies,
      CollectorTailSamplingPolicy.policyNames.errorStatus
    );
    expect(errorStatus.status_code?.status_codes).toEqual([ERROR_STATUS_CODE]);
    expect(errorStatus.probabilistic).toBeUndefined();

    const serverErrors = policyByName(
      policies,
      CollectorTailSamplingPolicy.policyNames.serverErrors
    );
    expect(serverErrors.numeric_attribute).toEqual({
      key: CollectorTailSamplingPolicy.serverErrorAttributeKey,
      min_value: CollectorTailSamplingPolicy.serverErrorStatusRange.min,
      max_value: CollectorTailSamplingPolicy.serverErrorStatusRange.max,
    });
    expect(serverErrors.probabilistic).toBeUndefined();
  });

  it("retains slow/p99 traces at 100% via child duration_ms, not root duration", () => {
    const { policies } = parseFragment(renderCollectorTailSamplingFragment());
    const slow = policyByName(
      policies,
      CollectorTailSamplingPolicy.policyNames.slow
    );
    expect(slow.numeric_attribute).toEqual({
      key: CollectorTailSamplingPolicy.slowLatencyAttributeKey,
      min_value: CollectorTailSamplingPolicy.slowLatencyThresholdMs,
      max_value: CollectorTailSamplingPolicy.slowLatencyMaxMs,
    });
    expect(slow.numeric_attribute?.max_value).toBe(86_400_000);
    expect(slow.latency).toBeUndefined();
    expect(slow.probabilistic).toBeUndefined();
  });

  it("sizes the decision buffer for the decision wait and expected trace rate", () => {
    expect(CollectorTailSamplingPolicy.numTraces).toBeGreaterThanOrEqual(
      CollectorTailSamplingPolicy.decisionWaitSeconds *
        CollectorTailSamplingPolicy.expectedNewTracesPerSec
    );
  });

  it("configures decision cache for late activity-root spans", () => {
    const { decision_cache } = parseFragment(
      renderCollectorTailSamplingFragment()
    );
    expect(decision_cache).toEqual({
      sampled_cache_size:
        CollectorTailSamplingPolicy.decisionCache.sampledCacheSize,
      non_sampled_cache_size:
        CollectorTailSamplingPolicy.decisionCache.nonSampledCacheSize,
    });
  });

  it("samples the remainder via exactly one probabilistic baseline policy", () => {
    const { policies } = parseFragment(renderCollectorTailSamplingFragment());
    const probabilistic = policies.filter(
      (policy) => policy.type === "probabilistic"
    );
    expect(probabilistic).toHaveLength(1);
    expect(probabilistic[0]?.name).toBe(
      CollectorTailSamplingPolicy.policyNames.baseline
    );
    expect(probabilistic[0]?.probabilistic?.sampling_percentage).toBe(
      CollectorTailSamplingPolicy.baselineSamplingPercentage
    );
  });

  it("carries the decision_wait window from the policy", () => {
    const { decision_wait } = parseFragment(
      renderCollectorTailSamplingFragment()
    );
    expect(decision_wait).toBe(
      `${CollectorTailSamplingPolicy.decisionWaitSeconds}s`
    );
  });

  it("is deterministic across renders", () => {
    expect(collectorTailSamplingArtifacts()).toEqual(
      collectorTailSamplingArtifacts()
    );
  });

  it("keeps the committed fragment in sync with the generator", () => {
    expect(committedFragment).toBe(
      collectorTailSamplingArtifacts().fragmentYaml
    );
  });
});

describe("collector tail-sampling policy validation", () => {
  const withPolicy = (
    overrides: Partial<CollectorTailSamplingPolicyType>
  ): CollectorTailSamplingPolicyType => ({
    ...CollectorTailSamplingPolicy,
    ...overrides,
  });

  it("accepts the shipped policy", () => {
    expect(() => assertValidPolicy(CollectorTailSamplingPolicy)).not.toThrow();
  });

  it.each([
    [
      "out-of-range sampling percentage",
      withPolicy({ baselineSamplingPercentage: 101 }),
    ],
    ["negative latency threshold", withPolicy({ slowLatencyThresholdMs: -1 })],
    [
      "inverted slow latency range",
      withPolicy({ slowLatencyThresholdMs: 10, slowLatencyMaxMs: 9 }),
    ],
    ["zero num_traces", withPolicy({ numTraces: 0 })],
    [
      "undersized decision buffer",
      withPolicy({ decisionWaitSeconds: 310, numTraces: 61_999 }),
    ],
    [
      "zero sampled decision cache",
      withPolicy({
        decisionCache: {
          ...CollectorTailSamplingPolicy.decisionCache,
          sampledCacheSize: 0,
        },
      }),
    ],
    [
      "inverted server-error range",
      withPolicy({ serverErrorStatusRange: { min: 599, max: 500 } }),
    ],
    [
      "duplicate policy names",
      withPolicy({
        policyNames: {
          errorStatus: "dup",
          serverErrors: "dup",
          slow: "slow",
          baseline: "baseline",
        },
      }),
    ],
  ])("rejects %s", (_label, policy) => {
    expect(() => assertValidPolicy(policy)).toThrow();
  });
});

describe("collector tail-sampling drift guard", () => {
  it("reports no findings when the committed fragment matches the SSOT", () => {
    expect(
      evaluateCollectorTailSampling({ fragmentSource: committedFragment })
    ).toEqual([]);
  });

  it("flags a hand-edited (stale) fragment", () => {
    const tampered = committedFragment.replace(
      `sampling_percentage: ${CollectorTailSamplingPolicy.baselineSamplingPercentage}`,
      `sampling_percentage: ${CollectorTailSamplingPolicy.baselineSamplingPercentage + 15}`
    );
    const findings = evaluateCollectorTailSampling({
      fragmentSource: tampered,
    });
    expect(findings).toHaveLength(1);
    expect(messagesOf(findings)).toContain("not up to date");
  });

  it("flags malformed YAML instead of throwing", () => {
    const findings = evaluateCollectorTailSampling({
      fragmentSource: "tail_sampling: : invalid: {{{",
    });
    expect(findings).toHaveLength(1);
    expect(messagesOf(findings)).toContain("not valid YAML");
  });

  it("flags a fragment missing the tail_sampling block", () => {
    const findings = evaluateCollectorTailSampling({
      fragmentSource: "redaction:\n  allow_all_keys: false\n",
    });
    expect(findings).toHaveLength(1);
    expect(messagesOf(findings)).toContain('"tail_sampling" processor block');
  });

  it("flags a fragment whose policies list is empty", () => {
    const findings = evaluateCollectorTailSampling({
      fragmentSource: "tail_sampling:\n  policies: []\n",
    });
    expect(findings).toHaveLength(1);
    expect(messagesOf(findings)).toContain("non-empty list");
  });

  it("flags a fragment whose baseline probabilistic policy was removed", () => {
    const withoutBaseline = renderCollectorTailSamplingFragment().replace(
      BASELINE_POLICY_BLOCK,
      "\n"
    );
    const findings = evaluateCollectorTailSampling({
      fragmentSource: withoutBaseline,
    });
    expect(findings).toHaveLength(1);
    expect(messagesOf(findings)).toContain("sampling would be a no-op");
  });
});
