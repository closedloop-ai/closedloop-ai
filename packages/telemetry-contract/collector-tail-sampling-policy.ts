import { TelemetryAttribute } from "./src/attributes";
import { TelemetryDurationMsMax } from "./src/schema-primitives";

/**
 * Typed source of truth for the keyless-telemetry collector tail-sampling
 * policy (FEA-1992). Extracted here as a published module (FEA-1997) so two
 * consumers share one definition without drift:
 *  - the collector codegen + drift guard
 *    (`scripts/generate-collector-tail-sampling.ts` /
 *    `scripts/check-collector-tail-sampling.ts`), which render and verify the
 *    committed `collector/tail-sampling.yaml` fragment; and
 *  - the desktop IPC perf head-sampler
 *    (`apps/desktop/src/main/agent-dashboard-design-system-runtime.ts`), which
 *    reuses `slowLatencyThresholdMs` + `baselineSamplingPercentage` so its
 *    head-sampling matches the collector's tail policy by construction.
 *
 * Every knob the collector needs lives here, in one tested place; the cl-tofu
 * fragment is a pure projection of it.
 */
export type CollectorTailSamplingPolicy = {
  /** Window the collector buffers a trace's spans before deciding (seconds). */
  readonly decisionWaitSeconds: number;
  /** Max in-flight traces held in memory for decisions (sizing hint). */
  readonly numTraces: number;
  /** Expected new traces/sec — collector pre-sizes buffers from this hint. */
  readonly expectedNewTracesPerSec: number;
  /**
   * Child-span duration_ms at/above which a trace is treated as slow and kept
   * at 100%. Activity-window root duration is intentionally excluded.
   */
  readonly slowLatencyThresholdMs: number;
  /** Span attribute carrying the bounded child-operation duration in ms. */
  readonly slowLatencyAttributeKey: string;
  /** Inclusive upper bound accepted by the collector numeric_attribute policy. */
  readonly slowLatencyMaxMs: number;
  /** Baseline keep rate (%) applied to everything not caught by a keep policy. */
  readonly baselineSamplingPercentage: number;
  /** Span attribute carrying the HTTP status code, matched for 5xx retention. */
  readonly serverErrorAttributeKey: string;
  /** Inclusive HTTP status range retained as server errors. */
  readonly serverErrorStatusRange: {
    readonly min: number;
    readonly max: number;
  };
  /** Persist keep/drop decisions so late root spans follow the original vote. */
  readonly decisionCache: {
    readonly sampledCacheSize: number;
    readonly nonSampledCacheSize: number;
  };
  /** Stable policy names (also the otelcol decision metric labels). */
  readonly policyNames: {
    readonly errorStatus: string;
    readonly serverErrors: string;
    readonly slow: string;
    readonly baseline: string;
  };
};

/** OTel span status string the `status_code` policy retains. */
export const ERROR_STATUS_CODE = "ERROR";

export const CollectorTailSamplingPolicy: CollectorTailSamplingPolicy = {
  decisionWaitSeconds: 310,
  numTraces: 62_000,
  expectedNewTracesPerSec: 200,
  slowLatencyThresholdMs: 2000,
  slowLatencyAttributeKey: TelemetryAttribute.DurationMs,
  slowLatencyMaxMs: TelemetryDurationMsMax,
  baselineSamplingPercentage: 10,
  // Canonical contract key (single source of truth); the numeric_attribute
  // policy must match the same key the SDK emits on error spans.
  serverErrorAttributeKey: TelemetryAttribute.HttpResponseStatusCode,
  serverErrorStatusRange: { min: 500, max: 599 },
  decisionCache: {
    sampledCacheSize: 100_000,
    nonSampledCacheSize: 100_000,
  },
  policyNames: {
    errorStatus: "keep-error-status",
    serverErrors: "keep-server-errors",
    slow: "keep-slow",
    baseline: "baseline",
  },
};

/**
 * Fail loudly if the policy is internally inconsistent, so an invalid future
 * edit surfaces here instead of silently producing a collector config the
 * otelcol binary rejects at startup (or, worse, accepts but samples
 * incorrectly).
 */
export function assertValidPolicy(policy: CollectorTailSamplingPolicy): void {
  const problems: string[] = [];

  const requirePositiveInt = (label: string, value: number): void => {
    if (!Number.isInteger(value) || value <= 0) {
      problems.push(`${label} must be a positive integer (got ${value}).`);
    }
  };

  requirePositiveInt("decisionWaitSeconds", policy.decisionWaitSeconds);
  requirePositiveInt("numTraces", policy.numTraces);
  requirePositiveInt("expectedNewTracesPerSec", policy.expectedNewTracesPerSec);
  if (
    policy.numTraces <
    policy.decisionWaitSeconds * policy.expectedNewTracesPerSec
  ) {
    problems.push(
      `numTraces must be >= decisionWaitSeconds * expectedNewTracesPerSec (got ${policy.numTraces} < ${policy.decisionWaitSeconds * policy.expectedNewTracesPerSec}).`
    );
  }
  requirePositiveInt("slowLatencyThresholdMs", policy.slowLatencyThresholdMs);
  requirePositiveInt("slowLatencyMaxMs", policy.slowLatencyMaxMs);
  if (policy.slowLatencyThresholdMs > policy.slowLatencyMaxMs) {
    problems.push(
      `slowLatencyThresholdMs must be <= slowLatencyMaxMs (got ${policy.slowLatencyThresholdMs} > ${policy.slowLatencyMaxMs}).`
    );
  }
  requirePositiveInt(
    "decisionCache.sampledCacheSize",
    policy.decisionCache.sampledCacheSize
  );
  requirePositiveInt(
    "decisionCache.nonSampledCacheSize",
    policy.decisionCache.nonSampledCacheSize
  );

  if (
    !Number.isInteger(policy.baselineSamplingPercentage) ||
    policy.baselineSamplingPercentage < 0 ||
    policy.baselineSamplingPercentage > 100
  ) {
    problems.push(
      `baselineSamplingPercentage must be an integer in [0, 100] (got ${policy.baselineSamplingPercentage}).`
    );
  }

  const { min, max } = policy.serverErrorStatusRange;
  const isHttpStatus = (value: number): boolean =>
    Number.isInteger(value) && value >= 100 && value <= 599;
  if (!(isHttpStatus(min) && isHttpStatus(max) && min <= max)) {
    problems.push(
      `serverErrorStatusRange must be an ordered HTTP status range within [100, 599] (got ${min}..${max}).`
    );
  }

  const names = Object.values(policy.policyNames);
  if (names.some((name) => name.trim().length === 0)) {
    problems.push("policy names must be non-empty.");
  }
  if (new Set(names).size !== names.length) {
    problems.push(`policy names must be unique (got ${names.join(", ")}).`);
  }

  if (problems.length > 0) {
    throw new Error(
      `Invalid collector tail-sampling policy:\n- ${problems.join("\n- ")}`
    );
  }
}
