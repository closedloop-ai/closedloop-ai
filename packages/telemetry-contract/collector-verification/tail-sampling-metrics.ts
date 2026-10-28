import type { Scenario, ScenarioManifestEntry } from "./synthetic-otlp";
import {
  SCENARIO_ATTRIBUTE_KEY,
  Scenario as ScenarioValue,
} from "./synthetic-otlp";

/**
 * Parsing + leg evaluation for the tail-sampling mechanical verification
 * (FEA-2182). The runner owns the process lifecycle; everything here is a pure
 * function of strings — or, for `settleExportedScenarioCounts`, of an injected
 * reader and wait — so the decision logic is fully unit-tested without Docker.
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
  return parseExport(fileContent).counts;
}

/**
 * The same parse, plus the count of lines that were not valid JSON. A line the
 * exporter is midway through writing is unparseable and NORMAL — the settle
 * absorbs it by re-reading — so the count is only meaningful once the counts
 * have settled, where it separates a corrupt record from a missing one.
 */
function parseExport(fileContent: string): ParsedExport {
  const traceSpansByScenario = new Map<Scenario, Map<string, Set<string>>>();
  let malformedLines = 0;

  const add = (scenario: string, traceId: string, spanName: string): void => {
    const key = scenario as Scenario;
    const traceSpans = traceSpansByScenario.get(key) ?? new Map();
    const spanNames = traceSpans.get(traceId) ?? new Set<string>();
    spanNames.add(spanName);
    traceSpans.set(traceId, spanNames);
    traceSpansByScenario.set(key, traceSpans);
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
      malformedLines += 1;
      continue;
    }
    for (const span of iterateSpans(parsed)) {
      const scenario = scenarioOf(span);
      const traceId = span.traceId;
      const spanName = span.name;
      if (
        scenario !== undefined &&
        typeof traceId === "string" &&
        typeof spanName === "string"
      ) {
        add(scenario, traceId, spanName);
      }
    }
  }

  const counts = new Map<Scenario, number>();
  for (const [scenario, traceSpans] of traceSpansByScenario) {
    counts.set(scenario, countCompleteRetainedTraces(scenario, traceSpans));
  }
  return { counts, malformedLines };
}

function countCompleteRetainedTraces(
  scenario: Scenario,
  traceSpans: ReadonlyMap<string, ReadonlySet<string>>
): number {
  let count = 0;
  for (const spanNames of traceSpans.values()) {
    if (isCompleteRetainedTrace(scenario, spanNames)) {
      count += 1;
    }
  }
  return count;
}

/**
 * A Slow trace is the two-span desktop shape — an `ipc.list` child exported at
 * T0 and the `cl-desktop` root exported when it closes — so counting distinct
 * trace ids would score a trace whose root missed the vote as retained. That is
 * precisely the delivery-order failure `slowTraceLatencyThresholdMs <
 * decisionWaitSeconds` exists to prevent, so the slow leg counts only traces
 * that arrived WHOLE. Every other scenario is one span per trace.
 */
function isCompleteRetainedTrace(
  scenario: Scenario,
  spanNames: ReadonlySet<string>
): boolean {
  return (
    scenario !== ScenarioValue.Slow ||
    (spanNames.size === 2 &&
      spanNames.has("ipc.list") &&
      spanNames.has("cl-desktop"))
  );
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

// --- Export-file settle -----------------------------------------------------

export type ExportFileSettle = {
  /** Re-read the whole export file. */
  readonly readExportFile: () => string;
  /** Wait between reads; injected so callers, and tests, own the clock. */
  readonly wait: () => Promise<void>;
  /** Consecutive unchanged reads required before the counts are accepted. */
  readonly stableReads: number;
  /** Hard bound on reads, so an exporter that never goes quiet cannot hang. */
  readonly maxReads: number;
};

function sameCounts(
  a: ReadonlyMap<Scenario, number>,
  b: ReadonlyMap<Scenario, number>
): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const [scenario, count] of a) {
    if (b.get(scenario) !== count) {
      return false;
    }
  }
  return true;
}

/**
 * Read the export file until its whole-trace counts stop growing.
 *
 * The tail-sampling decision metric increments before the file exporter's
 * buffered write reaches disk, so a read taken the instant the vote lands can
 * clip a span that is still in the exporter's buffer and score a whole trace as
 * partial (ISS-9913). Waiting for the counts to hold still removes that
 * ambiguity WITHOUT hiding a genuine partial export, because the two settle
 * differently: a clipped read converges upward as the buffer drains, while a
 * trace whose root never reached the collector never appears at all, so its
 * count settles short and `isCompleteRetainedTrace` still fails the leg.
 *
 * Exhausting `maxReads` while the counts are still moving throws rather than
 * returning the last snapshot. That snapshot is a read the exporter has already
 * contradicted, so scoring it would reintroduce the exact ambiguity this
 * function exists to remove — a still-draining buffer would print the same
 * `file N/M MISMATCH` a genuine delivery-order failure prints, and the record's
 * claim that a short count means the trace never arrived would stop being true.
 * The run is inconclusive at that point, not failing. A settled read that still
 * contains an unparseable line is refused the same way, and for the same
 * reason: a skipped corrupt record scores its trace as missing.
 */
export async function settleExportedScenarioCounts(
  settle: ExportFileSettle
): Promise<ReadonlyMap<Scenario, number>> {
  let parsed = parseExport(settle.readExportFile());
  let unchanged = 0;
  for (let read = 1; read < settle.maxReads; read += 1) {
    await settle.wait();
    const next = parseExport(settle.readExportFile());
    unchanged = sameCounts(parsed.counts, next.counts) ? unchanged + 1 : 0;
    parsed = next;
    if (unchanged >= settle.stableReads) {
      assertParsedCleanly(parsed);
      return parsed.counts;
    }
  }
  throw new InconclusiveVerificationError(
    `export file never settled: whole-trace counts were still changing after ${settle.maxReads} reads (last read ${renderCounts(parsed.counts)}). The verification is INCONCLUSIVE — the exporter is still draining, so this is not a tail-sampling policy failure.`
  );
}

/**
 * A line that is still unparseable once the counts have settled is a corrupt
 * export record, not a partial write. Skipping it would score its trace as
 * missing, which reads identically to a trace that never reached the collector
 * — the same conflation the settle exists to remove, and it would falsify the
 * generated record's claim about what a short count means.
 */
function assertParsedCleanly(parsed: ParsedExport): void {
  if (parsed.malformedLines > 0) {
    throw new InconclusiveVerificationError(
      `export file settled with ${parsed.malformedLines} unparseable line(s) (counts ${renderCounts(parsed.counts)}). The verification is INCONCLUSIVE — a corrupt record's trace cannot be told from one that never arrived, so no leg verdict is claimed.`
    );
  }
}

/**
 * Raised when the export file could not serve as ground truth — its counts were
 * still moving at the read cap, or the settled read did not parse cleanly.
 * Distinct from a failing leg: nothing was measured, so no policy verdict is
 * claimed and no verification record is generated.
 */
export class InconclusiveVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InconclusiveVerificationError";
  }
}

type ParsedExport = {
  readonly counts: ReadonlyMap<Scenario, number>;
  readonly malformedLines: number;
};

function renderCounts(counts: ReadonlyMap<Scenario, number>): string {
  return [...counts]
    .map(([scenario, count]) => `${scenario}=${count}`)
    .join(", ");
}
