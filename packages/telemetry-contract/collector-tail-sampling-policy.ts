import { TelemetryAttribute } from "./src/attributes";

export type CollectorTailSamplingPolicy = {
  /** Window the collector buffers a trace's spans before deciding (seconds). */
  readonly decisionWaitSeconds: number;
  /** Max in-flight traces held in memory for decisions (sizing hint). */
  readonly numTraces: number;
  /** Expected new traces/sec — collector pre-sizes buffers from this hint. */
  readonly expectedNewTracesPerSec: number;
  /**
   * Whole-trace duration (earliest buffered span start to latest buffered span
   * end, in ms) at/above which the `latency` policy keeps a trace at 100%.
   *
   * Must stay strictly below the decision window — not because otelcol cannot
   * represent a longer span (the policy reads span TIMESTAMPS, so one span
   * carrying hours of duration in a single export would present them), but
   * because of the shape this collector's only producer emits. A desktop
   * activity root is exported when it CLOSES, so a root that outlives
   * `decisionWaitSeconds` is voted on before it ever arrives and only its
   * children — spanning at most the buffering window — are in the buffer.
   * Above that window `keep-slow` could therefore only be tripped by a trace
   * whose whole duration arrives in one export, which cl-desktop never emits.
   */
  readonly slowTraceLatencyThresholdMs: number;
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
  // 310 = DESKTOP_ACTIVITY_ROOT_MAX_AGE_MS (300s, `apps/desktop/src/main/
  // telemetry/app-otel-runtime.ts`) + 10s of export slack, so a desktop activity
  // window that closes at its cap is voted on whole. The max-age check is lazy,
  // so 14.9% of roots still outlive 310s (p99 = 3,254s, measured 7d to
  // 2026-09-07); ISS-9254 accepted that residual deliberately — covering it
  // would need a multi-thousand-second buffer and delay every decision by tens
  // of minutes. Argue against the trade before raising this.
  decisionWaitSeconds: 310,
  numTraces: 62_000,
  expectedNewTracesPerSec: 200,
  // 240s, measured (ISS-9254): 32.5% of cl-desktop traces reach it over 7d,
  // against 99.9% at the 2000ms the collector shipped and ~0% for any value at
  // or above the 310s window. It sits in the sparsest stretch of the
  // distribution — 240s to 300s holds 22 of 1,083 traces — so retention barely
  // moves if the fleet shifts, and it clears the 300s activity-window cap by
  // 60s so a full window is still caught when its last spans arrive late.
  slowTraceLatencyThresholdMs: 240_000,
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
  requirePositiveInt(
    "slowTraceLatencyThresholdMs",
    policy.slowTraceLatencyThresholdMs
  );
  // The failure this guard exists for is silent: on the desktop trace shape a
  // threshold the buffer can never accumulate leaves `keep-slow` green,
  // configured, and dead.
  if (policy.slowTraceLatencyThresholdMs >= policy.decisionWaitSeconds * 1000) {
    problems.push(
      `slowTraceLatencyThresholdMs must be < decisionWaitSeconds * 1000: a desktop activity root that outlives the decision window is voted on before it arrives, so no trace presents a wider buffered timestamp span and keep-slow could never fire (got ${policy.slowTraceLatencyThresholdMs} >= ${policy.decisionWaitSeconds * 1000}).`
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
