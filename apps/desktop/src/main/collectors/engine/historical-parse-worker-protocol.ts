import type { NormalizedParseQuality } from "@repo/lib/harness/parse-quality";
import { z } from "zod";
import { safeStorageTokenCountSchema } from "../../cost/token-counts.js";
import {
  type ParsePolicy,
  parsePolicySchema,
} from "../../parse-policy/parse-policy.js";
import type {
  OpencodeWithheldSubagentReport,
  OpencodeWithheldSubagentRoot,
} from "../opencode/opencode-withheld-subagents.js";
import {
  deriveEndedOnUnrecoveredError,
  type Harness,
  HarnessValues,
  type NormalizedSession,
} from "../types.js";
import type { HistoricalParseResult } from "./historical-parse-source.js";
import {
  boundedDiagnosticText,
  summarizeHistoricalWorkerResponseIssues,
} from "./historical-parse-worker-diagnostics.js";
import { HistoricalParseWorkerLimits } from "./historical-parse-worker-limits-and-clamping.js";
import {
  type ClampedWorkerSessions,
  clampSessionsForWorkerResponse,
  summarizeWorkerResponsePayload,
} from "./historical-parse-worker-response-budget.js";
import {
  assertWorkerSchemaKeysCovered,
  normalizedSessionSchema,
  nullableShortTextSchema,
  parseQualitySchema,
} from "./historical-parse-worker-session-schema.js";

const MAX_WORKER_SESSIONS_PER_SOURCE =
  HistoricalParseWorkerLimits.maxWorkerSessionsPerSource;
const MAX_SESSION_ARRAY_ITEMS =
  HistoricalParseWorkerLimits.maxSessionArrayItems;
const MAX_SHORT_TEXT_LENGTH = HistoricalParseWorkerLimits.maxShortTextLength;
const MAX_LONG_TEXT_LENGTH = HistoricalParseWorkerLimits.maxLongTextLength;
const WORKER_INVALID_RESPONSE_MESSAGE_PREFIX =
  "historical parse worker sent an invalid response";
const workerMessageRequestIdSchema = z
  .object({
    requestId: z.string().min(1),
  })
  .passthrough();

/**
 * ISS-7696: where a budget-truncated parse must pick up.
 *
 * Two members, inseparable on purpose. `sessionIndex` is what the worker would
 * slice at, and a bare index is only meaningful against the exact list it was
 * taken from — a store that gained or lost a session between passes shifts every
 * index after the change, and slicing on a stale one SKIPS sessions that were
 * never delivered. `sessionId` names the session at `sessionIndex - 1`, so the
 * worker can check the token still describes the parse in front of it and start
 * from the beginning when it does not (see
 * {@link resolveHistoricalParseResumeOffset}). Re-delivering a session is
 * harmless — the import path upserts on session id — whereas skipping one is the
 * silent loss this whole mechanism exists to end.
 *
 * `.positive()` rather than `.nonnegative()`: a resume necessarily follows at
 * least one delivered session, so a 0 is a producer that counted the delivered
 * sessions wrong, and honouring it would re-deliver or skip at the boundary.
 */
export const historicalParseWorkerResumePointSchema = z
  .object({
    sessionIndex: z.number().int().positive(),
    sessionId: z
      .string()
      .min(1)
      .max(HistoricalParseWorkerLimits.maxShortTextLength),
  })
  .strict();

export type HistoricalParseWorkerResumePoint = z.infer<
  typeof historicalParseWorkerResumePointSchema
>;

export const HistoricalParseWorkerRequestType = {
  ParseSource: "parseSource",
} as const;

export type HistoricalParseWorkerRequestType =
  (typeof HistoricalParseWorkerRequestType)[keyof typeof HistoricalParseWorkerRequestType];

/** Worker request envelope for one bounded parser job. */
export const historicalParseWorkerRequestSchema = z.object({
  type: z.literal(HistoricalParseWorkerRequestType.ParseSource),
  requestId: z.string().min(1),
  collectorKey: z.enum(HarnessValues),
  source: z.string().min(1),
  // ISS-7696: additive and optional, and this stays a PLAIN `z.object` — never
  // `.strict()` — so a worker build that predates the field STRIPS it and parses
  // the source from the beginning, which is exactly the pre-ISS-7696 behaviour.
  // A strict boundary here would instead reject the whole request as
  // `invalid historical parse request` and drop the source permanently.
  resumeAfter: historicalParseWorkerResumePointSchema.optional(),
  // ISS-12552 (PRD-800 "Rollout"): the policy to parse under, as data.
  // Additive and optional for the same reason as `resumeAfter`: a worker that
  // predates it strips it and parses as before PRD-800, and a request without
  // it parses under the base policy.
  parsePolicy: parsePolicySchema.optional(),
} satisfies Record<keyof HistoricalParseWorkerRequestFields, z.ZodTypeAny>);

export type HistoricalParseWorkerRequest = z.infer<
  typeof historicalParseWorkerRequestSchema
>;

/**
 * How many sessions of THIS parse the requester already holds.
 *
 * Returns 0 — parse the source from the beginning — whenever the token does not
 * describe the list in front of us.
 *
 * This is DEFENCE IN DEPTH, not the guarantee. It reads the BOUNDARY session
 * only, and a boundary is blind to a change earlier in the prefix: after
 * delivering `[A, B]`, a store that has become `[X, B, …]` still presents `B` at
 * the index the token names, so this check passes and the caller resumes past an
 * `X` that was never delivered (codex review). A prefix row edited in place is
 * the same blind spot.
 *
 * What actually makes a resume skip-safe is the CALLER binding the token to the
 * store fingerprint it was earned against and dropping it when that moves — see
 * `resumeAfterForSource` in `opencode-collector.ts`. Keep this check anyway: it
 * costs one comparison and it still catches a producer that miscounted, which no
 * fingerprint can.
 */
export function resolveHistoricalParseResumeOffset(
  sessions: readonly NormalizedSession[],
  resumeAfter: HistoricalParseWorkerResumePoint | undefined
): number {
  if (!resumeAfter) {
    return 0;
  }
  const lastDelivered = sessions[resumeAfter.sessionIndex - 1];
  return lastDelivered?.sessionId === resumeAfter.sessionId
    ? resumeAfter.sessionIndex
    : 0;
}

/**
 * The request's field set, stated independently of the schema above.
 *
 * `z.infer` would make a keys-covered guard tautological, so this type is the
 * other half of the pair: the `satisfies` on the shape literal checks BOTH
 * directions against it — a field added here and left untaught to the schema
 * fails `tsc`, and so does a schema key with no field. Without it a new wire
 * field reaches the worker as an unmodelled key that this plain `z.object`
 * silently STRIPS, which is the quiet half of the FEA-3701 failure mode and
 * exactly how a continuation would go missing.
 */
type HistoricalParseWorkerRequestFields = {
  type: HistoricalParseWorkerRequestType;
  requestId: string;
  collectorKey: Harness;
  source: string;
  resumeAfter?: HistoricalParseWorkerResumePoint;
  parsePolicy?: ParsePolicy;
};

export const HistoricalParseWorkerResponseType = {
  Parsed: "parsed",
  Failed: "failed",
} as const;

export type HistoricalParseWorkerResponseType =
  (typeof HistoricalParseWorkerResponseType)[keyof typeof HistoricalParseWorkerResponseType];

export type HistoricalParseWorkerResponse = z.infer<
  typeof historicalParseWorkerResponseSchema
>;

export type HistoricalParseWorkerFailureKind =
  | "parser_output_validation"
  | "worker_failure";

/**
 * Error raised by the main-process runner for schema-valid worker failures.
 * Rebuild code uses the kind to separate parser-output validation failures
 * from benign read/source errors that should simply retry next launch.
 */
export class HistoricalParseWorkerFailureError extends Error {
  readonly kind: HistoricalParseWorkerFailureKind;
  readonly diagnostic?: string;

  constructor(
    message: string,
    kind: HistoricalParseWorkerFailureKind,
    diagnostic?: string
  ) {
    super(message);
    this.name = "HistoricalParseWorkerFailureError";
    this.kind = kind;
    this.diagnostic = diagnostic;
  }
}

/**
 * ISS-5266 (whitlockk review): the WITHHELD-subagent side-report, on the wire.
 *
 * The OpenCode collector produces this as a SIDE EFFECT of `parse`, and in the
 * in-process path it reaches the store through the collector's injected
 * `recordWithheld` sink. A historical/boot parse runs in the utility process
 * instead, where the collector is a DIFFERENT instance with no DB handle and no
 * sink — so without a wire field the report is simply discarded and the store's
 * withheld table stays empty for every source imported the normal way.
 *
 * Modelled OPTIONALLY and additively, per the repo's cross-version contract: a
 * worker build that does not send it (and every non-OpenCode parse, which never
 * has one) parses exactly as before, and the field is OMITTED rather than sent
 * as `null` when there is nothing to report.
 */
const withheldSubagentRootSchema = z
  .object({
    rootRawId: z.string().max(MAX_SHORT_TEXT_LENGTH),
    withheldCount: z.number().int().nonnegative(),
    reason: z.string().max(MAX_SHORT_TEXT_LENGTH),
    withheldTokens: safeStorageTokenCountSchema.nullable(),
    withheldCacheTokens: safeStorageTokenCountSchema.nullable(),
    earliestChildStartedAt: nullableShortTextSchema,
    latestChildEndedAt: nullableShortTextSchema,
    windowPartial: z.boolean(),
  })
  .strict();
assertWorkerSchemaKeysCovered<OpencodeWithheldSubagentRoot>(
  withheldSubagentRootSchema.shape
);

const withheldSubagentReportSchema = z
  .object({
    sourcePath: z.string().max(MAX_LONG_TEXT_LENGTH),
    roots: z.array(withheldSubagentRootSchema).max(MAX_SESSION_ARRAY_ITEMS),
  })
  .strict();
assertWorkerSchemaKeysCovered<OpencodeWithheldSubagentReport>(
  withheldSubagentReportSchema.shape
);

/**
 * The Parsed branch's object schema, extracted so `.shape` stays reachable for
 * {@link assertParsedResponseKeysCovered} below — `.superRefine()` returns a
 * `ZodEffects`, which has no `.shape`.
 */
const parsedResponseObjectSchema = z.object({
  type: z.literal(HistoricalParseWorkerResponseType.Parsed),
  requestId: z.string().min(1),
  sessions: z
    .array(normalizedSessionSchema)
    .max(MAX_WORKER_SESSIONS_PER_SOURCE),
  /**
   * ISS-5266: present only for an OpenCode parse that produced a report.
   * The Parsed branch is a PLAIN `z.object`, so an unmodelled key here would
   * be silently STRIPPED rather than rejected (see
   * {@link assertWorkerSchemaKeysCovered}) — the quiet half of the FEA-3701
   * failure mode, and precisely how this field would have gone missing.
   */
  withheldOpencodeSubagents: withheldSubagentReportSchema.optional(),
  /**
   * ISS-5854: how many parsed sessions the response budget dropped, so a
   * partial parse cannot present itself as the whole one. Optional and
   * OMITTED when nothing was dropped, so every response that fits — and
   * every pre-ISS-5854 worker payload — is unchanged on the wire. Same
   * PLAIN-`z.object` caveat as the field above: an unmodelled key is
   * silently stripped, which is exactly how this count would go missing.
   */
  droppedSessions: z.number().int().min(1).optional(),
  /**
   * ISS-7696: where the NEXT pass must resume, present exactly when this
   * response left sessions behind. Its absence beside a `droppedSessions` is
   * therefore meaningful rather than merely missing — it is a worker that
   * cannot continue, and the runner reads it as the permanent loss ISS-5854
   * reported instead of as a deferral. Same PLAIN-`z.object` caveat as the
   * two fields above: a main-process build that predates this field strips
   * it and falls back to that pre-ISS-7696 reading, which refuses the seal
   * exactly as it does today.
   */
  resumeAfter: historicalParseWorkerResumePointSchema.optional(),
  /**
   * ISS-7625: the parse quality of a source that yielded NO session for want of
   * a usable timestamp, so an all-malformed transcript reaches the main
   * process's ingest-failure sink instead of arriving as a healthy empty list.
   *
   * Reuses `parseQualitySchema` rather than restating the shape, so the
   * `.strict()` boundary and the `NormalizedParseQuality` key-coverage guard
   * that already police the per-session copy police this one too. Optional and
   * OMITTED when the parse was clean or produced a session, so every
   * pre-ISS-7625 worker payload validates unchanged.
   */
  unreadableParseQuality: parseQualitySchema.optional(),
});

/**
 * Compile-time key-coverage guard for the Parsed branch (ISS-7625).
 *
 * The branch is a PLAIN `z.object`, so an unmodelled key is silently STRIPPED
 * rather than rejected — the field is simply gone in the main process, with no
 * error, no rejection and no retry. That is strictly harder to notice than the
 * `.strict()` whole-payload rejection the nested schemas give, and it is exactly
 * how the withheld report and the dropped-session count would each have gone
 * missing. Guarding the shape against {@link HistoricalParseResult} — the type
 * the worker actually produces — makes the next field added to a parse result
 * fail `tsc` here instead of vanishing in production. Runtime no-op.
 */
type ParsedResponseEnvelopeKeys = "type" | "requestId";
function assertParsedResponseKeysCovered(
  _shape: Record<
    keyof HistoricalParseResult | ParsedResponseEnvelopeKeys,
    z.ZodTypeAny
  >
): void {
  /* type-level check only */
}
assertParsedResponseKeysCovered(parsedResponseObjectSchema.shape);

/** Worker response envelope. */
export const historicalParseWorkerResponseSchema = z.union([
  parsedResponseObjectSchema.superRefine((response, context) => {
    // ISS-7696 (whitlockk review): the field above documents `resumeAfter` as
    // present EXACTLY when the response left sessions behind, and until this
    // check that was only a comment. A payload carrying a continuation with no
    // `droppedSessions` reaches `applyParseSideReport` with
    // `truncatedByBudget` false, parks a cursor anyway, and then seals the
    // source in the same pass — a sealed store holding a live continuation
    // into a window it never admitted dropping. Reject it at the boundary
    // instead, where the whole payload is refused and the source is simply
    // re-parsed.
    //
    // ONE DIRECTION ONLY. `droppedSessions` WITHOUT `resumeAfter` stays valid
    // and meaningful: it is a worker that cannot continue, which the runner
    // reads as the permanent loss ISS-5854 reports.
    if (response.resumeAfter && response.droppedSessions === undefined) {
      context.addIssue({
        code: "custom",
        message:
          "resumeAfter is only meaningful beside droppedSessions: a response that left nothing behind has nothing to resume from",
        path: ["resumeAfter"],
      });
    }
    const summary = summarizeWorkerResponsePayload(response.sessions);
    if (
      summary.arrayItems >
      HistoricalParseWorkerLimits.maxWorkerResponseArrayItems
    ) {
      context.addIssue({
        code: z.ZodIssueCode.too_big,
        maximum: HistoricalParseWorkerLimits.maxWorkerResponseArrayItems,
        origin: "array",
        inclusive: true,
        message: "historical parse worker response has too many rows",
      });
    }
    if (
      summary.textBytes > HistoricalParseWorkerLimits.maxWorkerResponseTextBytes
    ) {
      context.addIssue({
        code: z.ZodIssueCode.too_big,
        maximum: HistoricalParseWorkerLimits.maxWorkerResponseTextBytes,
        origin: "string",
        inclusive: true,
        message: "historical parse worker response text payload is too large",
      });
    }
  }),
  z.object({
    type: z.literal(HistoricalParseWorkerResponseType.Failed),
    requestId: z.string().min(1),
    message: z.string().max(MAX_LONG_TEXT_LENGTH),
    fatal: z.literal(true).optional(),
    diagnostic: z.string().max(MAX_LONG_TEXT_LENGTH).optional(),
  }),
]);

/**
 * Build a schema-valid bounded failure envelope for one worker request. Parser
 * output validation failures are nonfatal by default so the parent rejects only
 * the affected request; pass `fatal: true` only for infrastructure-terminal
 * worker failures.
 */
export function createHistoricalParseWorkerFailedResponse(
  requestId: string,
  message: string,
  options?: {
    diagnostic?: string;
    fatal?: boolean;
  }
): HistoricalParseWorkerResponse {
  const safeRequestId = requestId.trim() || "unknown-request";
  const safeMessage = boundedDiagnosticText(message);
  const safeDiagnostic = options?.diagnostic
    ? boundedDiagnosticText(options.diagnostic)
    : undefined;
  const response = {
    type: HistoricalParseWorkerResponseType.Failed,
    requestId: safeRequestId,
    message: safeMessage || "historical parse worker failed",
  };
  const responseWithOptionalFields = {
    ...response,
    ...(options?.fatal ? { fatal: true as const } : {}),
    ...(safeDiagnostic ? { diagnostic: safeDiagnostic } : {}),
  };
  const parsed = historicalParseWorkerResponseSchema.safeParse(response);
  const parsedWithOptionalFields =
    historicalParseWorkerResponseSchema.safeParse(responseWithOptionalFields);
  if (parsedWithOptionalFields.success) {
    return parsedWithOptionalFields.data;
  }
  if (parsed.success) {
    return parsed.data;
  }
  const fallback = {
    type: HistoricalParseWorkerResponseType.Failed,
    requestId: safeRequestId,
    message: "historical parse worker failed",
  };
  return options?.fatal ? { ...fallback, fatal: true } : fallback;
}

/** True when a runner error represents malformed parser output. */
export function isHistoricalParseWorkerParserOutputError(
  error: unknown
): boolean {
  return (
    error instanceof HistoricalParseWorkerFailureError &&
    error.kind === "parser_output_validation"
  );
}

/** Classify a schema-valid worker failure response for runner callers. */
export function errorFromHistoricalParseWorkerFailure(
  response: Extract<
    HistoricalParseWorkerResponse,
    { type: typeof HistoricalParseWorkerResponseType.Failed }
  >
): HistoricalParseWorkerFailureError {
  return new HistoricalParseWorkerFailureError(
    response.message,
    response.message.startsWith(WORKER_INVALID_RESPONSE_MESSAGE_PREFIX)
      ? "parser_output_validation"
      : "worker_failure",
    response.diagnostic
  );
}

/** Extract a safe request id from an otherwise malformed worker payload. */
export function requestIdFromWorkerMessage(message: unknown): string | null {
  const parsedMessage = workerMessageRequestIdSchema.safeParse(message);
  return parsedMessage.success ? parsedMessage.data.requestId : null;
}
/**
 * Validate parser output before it leaves the utility process. Parsed sessions
 * are first clamped to the worker response budget; if malformed data still
 * fails the response schema, return a small nonfatal diagnostic instead of
 * sending an oversized or invalid structured clone into Electron's main process.
 */
export function createHistoricalParseWorkerParsedResponse(
  requestId: string,
  sessions: NormalizedSession[],
  // ISS-5266: the parse's side-report, when it produced one. Optional so every
  // existing caller and every non-OpenCode parse is unchanged, and OMITTED from
  // the envelope (never sent as `null`) when absent.
  withheldOpencodeSubagents?: OpencodeWithheldSubagentReport,
  /**
   * ISS-7696: how many of `sessions` the requester already holds, resolved from
   * the request's resume token against THIS parse (see
   * `resolveHistoricalParseResumeOffset`). Absent or 0 sends the parse from the
   * beginning, which is what every pre-ISS-7696 caller does.
   */
  resumeFromSessionIndex?: number,
  /**
   * ISS-7625: the parse quality of a source that produced NO session because it
   * carried no usable timestamp. Optional and OMITTED (never `null`) when the
   * parse was clean or yielded a session, so every pre-ISS-7625 caller and
   * every pre-ISS-7625 worker payload is unchanged on the wire.
   */
  unreadableParseQuality?: NormalizedParseQuality
): HistoricalParseWorkerResponse {
  const offset = Math.min(
    Math.max(0, Math.trunc(resumeFromSessionIndex ?? 0)),
    sessions.length
  );
  // FEA-4187: stamp the failed-run signal from the FULL parsed session BEFORE
  // the response array clamp, so a truncated trailing `apiErrors`/`messages`
  // tail can't erase it. The import path (write-core) reads this flag to
  // classify a run that ended on an unrecovered API error as ERROR rather than
  // COMPLETED. Preserve an explicit flag a parser already set (never downgrade
  // a known failure); otherwise derive it here.
  const signaledSessions = (
    offset === 0 ? sessions : sessions.slice(offset)
  ).map((session) => ({
    ...session,
    endedOnUnrecoveredError:
      session.endedOnUnrecoveredError === true ||
      deriveEndedOnUnrecoveredError(session),
  }));
  let clamped: ClampedWorkerSessions;
  try {
    clamped = clampSessionsForWorkerResponse(signaledSessions);
  } catch (error) {
    return createHistoricalParseWorkerFailedResponse(
      requestId,
      invalidResponseMessage(requestId),
      {
        diagnostic: error instanceof Error ? error.message : String(error),
      }
    );
  }

  // ISS-5854: the clamp drops whole sessions when no amount of value-level
  // shrinking gets the response under budget, and it also drops the tail beyond
  // `maxWorkerSessionsPerSource`. Both were silent — a subset arriving as if it
  // were the whole parse. One subtraction covers both causes, because the clamp
  // only ever removes from the tail of what it was handed.
  const droppedSessions = signaledSessions.length - clamped.sessions.length;
  const resumeAfter = resumePointFor(offset, clamped);
  const response = {
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId,
    sessions: clamped.sessions,
    ...(withheldOpencodeSubagents ? { withheldOpencodeSubagents } : {}),
    ...(droppedSessions > 0 ? { droppedSessions } : {}),
    ...(resumeAfter ? { resumeAfter } : {}),
    ...(unreadableParseQuality ? { unreadableParseQuality } : {}),
  };
  const parsedResponse =
    historicalParseWorkerResponseSchema.safeParse(response);
  if (parsedResponse.success) {
    return parsedResponse.data;
  }

  // The response envelope is a plain `z.union`, so a single failing session
  // collapses the whole error to a root-level `invalid_union` with no path (the
  // unhelpful `<root>:invalid_union` operators were seeing). Re-validate the
  // sessions array on its own to surface the offending field
  // (e.g. `sessions.0.name:too_big`); fall back to the envelope error only when
  // the sessions are individually valid — i.e. the failure was the response-wide
  // size budget in the Parsed branch's superRefine.
  const sessionsResult = z
    .object({ sessions: z.array(normalizedSessionSchema) })
    .safeParse({ sessions: clamped.sessions });
  const diagnostic = sessionsResult.success
    ? summarizeHistoricalWorkerResponseIssues(parsedResponse.error)
    : summarizeHistoricalWorkerResponseIssues(sessionsResult.error);

  return createHistoricalParseWorkerFailedResponse(
    requestId,
    invalidResponseMessage(requestId),
    {
      diagnostic,
    }
  );
}

/**
 * ISS-7696: re-base the clamp's window-relative resume point onto the whole
 * parse, and name the last session this response actually carries.
 *
 * The clamp counts from the start of the WINDOW it was handed; a resumed pass
 * handed it a suffix, so the absolute index is that count plus the offset. The
 * named session is the one at `sessionIndex - 1` of the full parse, which is the
 * last element of what we are about to send — that pairing is what lets the next
 * request be checked against the parse it resumes rather than trusted blind.
 *
 * Returns nothing when the clamp left nothing behind, and also when it somehow
 * carried nothing at all: a resume point that names no delivered session cannot
 * be verified on the way back in, and a token that cannot be verified is worse
 * than none.
 */
function resumePointFor(
  offset: number,
  clamped: ClampedWorkerSessions
): HistoricalParseWorkerResumePoint | undefined {
  const lastDelivered = clamped.sessions.at(-1);
  if (clamped.resumeFromIndex === undefined || !lastDelivered) {
    return undefined;
  }
  return {
    sessionIndex: offset + clamped.resumeFromIndex,
    sessionId: lastDelivered.sessionId,
  };
}

function invalidResponseMessage(requestId: string): string {
  return `${WORKER_INVALID_RESPONSE_MESSAGE_PREFIX} for ${requestId}`;
}
