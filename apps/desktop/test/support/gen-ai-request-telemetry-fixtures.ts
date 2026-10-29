/**
 * Shared fixtures for the GenAI request telemetry suites (ISS-11347, ISS-12120):
 * a token record stamped relative to the bind, a re-parse of a series, and a
 * telemetry instance bound to a capturing sink on a hand-driven clock.
 */
import type { NormalizedTokenRecord } from "../../src/main/collectors/types.js";
import type { DesktopGenAiRequestEventInput } from "../../src/main/telemetry/app-otel-runtime-gen-ai.js";
import { createGenAiRequestTelemetry } from "../../src/main/telemetry/gen-ai-request-telemetry.js";
import type { BillingMode } from "../../src/shared/billing-mode.js";

export const BOUND_AT_MS = Date.parse("2026-09-28T12:00:00.000Z");
export const PRICED_MODEL = "claude-sonnet-4-5";
/** Long before the bind, so a Codex rollout's leading window has closed. */
export const STARTED_AT = new Date(BOUND_AT_MS - 3_600_000).toISOString();

export function record(
  secondsAfterBind: number,
  overrides: Partial<NormalizedTokenRecord> = {}
): NormalizedTokenRecord {
  return {
    timestamp: new Date(BOUND_AT_MS + secondsAfterBind * 1000).toISOString(),
    model: PRICED_MODEL,
    input: 10,
    output: 20,
    cacheRead: 300,
    cacheWrite: 40,
    ...overrides,
  };
}

/** What a re-parse hands over: equal content, never the same objects. */
export function reparsed(
  series: readonly NormalizedTokenRecord[]
): NormalizedTokenRecord[] {
  return structuredClone([...series]);
}

type TelemetryOptions = NonNullable<
  Parameters<typeof createGenAiRequestTelemetry>[0]
>;

export function boundTelemetry(
  options: Omit<TelemetryOptions, "now" | "detectBillingMode"> & {
    billingMode?: BillingMode;
    detectBillingMode?: TelemetryOptions["detectBillingMode"];
  } = {}
) {
  const clock = { nowMs: BOUND_AT_MS };
  const emitted: DesktopGenAiRequestEventInput[] = [];
  const { billingMode = "api", detectBillingMode, ...rest } = options;
  const telemetry = createGenAiRequestTelemetry({
    now: () => clock.nowMs,
    detectBillingMode: detectBillingMode ?? (() => billingMode),
    ...rest,
  });
  telemetry.bindRuntime({
    emitGenAiRequestEvent: (input) => {
      emitted.push(input);
    },
  });
  return { clock, emitted, telemetry };
}

export function stampedAt(inputs: readonly DesktopGenAiRequestEventInput[]) {
  return inputs.map((input) => input.atUnixMs - BOUND_AT_MS);
}
