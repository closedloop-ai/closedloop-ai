/**
 * ISS-10718 — the per-invocation telemetry projection of the invocation READ
 * contract.
 *
 * THE NUMBERS ALREADY EXIST AND NEVER REACHED A READER. `model`, the four token
 * counts, `estimatedCost`, `footprintTokens` and `usageMeasurement` are real
 * columns on the cloud row and ride the sync item; the read row stopped at
 * `branchName`. This module is what carries them the last hop, plus `succeeded`
 * (FEA-4093), which had no cloud twin at all until this change.
 *
 * AN ABSENT VALUE IS UNKNOWN, NEVER ZERO. Every field is omitted when absent
 * rather than defaulted, and `estimatedCost` is the one that matters most: a
 * confident `$0` for a cost nobody computed is exactly the defect this family
 * exists to prevent. A consumer that wants a number must handle the absence.
 *
 * `usageMeasurement` TRAVELS WITH THE COUNTS OR THE COUNTS DO NOT TRAVEL. A
 * count bracketed around this invocation and a session-average share derived for
 * it are not the same measurement, and a reader who cannot tell them apart will
 * compare them. So {@link agentComponentInvocationTelemetryFields} publishes the
 * subagent-turn counts only alongside a label it can read, and drops them
 * otherwise — the same degradation the desktop producer already applies on the
 * write side, for the same reason: unlabelled telemetry is worse than none.
 *
 * BOTH GATES ARE ALSO KIND GATES (@tamsinb, @whitlockk review). The labelled usage
 * rides only a kind something measures ({@link USAGE_BEARING_INVOCATION_KINDS})
 * and `succeeded` only a kind something adjudicates
 * ({@link SUCCESS_BEARING_INVOCATION_KINDS}) — the same populations the ingest
 * boundary and the Desktop wire projection enforce, read here from the same two
 * sets so a row cannot be corruption on the write side and a published number
 * on the read side.
 *
 * `footprintTokens` IS OUTSIDE THAT GATE, deliberately. It is the kind-agnostic
 * context-footprint metric, computed for every kind and not part of the turn's
 * billed usage, so it is neither described by `usageMeasurement` nor withheld
 * with the counts it does describe.
 *
 * THE TWO POPULATIONS ARE NOT ADDITIVE. The turn's own usage and the component's
 * context footprint count different things — the docstring on
 * `AgentComponentInvocationSyncItem` states why — so this module publishes both
 * and folds neither into a total.
 *
 * NO DOLLARS PER FINDING (PRD-753 R3). `estimatedCost` lands on the same row as
 * ISS-10727's finding counts and nothing here divides one by the other.
 */

import {
  AgentComponentInvocationUsageMeasurement,
  isAgentComponentInvocationKindIn,
  SUCCESS_BEARING_INVOCATION_KINDS,
  USAGE_BEARING_INVOCATION_KINDS,
} from "./agent-component-invocation.ts";

/** The telemetry projection of the invocation read row, and the whole of it. */
export type AgentComponentInvocationTelemetryReadFields = {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  estimatedCost?: number;
  footprintTokens?: number;
  usageMeasurement?: AgentComponentInvocationUsageMeasurement;
  succeeded?: boolean;
};

/**
 * The keys this projection adds, as a value, keyed by `keyof` so a field added
 * to the type without being declared here fails `tsc`.
 */
export const AGENT_COMPONENT_INVOCATION_TELEMETRY_READ_KEYS = [
  "model",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "estimatedCost",
  "footprintTokens",
  "usageMeasurement",
  "succeeded",
] as const satisfies readonly (keyof AgentComponentInvocationTelemetryReadFields)[];

/**
 * The turn's own billed usage — the population `usageMeasurement` describes.
 * `footprintTokens` and `succeeded` are deliberately absent.
 */
const LABELLED_TELEMETRY_KEYS = [
  "model",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "estimatedCost",
] as const satisfies readonly (keyof AgentComponentInvocationTelemetryReadFields)[];

/**
 * What a read path hands this module: the stored columns, each `null` when the
 * column holds no value. A read path passes what it has; this module decides
 * what may be published.
 */
export type AgentComponentInvocationTelemetrySource = {
  /**
   * The row's component kind. Both gates below are kind gates, and a source
   * that cannot state its kind gets neither the labelled usage nor `succeeded`
   * — omission, never a value nothing measured.
   */
  kind?: string | null;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  estimatedCost?: number | null;
  footprintTokens?: number | null;
  usageMeasurement?: string | null;
  succeeded?: boolean | null;
};

/** Project stored telemetry onto the read row, omitting everything absent. */
export function agentComponentInvocationTelemetryFields(
  source: AgentComponentInvocationTelemetrySource
): AgentComponentInvocationTelemetryReadFields {
  // ISS-10718 (@tamsinb, @whitlockk review): the SAME kind gates the write side
  // already applies, applied once here so the two read surfaces cannot decide
  // it differently. The desktop store can hold a usage value on a kind nothing
  // measures — `storedSubagentUsage` drops it as corruption and the cloud
  // ingest refuses it — so a local read without this gate publishes a token
  // count the web will never have for the same row.
  const usageBearing = isAgentComponentInvocationKindIn(
    USAGE_BEARING_INVOCATION_KINDS,
    source.kind
  );
  const successBearing = isAgentComponentInvocationKindIn(
    SUCCESS_BEARING_INVOCATION_KINDS,
    source.kind
  );
  const usageMeasurement = knownUsageMeasurement(source.usageMeasurement);
  const labelled: AgentComponentInvocationTelemetryReadFields = {
    ...(typeof source.model === "string" && source.model.length > 0
      ? { model: source.model }
      : {}),
    ...telemetryCount("inputTokens", source.inputTokens),
    ...telemetryCount("outputTokens", source.outputTokens),
    ...telemetryCount("cacheReadTokens", source.cacheReadTokens),
    ...telemetryCount("cacheWriteTokens", source.cacheWriteTokens),
    ...telemetryCost(source.estimatedCost),
  };
  // A stored label this build cannot read takes the counts it describes with
  // it. Publishing them unlabelled would put a measured count and a derived
  // share in one undifferentiated column, which is the one outcome
  // `usageMeasurement` exists to prevent.
  const publishLabelled =
    usageBearing &&
    hasAnyTelemetryKey(labelled) &&
    (source.usageMeasurement === undefined ||
      source.usageMeasurement === null ||
      usageMeasurement !== undefined);
  return {
    ...(publishLabelled ? labelled : {}),
    ...(publishLabelled && usageMeasurement !== undefined
      ? { usageMeasurement }
      : {}),
    ...telemetryCount("footprintTokens", source.footprintTokens),
    ...(successBearing && typeof source.succeeded === "boolean"
      ? { succeeded: source.succeeded }
      : {}),
  };
}

function hasAnyTelemetryKey(
  fields: AgentComponentInvocationTelemetryReadFields
): boolean {
  return LABELLED_TELEMETRY_KEYS.some((key) => fields[key] !== undefined);
}

/**
 * A token count this contract will publish. The impossible set is wider than
 * "negative": a fractional count and one past the safe-integer range both render
 * as confident real measurements.
 */
function telemetryCount(
  key:
    | "inputTokens"
    | "outputTokens"
    | "cacheReadTokens"
    | "cacheWriteTokens"
    | "footprintTokens",
  value: number | null | undefined
): AgentComponentInvocationTelemetryReadFields {
  if (
    value === null ||
    value === undefined ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return {};
  }
  return { [key]: value };
}

function telemetryCost(
  value: number | null | undefined
): AgentComponentInvocationTelemetryReadFields {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(value) ||
    value < 0
  ) {
    return {};
  }
  return { estimatedCost: value };
}

/**
 * The stored label, admitted only when this build's vocabulary knows it. A value
 * written by a newer peer is not forwarded raw — a reader would have no way to
 * interpret it, and a label it cannot interpret is not a label.
 */
function knownUsageMeasurement(
  value: string | null | undefined
): AgentComponentInvocationUsageMeasurement | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  // The vocabulary is read from its canonical const object rather than
  // re-listed here; a second copy is how the read side would come to admit a
  // label the write side had retired.
  return Object.values(AgentComponentInvocationUsageMeasurement).find(
    (measurement) => measurement === value
  );
}
