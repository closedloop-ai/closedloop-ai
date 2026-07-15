import { createHash } from "node:crypto";
import { CollectorTailSamplingPolicy } from "../collector-tail-sampling-policy";

/**
 * Synthetic OTLP/HTTP trace builder for the collector tail-sampling mechanical
 * verification (FEA-2182).
 *
 * Each scenario produces whole single-span traces (distinct trace IDs) shaped to
 * exercise exactly one keep-policy leg of the committed `tail_sampling` fragment,
 * plus a `baseline` cohort that only the probabilistic policy can retain. The
 * builder is a pure function of {@link CollectorTailSamplingPolicy} (no literal
 * thresholds, no clock, no randomness) so it stays in lock-step with the SSOT and
 * is deterministically unit-testable. The runner pushes the payloads at a real
 * otelcol-contrib binary and checks the collector's own decision metrics.
 */

/** OTel span status codes (OTLP enum). */
const SPAN_STATUS_UNSET = 0;
const SPAN_STATUS_ERROR = 2;

/** Attribute key the runner/exporter groups retained spans by. */
export const SCENARIO_ATTRIBUTE_KEY = "test.scenario";

export const Scenario = {
  Error: "error",
  ServerError: "server-error",
  Slow: "slow",
  Baseline: "baseline",
} as const;
export type Scenario = (typeof Scenario)[keyof typeof Scenario];

/** Whether a scenario is retained at 100% (a keep-policy) or sampled (baseline). */
export type ScenarioExpectation =
  | { readonly kind: "always" }
  | { readonly kind: "sampled"; readonly samplingPercentage: number };

export type ScenarioManifestEntry = {
  readonly scenario: Scenario;
  readonly sent: number;
  /** The keep-policy whose decision metric should account for these traces. */
  readonly policyName: string;
  readonly expectation: ScenarioExpectation;
};

export type ScenarioCounts = {
  readonly errors: number;
  readonly serverErrors: number;
  readonly slow: number;
  readonly baseline: number;
};

/** An OTLP/HTTP JSON ExportTraceServiceRequest carrying a single trace. */
export type OtlpTracePayload = {
  readonly resourceSpans: readonly Record<string, unknown>[];
};

export type SyntheticTraffic = {
  /** One payload per trace, ready to POST to `/v1/traces`. */
  readonly payloads: readonly OtlpTracePayload[];
  /** Per-scenario expected outcome, for asserting decisions after the run. */
  readonly manifest: readonly ScenarioManifestEntry[];
  /** Total traces sent across all scenarios (canonical; == `payloads.length`). */
  readonly totalSent: number;
};

export type BuildOptions = {
  /**
   * Wall-clock base (nanoseconds) the runner stamps so spans look current; the
   * latency policy only cares about (end − start), but a realistic absolute time
   * avoids any age-based handling downstream. Pure callers pass a fixed value.
   */
  readonly baseTimeUnixNano: bigint;
};

/**
 * Deterministic, full-entropy hex id derived from a seed. A real trace id is 16
 * random bytes, and the otelcol probabilistic policy hashes the id — low-entropy
 * sequential ids (0x…01, 0x…02) would hash into a degenerate region and sample
 * ~0%. A SHA-256 digest gives reproducible (no RNG, no clock) but uniformly
 * distributed bytes, so the sampled baseline rate matches the configured value.
 */
function deterministicHexId(seed: string, bytes: number): string {
  return createHash("sha256")
    .update(seed)
    .digest("hex")
    .slice(0, bytes * 2);
}

/** Deterministic, high-entropy 16-byte trace id for a trace index. */
function traceIdFor(index: number): string {
  return deterministicHexId(`tail-sampling-verify/trace/${index}`, 16);
}

/** Deterministic, high-entropy 8-byte span id for a trace index. */
function spanIdFor(index: number): string {
  return deterministicHexId(`tail-sampling-verify/span/${index}`, 8);
}

function buildSpan(args: {
  readonly index: number;
  readonly scenario: Scenario;
  readonly baseTimeUnixNano: bigint;
  readonly durationNanos: bigint;
  readonly statusCode: number;
  readonly extraAttributes?: readonly Record<string, unknown>[];
}): Record<string, unknown> {
  const start = args.baseTimeUnixNano;
  const end = start + args.durationNanos;
  return {
    // Distinct, deterministic, high-entropy ids per trace (see deterministicHexId).
    traceId: traceIdFor(args.index),
    spanId: spanIdFor(args.index),
    name: `synthetic-${args.scenario}`,
    kind: 2, // SPAN_KIND_SERVER — a root HTTP-op span, matching fleet shape.
    startTimeUnixNano: start.toString(),
    endTimeUnixNano: end.toString(),
    attributes: [
      {
        key: SCENARIO_ATTRIBUTE_KEY,
        value: { stringValue: args.scenario },
      },
      ...(args.extraAttributes ?? []),
    ],
    status: { code: args.statusCode },
  };
}

function wrapTrace(span: Record<string, unknown>): OtlpTracePayload {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            {
              key: "service.name",
              value: { stringValue: "tail-sampling-verification" },
            },
          ],
        },
        scopeSpans: [
          {
            scope: { name: "collector-tail-sampling-verification" },
            spans: [span],
          },
        ],
      },
    ],
  };
}

/**
 * Build synthetic OTLP traffic that exercises every leg of the committed policy.
 *
 * - error → span status ERROR (`keep-error-status`)
 * - server-error → `http.response.status_code` in [min,max] (`keep-server-errors`)
 * - slow → root-span duration above `slowLatencyThresholdMs` (`keep-slow`)
 * - baseline → fast, status-unset, no 5xx; only `baseline` can retain it
 */
export function buildScenarioTraces(
  counts: ScenarioCounts,
  options: BuildOptions
): SyntheticTraffic {
  const policy = CollectorTailSamplingPolicy;
  const fastDuration = 1_000_000n; // 1ms — comfortably below the slow threshold.
  // One millisecond past the threshold so the boundary is unambiguous.
  const slowDuration = BigInt(policy.slowLatencyThresholdMs + 1) * 1_000_000n;
  const serverErrorStatus = policy.serverErrorStatusRange.min; // e.g. 500.

  const payloads: OtlpTracePayload[] = [];
  let index = 0;

  const push = (
    n: number,
    make: (i: number) => Record<string, unknown>
  ): void => {
    for (let i = 0; i < n; i += 1) {
      payloads.push(wrapTrace(make(index)));
      index += 1;
    }
  };

  push(counts.errors, (i) =>
    buildSpan({
      index: i,
      scenario: Scenario.Error,
      baseTimeUnixNano: options.baseTimeUnixNano,
      durationNanos: fastDuration,
      statusCode: SPAN_STATUS_ERROR,
    })
  );

  push(counts.serverErrors, (i) =>
    buildSpan({
      index: i,
      scenario: Scenario.ServerError,
      baseTimeUnixNano: options.baseTimeUnixNano,
      durationNanos: fastDuration,
      statusCode: SPAN_STATUS_UNSET,
      extraAttributes: [
        {
          key: policy.serverErrorAttributeKey,
          value: { intValue: String(serverErrorStatus) },
        },
      ],
    })
  );

  push(counts.slow, (i) =>
    buildSpan({
      index: i,
      scenario: Scenario.Slow,
      baseTimeUnixNano: options.baseTimeUnixNano,
      durationNanos: slowDuration,
      statusCode: SPAN_STATUS_UNSET,
    })
  );

  push(counts.baseline, (i) =>
    buildSpan({
      index: i,
      scenario: Scenario.Baseline,
      baseTimeUnixNano: options.baseTimeUnixNano,
      durationNanos: fastDuration,
      statusCode: SPAN_STATUS_UNSET,
    })
  );

  const manifest: ScenarioManifestEntry[] = [
    {
      scenario: Scenario.Error,
      sent: counts.errors,
      policyName: policy.policyNames.errorStatus,
      expectation: { kind: "always" },
    },
    {
      scenario: Scenario.ServerError,
      sent: counts.serverErrors,
      policyName: policy.policyNames.serverErrors,
      expectation: { kind: "always" },
    },
    {
      scenario: Scenario.Slow,
      sent: counts.slow,
      policyName: policy.policyNames.slow,
      expectation: { kind: "always" },
    },
    {
      scenario: Scenario.Baseline,
      sent: counts.baseline,
      policyName: policy.policyNames.baseline,
      expectation: {
        kind: "sampled",
        samplingPercentage: policy.baselineSamplingPercentage,
      },
    },
  ];

  return { payloads, manifest, totalSent: payloads.length };
}
