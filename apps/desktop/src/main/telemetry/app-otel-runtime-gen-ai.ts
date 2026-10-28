/**
 * @file app-otel-runtime-gen-ai.ts
 * @description ISS-11347: the span name and attribute builder for one completed
 * LLM request, kept beside `app-otel-runtime.ts` like its sibling builders. The
 * runtime keeps only the started-state guard, the emit, and the swallow.
 *
 * Operator ruling (Perrin Upcott, 2026-09-28, ISS-11347 under PRD-481): the
 * desktop sends per-LLM-request model, token and cost metadata to PostHog on
 * the keyless channel, always on, with no prompts, paths or content (PRD-481 §3).
 * Refined the same day on #8059: cost only for spend-ledger sessions, never
 * for subscription-billed ones.
 */
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import {
  GenAiOperationName,
  type GenAiTelemetry,
  GenAiTelemetrySchema,
} from "@closedloop-ai/telemetry-contract/gen-ai";
import { ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { normalizeAttributes } from "../../shared/renderer-otel-bridge-utils.js";

/** Instrumentation scope the GenAI request spans are emitted under. */
export const GEN_AI_TRACER_NAME = "closedloop-desktop-gen-ai";

/**
 * The span name. The operation alone rather than semconv's `{operation}
 * {model}`, so the model lives only in an attribute the collector's redaction
 * can strip without a desktop release.
 */
export const GEN_AI_REQUEST_SPAN_NAME = GenAiOperationName.Chat;

/** One completed LLM request, as the transcript recorded its usage. */
export type DesktopGenAiRequestEventInput = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /**
   * Omitted when the price is unknown (never defaulted to `0` for it) and for a
   * subscription-billed session (ISS-11347 ruling, #8059).
   */
  costUsd?: number;
  /**
   * The request's transcript stamp, which becomes the span's: Claude's is the
   * first line of the response, Codex's the `token_count` that closed it.
   */
  atUnixMs: number;
};

/**
 * A provider model id: one token, optionally namespaced (`openai/gpt-4o`,
 * `us.anthropic.claude-sonnet-4-5-v1:0`, `claude-3-5-sonnet-v2@20241022`). The
 * model is the only free-text value on this span and it comes out of an
 * untrusted transcript, so the contract's bounded-text rule is not enough. The
 * first pattern admits at most 128 characters, no whitespace and no leading
 * `/` `~` `.` or backslash; the second refuses `..`, `//`, a `scheme:/` or
 * drive `C:/`, a dot-directory, an email-shaped `@domain.tld`, a weights-file
 * extension, and an alphanumeric run longer than any real id segment (a key or
 * token). What still passes is anything shaped like an id: a relative path
 * without those marks, or words joined by `-`. Only an allow-list of known
 * models closes that, and it would drop every model newer than the list.
 */
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+/-]{0,127}$/;
const MODEL_ID_PATH_MARK_PATTERN =
  /\.\.|\/\/|:\/|\/\.|@[^/]*\.|\.(?:gguf|ggml|bin|safetensors|pt|pth|onnx|ckpt|h5)$|[A-Za-z0-9]{41}/i;

/**
 * The validated attributes for `input`. Throws on a value that is not a model
 * id, and the contract's `.strict()` parse throws on anything else out of
 * range. The request is then dropped whole rather than shipped with a field
 * removed: the bridge counts it as refused, and the runtime swallows the throw.
 */
export function buildGenAiRequestAttributes(
  input: DesktopGenAiRequestEventInput
): GenAiTelemetry {
  if (
    !MODEL_ID_PATTERN.test(input.model) ||
    MODEL_ID_PATH_MARK_PATTERN.test(input.model)
  ) {
    throw new Error("gen_ai.request.model is not a model id");
  }
  return GenAiTelemetrySchema.parse({
    [TelemetryAttribute.GenAiOperationName]: GenAiOperationName.Chat,
    [TelemetryAttribute.GenAiRequestModel]: input.model,
    [TelemetryAttribute.GenAiUsageInputTokens]: input.inputTokens,
    [TelemetryAttribute.GenAiUsageOutputTokens]: input.outputTokens,
    [TelemetryAttribute.GenAiUsageCacheReadInputTokens]:
      input.cacheReadInputTokens,
    [TelemetryAttribute.GenAiUsageCacheCreationInputTokens]:
      input.cacheCreationInputTokens,
    ...(input.costUsd === undefined
      ? {}
      : { [TelemetryAttribute.GenAiCostUsage]: input.costUsd }),
  });
}

/**
 * Emit `input` as a zero-length span at its own stamp. Its own trace, not a
 * child of the activity root: the request is harness work the desktop
 * observed, a shared root would fold unrelated sessions into one PostHog trace,
 * and refreshing that root's idle timer on every request would stretch the
 * window past `keep-slow`. Throws what {@link buildGenAiRequestAttributes}
 * throws.
 */
export function emitGenAiRequestSpan(
  input: DesktopGenAiRequestEventInput
): void {
  trace
    .getTracer(GEN_AI_TRACER_NAME)
    .startSpan(
      GEN_AI_REQUEST_SPAN_NAME,
      {
        startTime: input.atUnixMs,
        attributes: normalizeAttributes(buildGenAiRequestAttributes(input)),
      },
      ROOT_CONTEXT
    )
    .end(input.atUnixMs);
}
