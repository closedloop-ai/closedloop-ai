import type { Scenario, ScenarioManifestEntry } from "./synthetic-otlp";
import { SCENARIO_ATTRIBUTE_KEY } from "./synthetic-otlp";

/**
 * Pure parsing + leg evaluation for the tail-sampling mechanical verification
 * (FEA-2182). The runner does the I/O (scrape Prometheus, read the export file);
 * everything here is a pure function of strings so the decision logic is fully
 * unit-tested without Docker.
 */

/** Per-policy decision counts from the collector's own tail-sampling metric. */
export type PolicyDecision = {
  readonly sampledTrue: number;
  readonly sampledFalse: number;
};

export type DecisionMetrics = ReadonlyMap<string, PolicyDecision>;

// otelcol emits `otelcol_processor_tail_sampling_count_traces_sampled` with
// `policy` and `sampled` labels. Prometheus may render a counter with or without
// a `_total` suffix depending on the collector version, and the text format
// allows an optional trailing integer-ms timestamp after the value — tolerate
// all three so a format variation never silently drops a decision count.
const METRIC_LINE =
  /^otelcol_processor_tail_sampling_count_traces_sampled(?:_total)?\{([^}]*)\}\s+([0-9.eE+-]+)(?:\s+\d+)?\s*$/;
// A single `key="value"` label pair (value may contain escaped quotes).
const LABEL_PAIR = /(\w+)="((?:[^"\\]|\\.)*)"/g;
// Unescape a backslash-escaped character in a label value.
const LABEL_ESCAPE = /\\(.)/g;

function parseLabels(labelBlock: string): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const match of labelBlock.matchAll(LABEL_PAIR)) {
    const key = match[1];
    const value = match[2];
    if (key !== undefined && value !== undefined) {
      labels[key] = value.replace(LABEL_ESCAPE, "$1");
    }
  }
  return labels;
}

/**
 * Parse Prometheus text exposition into per-policy decision counts. Lines that
 * are not the tail-sampling decision counter are ignored.
 */
export function parseDecisionMetrics(prometheusText: string): DecisionMetrics {
  const byPolicy = new Map<
    string,
    { sampledTrue: number; sampledFalse: number }
  >();

  for (const rawLine of prometheusText.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const match = METRIC_LINE.exec(line);
    if (!match) {
      continue;
    }
    const labels = parseLabels(match[1] ?? "");
    const policy = labels.policy;
    const sampled = labels.sampled;
    const value = Number(match[2]);
    if (
      policy === undefined ||
      sampled === undefined ||
      !Number.isFinite(value)
    ) {
      continue;
    }
    const entry = byPolicy.get(policy) ?? { sampledTrue: 0, sampledFalse: 0 };
    if (sampled === "true") {
      entry.sampledTrue += Math.round(value);
    } else if (sampled === "false") {
      entry.sampledFalse += Math.round(value);
    }
    byPolicy.set(policy, entry);
  }

  return byPolicy;
}

/**
 * Count retained spans per scenario from the otelcol `file` exporter output
 * (newline-delimited OTLP/JSON `ExportTraceServiceRequest` objects). Malformed
 * lines are skipped defensively.
 */
export function parseExportedScenarioCounts(
  fileContent: string
): ReadonlyMap<Scenario, number> {
  const counts = new Map<Scenario, number>();

  const bump = (scenario: string): void => {
    counts.set(
      scenario as Scenario,
      (counts.get(scenario as Scenario) ?? 0) + 1
    );
  };

  for (const rawLine of fileContent.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    for (const span of iterateSpans(parsed)) {
      const scenario = scenarioOf(span);
      if (scenario !== undefined) {
        bump(scenario);
      }
    }
  }

  return counts;
}

function* iterateSpans(payload: unknown): Generator<Record<string, unknown>> {
  const resourceSpans = asArray(get(payload, "resourceSpans"));
  for (const rs of resourceSpans) {
    for (const ss of asArray(get(rs, "scopeSpans"))) {
      for (const span of asArray(get(ss, "spans"))) {
        if (span && typeof span === "object") {
          yield span as Record<string, unknown>;
        }
      }
    }
  }
}

function scenarioOf(span: Record<string, unknown>): string | undefined {
  for (const attr of asArray(span.attributes)) {
    if (get(attr, "key") === SCENARIO_ATTRIBUTE_KEY) {
      const value = get(attr, "value");
      const stringValue = get(value, "stringValue");
      if (typeof stringValue === "string") {
        return stringValue;
      }
    }
  }
  return undefined;
}

function get(value: unknown, key: string): unknown {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// --- Leg evaluation ---------------------------------------------------------

export type LegResult = {
  readonly scenario: Scenario;
  readonly policyName: string;
  readonly sent: number;
  readonly retainedInFile: number;
  readonly decisionSampledTrue: number;
  readonly pass: boolean;
  readonly detail: string;
};

export type VerificationEvaluation = {
  readonly legs: readonly LegResult[];
  readonly pass: boolean;
};

export type EvaluateInput = {
  readonly manifest: readonly ScenarioManifestEntry[];
  readonly metrics: DecisionMetrics;
  readonly fileRetention: ReadonlyMap<Scenario, number>;
  /**
   * Total traces sent across all scenarios — the baseline probabilistic policy
   * evaluates every trace, so its decision count is measured against this.
   */
  readonly totalSent: number;
};

/**
 * The baseline leg must prove the probabilistic policy retains a strict subset:
 * not a no-op (≈100%) and not zero. With a large baseline cohort the realized
 * rate sits near the configured percentage; we assert a wide, non-flaky band and
 * surface the exact rate rather than asserting tight equality.
 */
const BASELINE_MAX_RETAINED_FRACTION = 0.5;

export function evaluateLegs(input: EvaluateInput): VerificationEvaluation {
  const legs = input.manifest.map((entry) => evaluateLeg(entry, input));
  return { legs, pass: legs.every((leg) => leg.pass) };
}

type LegBase = Pick<
  LegResult,
  "scenario" | "policyName" | "sent" | "retainedInFile" | "decisionSampledTrue"
>;

const okOr = (ok: boolean, bad: string): string => (ok ? "ok" : bad);

function evaluateLeg(
  entry: ScenarioManifestEntry,
  input: EvaluateInput
): LegResult {
  const base: LegBase = {
    scenario: entry.scenario,
    policyName: entry.policyName,
    sent: entry.sent,
    retainedInFile: input.fileRetention.get(entry.scenario) ?? 0,
    decisionSampledTrue: input.metrics.get(entry.policyName)?.sampledTrue ?? 0,
  };

  return entry.expectation.kind === "always"
    ? evaluateAlwaysLeg(base)
    : evaluateBaselineLeg(
        base,
        entry.expectation.samplingPercentage,
        input.totalSent
      );
}

/** A keep-policy leg: every sent trace must be retained (file) and voted (metric). */
function evaluateAlwaysLeg(base: LegBase): LegResult {
  const fileOk = base.retainedInFile === base.sent;
  const metricOk = base.decisionSampledTrue === base.sent;
  const pass = fileOk && metricOk;
  const detail = pass
    ? `retained ${base.retainedInFile}/${base.sent} (100%); ${base.policyName} sampled=true ×${base.decisionSampledTrue}`
    : `expected 100% retention via ${base.policyName}: file ${base.retainedInFile}/${base.sent} (${okOr(fileOk, "MISMATCH")}), decision sampled=true ${base.decisionSampledTrue}/${base.sent} (${okOr(metricOk, "MISMATCH")})`;
  return { ...base, pass, detail };
}

/**
 * The baseline (probabilistic) leg: the policy must retain a strict subset —
 * neither none nor all — in both the file output and the decision metric.
 */
function evaluateBaselineLeg(
  base: LegBase,
  samplingPercentage: number,
  totalSent: number
): LegResult {
  const fileFraction = base.sent === 0 ? 0 : base.retainedInFile / base.sent;
  const fileOk =
    base.sent > 0 &&
    base.retainedInFile > 0 &&
    fileFraction < BASELINE_MAX_RETAINED_FRACTION;
  const metricOk =
    base.decisionSampledTrue > 0 && base.decisionSampledTrue < totalSent;
  const pass = fileOk && metricOk;
  const pct = (fileFraction * 100).toFixed(1);
  const detail = pass
    ? `sampled ${base.retainedInFile}/${base.sent} (${pct}%; target ${samplingPercentage}%); ${base.policyName} sampled=true ×${base.decisionSampledTrue}/${totalSent} traces`
    : `expected a strict sampled subset (target ${samplingPercentage}%): file ${base.retainedInFile}/${base.sent} (${pct}%, ${okOr(fileOk, "OUT OF BAND")}), decision sampled=true ${base.decisionSampledTrue}/${totalSent} (${okOr(metricOk, "OUT OF BAND")})`;
  return { ...base, pass, detail };
}
