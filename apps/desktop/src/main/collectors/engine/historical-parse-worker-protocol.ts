import { truncateUtf8 } from "@closedloop-ai/loops-api/observability";
import { z } from "zod";
import { safeStorageTokenCountSchema } from "../../token-counts.js";
import { HarnessValues, type NormalizedSession } from "../types.js";

export const HistoricalParseWorkerLimits = {
  maxWorkerSessionsPerSource: 50_000,
  // Per-array cap. Kept in line with the response-wide item budget below so a
  // single long session (tens of thousands of messages) is not rejected by a
  // limit far tighter than the real memory guard. The producer clamps to these
  // limits before sending (see clampSessionsForWorkerResponse), so the response
  // always validates and an oversized session degrades to truncated detail
  // arrays instead of killing the worker.
  maxSessionArrayItems: 50_000,
  maxWorkerResponseArrayItems: 50_000,
  maxWorkerResponseTextBytes: 8_000_000,
  maxUnknownDepth: 8,
  maxUnknownArrayItems: 1000,
  maxUnknownObjectKeys: 250,
  maxShortTextLength: 8192,
  maxLongTextLength: 2_000_000,
  maxWorkerStderrPreviewBytes: 512,
} as const;

const MAX_WORKER_SESSIONS_PER_SOURCE =
  HistoricalParseWorkerLimits.maxWorkerSessionsPerSource;
const MAX_SESSION_ARRAY_ITEMS =
  HistoricalParseWorkerLimits.maxSessionArrayItems;
const MAX_UNKNOWN_DEPTH = HistoricalParseWorkerLimits.maxUnknownDepth;
const MAX_UNKNOWN_ARRAY_ITEMS =
  HistoricalParseWorkerLimits.maxUnknownArrayItems;
const MAX_UNKNOWN_OBJECT_KEYS =
  HistoricalParseWorkerLimits.maxUnknownObjectKeys;
const MAX_SHORT_TEXT_LENGTH = HistoricalParseWorkerLimits.maxShortTextLength;
const MAX_LONG_TEXT_LENGTH = HistoricalParseWorkerLimits.maxLongTextLength;
const MAX_RESPONSE_ISSUE_COUNT = 5;
const MAX_RESPONSE_ISSUE_TEXT_LENGTH = 160;
const MAX_RESPONSE_ISSUE_UNION_DEPTH = 4;
const WORKER_INVALID_RESPONSE_MESSAGE_PREFIX =
  "historical parse worker sent an invalid response";
const MAX_WORKER_STDERR_PREVIEW_BYTES =
  HistoricalParseWorkerLimits.maxWorkerStderrPreviewBytes;
const TRUNCATED_STDERR_PREVIEW_SUFFIX = "...";
const REDACTED_PATH_SEGMENT = "[redacted-path]";
const REDACTED_SECRET_SEGMENT = "[redacted-secret]";
const REDACTED_TOKEN_SEGMENT = "[redacted-token]";
// biome-ignore lint/complexity/useRegexLiterals: Control characters are clearer via escaped raw text here.
const ANSI_ESCAPE_RE = new RegExp(
  String.raw`[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]`,
  "g"
);
// biome-ignore lint/complexity/useRegexLiterals: Control characters are clearer via escaped raw text here.
const CONTROL_CHARACTERS_RE = new RegExp(
  String.raw`[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]`,
  "g"
);
const LINE_BREAKS_RE = /\r\n?|\n/g;
const REPEATED_WHITESPACE_RE = /\s{2,}/g;
const FILE_URL_ABSOLUTE_PATH_RE =
  /\bfile:\/\/\/(?:[^\s"'`<>:]+\/)*([^\s"'`<>:]+)/g;
const POSIX_ABSOLUTE_PATH_RE =
  /(^|[\s"'`(=])\/(?:[^\s"'`<>:]+\/)*([^\s"'`<>:]+)(?=$|[\s"'`<>)]|:\d)/g;
const WINDOWS_ABSOLUTE_PATH_RE =
  /\b[A-Za-z]:\\(?:[^\s"'`<>:]+\\)*([^\s"'`<>:]+)/g;
const CREDENTIAL_URL_RE =
  /\bhttps:\/\/[^:\s/@]+:[^@\s/]+@([^/\s]+\/[^\s"'<>]+)/gi;
const AWS_ACCESS_KEY_RE = /\b(?:AKIA|ASIA|AROA)[A-Z0-9]{16}\b/g;
const BEARER_TOKEN_RE = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
const SK_KEY_RE = /\bsk-[A-Za-z0-9\-_]{8,}/gi;
const GITHUB_TOKEN_RE = /\b(?:ghp|gho|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/gi;
const SLACK_TOKEN_RE = /\bxox[abprs]-[A-Za-z0-9-]{8,}/gi;
const SECRET_ASSIGNMENT_RE =
  /\b([A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|AUTH|CREDENTIAL)[A-Z0-9_]*|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|token)\s*[:=]\s*["']?[^,\s"'`&]+/gi;
const NODE_SQLITE_EXPERIMENTAL_WARNING_RE =
  /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time$/;
const NODE_TRACE_WARNINGS_HINT_RE =
  /^\(Use `?Electron Helper --trace-warnings \.\.\.`? to show where the warning was created\)$/;
const nullableShortTextSchema = z
  .string()
  .max(MAX_SHORT_TEXT_LENGTH)
  .nullable();
const optionalNullableShortTextSchema = nullableShortTextSchema.optional();
const tokenCountsSchema = z.object({
  input: safeStorageTokenCountSchema,
  output: safeStorageTokenCountSchema,
  cacheRead: safeStorageTokenCountSchema,
  cacheWrite: safeStorageTokenCountSchema,
  // FEA-2085: fallback-attribution marker (see NormalizedTokenCounts).
  inferred: z.boolean().optional(),
});
const messageTokenCountsSchema = z.object({
  input: safeStorageTokenCountSchema,
  output: safeStorageTokenCountSchema,
  cacheRead: safeStorageTokenCountSchema.optional(),
  cacheWrite: safeStorageTokenCountSchema.optional(),
});
const boundedUnknownValueSchema = z.custom<unknown>((value) =>
  isBoundedUnknownValue(value, 0)
);
const workerMessageRequestIdSchema = z
  .object({
    requestId: z.string().min(1),
  })
  .passthrough();

const toolUseSchema = z
  .object({
    name: z.string().max(MAX_SHORT_TEXT_LENGTH),
    timestamp: nullableShortTextSchema,
    input: boundedUnknownValueSchema.optional(),
    output: boundedUnknownValueSchema.optional(),
    isError: z.boolean().optional(),
    mcpServer: z.string().max(MAX_SHORT_TEXT_LENGTH).optional(),
    mcpMethod: z.string().max(MAX_SHORT_TEXT_LENGTH).optional(),
    skillName: z.string().max(MAX_SHORT_TEXT_LENGTH).optional(),
    diffDelta: z
      .object({
        add: z.number(),
        del: z.number(),
      })
      .optional(),
    id: z.string().max(MAX_SHORT_TEXT_LENGTH).optional(),
    resultTimestamp: optionalNullableShortTextSchema,
    gitBranch: optionalNullableShortTextSchema,
    subagentId: optionalNullableShortTextSchema,
  })
  .strict();
const apiErrorSchema = z
  .object({
    type: optionalNullableShortTextSchema,
    message: z.string().max(MAX_LONG_TEXT_LENGTH).nullable().optional(),
    timestamp: nullableShortTextSchema,
  })
  .strict();
const toolResultErrorSchema = z
  .object({
    content: z.string().max(MAX_LONG_TEXT_LENGTH).nullable().optional(),
    timestamp: nullableShortTextSchema,
  })
  .strict();
const turnDurationSchema = z.object({
  durationMs: z.number(),
  timestamp: nullableShortTextSchema,
});
const messageSchema = z
  .object({
    role: z.union([
      z.literal("human"),
      z.literal("assistant"),
      z.literal("system"),
    ]),
    timestamp: nullableShortTextSchema,
    text: z.string().max(MAX_LONG_TEXT_LENGTH).nullable(),
    model: optionalNullableShortTextSchema,
    tokens: messageTokenCountsSchema.optional(),
    isThinking: z.boolean().optional(),
    isSynthetic: z.boolean().optional(),
  })
  .strict();
const tokenRecordSchema = z.object({
  timestamp: z.string().max(MAX_SHORT_TEXT_LENGTH),
  model: z.string().max(MAX_SHORT_TEXT_LENGTH),
  input: safeStorageTokenCountSchema,
  output: safeStorageTokenCountSchema,
  cacheRead: safeStorageTokenCountSchema,
  cacheWrite: safeStorageTokenCountSchema,
  // FEA-2085: fallback-attribution marker (see NormalizedTokenRecord).
  inferred: z.boolean().optional(),
});
const subagentSchema = z
  .object({
    id: z.string().min(1).max(MAX_SHORT_TEXT_LENGTH),
    parentId: optionalNullableShortTextSchema,
    name: z.string().max(MAX_SHORT_TEXT_LENGTH),
    type: optionalNullableShortTextSchema,
    task: z.string().max(MAX_LONG_TEXT_LENGTH).nullable().optional(),
    startedAt: optionalNullableShortTextSchema,
    endedAt: optionalNullableShortTextSchema,
    status: optionalNullableShortTextSchema,
    nativeSubagentId: optionalNullableShortTextSchema,
    toolUses: z.array(toolUseSchema).max(MAX_SESSION_ARRAY_ITEMS).optional(),
    tokensByModel: z
      .record(z.string().max(MAX_SHORT_TEXT_LENGTH), tokenCountsSchema)
      .optional(),
    tokenSeries: z
      .array(tokenRecordSchema)
      .max(MAX_SESSION_ARRAY_ITEMS)
      .optional(),
    metadata: z.record(z.string(), boundedUnknownValueSchema).optional(),
  })
  .strict();
const planSchema = z
  .object({
    source: optionalNullableShortTextSchema,
    content: z.string().max(MAX_LONG_TEXT_LENGTH).nullable().optional(),
    timestamp: nullableShortTextSchema,
  })
  .strict();
// FEA-2771: parse-quality signal (malformed-line drops). Optional so parsers
// that don't track it still pass this .strict() boundary validator.
const parseQualitySchema = z
  .object({
    totalLines: z.number(),
    malformedLines: z.number(),
    truncatedFinalLine: z.boolean(),
  })
  .strict();

export const HistoricalParseWorkerRequestType = {
  ParseSource: "parseSource",
} as const;

export type HistoricalParseWorkerRequestType =
  (typeof HistoricalParseWorkerRequestType)[keyof typeof HistoricalParseWorkerRequestType];

export const HistoricalParseWorkerResponseType = {
  Parsed: "parsed",
  Failed: "failed",
} as const;

export type HistoricalParseWorkerResponseType =
  (typeof HistoricalParseWorkerResponseType)[keyof typeof HistoricalParseWorkerResponseType];

/** Worker request envelope for one bounded parser job. */
export const historicalParseWorkerRequestSchema = z.object({
  type: z.literal(HistoricalParseWorkerRequestType.ParseSource),
  requestId: z.string().min(1),
  collectorKey: z.enum(HarnessValues),
  source: z.string().min(1),
});

export type HistoricalParseWorkerRequest = z.infer<
  typeof historicalParseWorkerRequestSchema
>;

/** Runtime validator for parser output crossing the utility-process boundary. */
export const normalizedSessionSchema: z.ZodType<NormalizedSession> = z
  .object({
    sessionId: z.string().min(1).max(MAX_SHORT_TEXT_LENGTH),
    name: z.string().max(MAX_LONG_TEXT_LENGTH),
    cwd: z.string().max(MAX_SHORT_TEXT_LENGTH).nullable(),
    model: z.string().max(MAX_SHORT_TEXT_LENGTH).nullable(),
    version: z.string().max(MAX_SHORT_TEXT_LENGTH).nullable(),
    slug: z.string().max(MAX_SHORT_TEXT_LENGTH).nullable(),
    gitBranch: z.string().max(MAX_SHORT_TEXT_LENGTH).nullable(),
    startedAt: z.string().max(MAX_SHORT_TEXT_LENGTH).nullable(),
    endedAt: z.string().max(MAX_SHORT_TEXT_LENGTH).nullable(),
    teams: z.array(boundedUnknownValueSchema).max(MAX_SESSION_ARRAY_ITEMS),
    userMessages: z.number(),
    assistantMessages: z.number(),
    tokensByModel: z.record(
      z.string().max(MAX_SHORT_TEXT_LENGTH),
      tokenCountsSchema
    ),
    messageTimestamps: z
      .array(z.string().max(MAX_SHORT_TEXT_LENGTH))
      .max(MAX_SESSION_ARRAY_ITEMS),
    toolUses: z.array(toolUseSchema).max(MAX_SESSION_ARRAY_ITEMS),
    subagents: z.array(subagentSchema).max(MAX_SESSION_ARRAY_ITEMS).optional(),
    plans: z.array(planSchema).max(MAX_SESSION_ARRAY_ITEMS).optional(),
    parseQuality: parseQualitySchema.optional(),
    compactions: z
      .array(boundedUnknownValueSchema)
      .max(MAX_SESSION_ARRAY_ITEMS),
    apiErrors: z.array(apiErrorSchema).max(MAX_SESSION_ARRAY_ITEMS),
    fileModifiedAt: z.number().nullable(),
    turnDurations: z.array(turnDurationSchema).max(MAX_SESSION_ARRAY_ITEMS),
    entrypoint: z.string().max(MAX_SHORT_TEXT_LENGTH),
    permissionMode: z.string().max(MAX_SHORT_TEXT_LENGTH).nullable(),
    thinkingBlockCount: z.number(),
    toolResultErrors: z
      .array(toolResultErrorSchema)
      .max(MAX_SESSION_ARRAY_ITEMS),
    usageExtras: z.object({
      service_tiers: z
        .array(boundedUnknownValueSchema)
        .max(MAX_SESSION_ARRAY_ITEMS),
      speeds: z.array(boundedUnknownValueSchema).max(MAX_SESSION_ARRAY_ITEMS),
      inference_geos: z
        .array(boundedUnknownValueSchema)
        .max(MAX_SESSION_ARRAY_ITEMS),
    }),
    messages: z.array(messageSchema).max(MAX_SESSION_ARRAY_ITEMS),
    tokenSeries: z.array(tokenRecordSchema).max(MAX_SESSION_ARRAY_ITEMS),
    diffStats: z
      .object({
        filesChanged: z.number(),
        linesAdded: z.number(),
        linesRemoved: z.number(),
      })
      .nullable(),
    slashCommands: z
      .array(
        z.object({
          name: z.string().max(MAX_SHORT_TEXT_LENGTH),
          timestamp: z.string().max(MAX_SHORT_TEXT_LENGTH),
        })
      )
      .max(MAX_SESSION_ARRAY_ITEMS),
    artifacts: z.object({
      prs: z
        .array(
          z.object({
            number: z.string().max(MAX_SHORT_TEXT_LENGTH),
            repo: z.string().max(MAX_SHORT_TEXT_LENGTH).optional(),
            url: z.string().max(MAX_LONG_TEXT_LENGTH).optional(),
          })
        )
        .max(MAX_SESSION_ARRAY_ITEMS),
      issues: z
        .array(
          z.object({
            key: z.string().max(MAX_SHORT_TEXT_LENGTH),
          })
        )
        .max(MAX_SESSION_ARRAY_ITEMS),
      repo: z.string().max(MAX_SHORT_TEXT_LENGTH).nullable(),
    }),
  })
  .strict();

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

/** Worker response envelope. */
export const historicalParseWorkerResponseSchema = z.union([
  z
    .object({
      type: z.literal(HistoricalParseWorkerResponseType.Parsed),
      requestId: z.string().min(1),
      sessions: z
        .array(normalizedSessionSchema)
        .max(MAX_WORKER_SESSIONS_PER_SOURCE),
    })
    .superRefine((response, context) => {
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
        summary.textBytes >
        HistoricalParseWorkerLimits.maxWorkerResponseTextBytes
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
 * Validate parser output before it leaves the utility process. Parsed sessions
 * are first clamped to the worker response budget; if malformed data still
 * fails the response schema, return a small nonfatal diagnostic instead of
 * sending an oversized or invalid structured clone into Electron's main process.
 */
export function createHistoricalParseWorkerParsedResponse(
  requestId: string,
  sessions: NormalizedSession[]
): HistoricalParseWorkerResponse {
  let clampedSessions: NormalizedSession[];
  try {
    clampedSessions = clampSessionsForWorkerResponse(sessions);
  } catch (error) {
    return createHistoricalParseWorkerFailedResponse(
      requestId,
      invalidResponseMessage(requestId),
      {
        diagnostic: error instanceof Error ? error.message : String(error),
      }
    );
  }

  const response = {
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId,
    sessions: clampedSessions,
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
    .safeParse({ sessions: clampedSessions });
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

export function clampSessionsForWorkerResponse(
  sessions: NormalizedSession[]
): NormalizedSession[] {
  const limited = sessions.slice(0, MAX_WORKER_SESSIONS_PER_SOURCE);
  let limit: number = MAX_SESSION_ARRAY_ITEMS;
  let working = limited.map((session) => sliceSessionArrays(session, limit));
  // Halve the per-array limit until the response-wide item + text budgets fit.
  // Bounded by log2(maxSessionArrayItems); limit 0 empties every detail array,
  // which always fits, so this terminates.
  while (limit > 0 && !fitsResponseBudget(working)) {
    limit = limit > 1 ? Math.floor(limit / 2) : 0;
    working = limited.map((session) => sliceSessionArrays(session, limit));
  }
  return working;
}

function fitsResponseBudget(sessions: NormalizedSession[]): boolean {
  const summary = summarizeWorkerResponsePayload(sessions);
  return (
    summary.arrayItems <=
      HistoricalParseWorkerLimits.maxWorkerResponseArrayItems &&
    summary.textBytes <= HistoricalParseWorkerLimits.maxWorkerResponseTextBytes
  );
}

function sliceSessionArrays(
  session: NormalizedSession,
  limit: number
): NormalizedSession {
  const sliced: NormalizedSession = {
    ...session,
    teams: session.teams.slice(0, limit),
    messageTimestamps: session.messageTimestamps.slice(0, limit),
    toolUses: session.toolUses.slice(0, limit),
    plans: session.plans?.slice(0, limit),
    compactions: session.compactions.slice(0, limit),
    apiErrors: session.apiErrors.slice(0, limit),
    turnDurations: session.turnDurations.slice(0, limit),
    toolResultErrors: session.toolResultErrors.slice(0, limit),
    usageExtras: {
      ...session.usageExtras,
      service_tiers: session.usageExtras.service_tiers.slice(0, limit),
      speeds: session.usageExtras.speeds.slice(0, limit),
      inference_geos: session.usageExtras.inference_geos.slice(0, limit),
    },
    messages: session.messages.slice(0, limit),
    tokenSeries: session.tokenSeries.slice(0, limit),
    slashCommands: session.slashCommands.slice(0, limit),
    artifacts: {
      ...session.artifacts,
      prs: session.artifacts.prs.slice(0, limit),
      issues: session.artifacts.issues.slice(0, limit),
    },
  };
  if (session.subagents) {
    sliced.subagents = session.subagents.slice(0, limit).map((subagent) => ({
      ...subagent,
      toolUses: subagent.toolUses?.slice(0, limit),
      tokenSeries: subagent.tokenSeries?.slice(0, limit),
    }));
  }
  return sliced;
}

/**
 * Return a bounded diagnostic preview for worker stderr. This protects the
 * log sink that records utility-process warnings/errors, not the raw stderr
 * stream itself.
 */
export function summarizeHistoricalWorkerStderr(chunk: Buffer): string | null {
  const text = chunk.toString("utf8");
  if (isIgnorableHistoricalWorkerStderr(text)) {
    return null;
  }
  const preview = summarizeHistoricalWorkerStderrPreview(text);
  return `historical parse worker stderr (${chunk.byteLength} bytes): ${preview}`;
}

/** Return bounded schema diagnostics without echoing raw transcript payloads. */
export function summarizeHistoricalWorkerResponseIssues(
  error: z.ZodError
): string {
  const flatIssues = flattenZodIssues(error.issues);
  const issues = flatIssues.slice(0, MAX_RESPONSE_ISSUE_COUNT).map((issue) => {
    const path = issue.path.map(String).join(".") || "<root>";
    const message = truncateResponseIssueText(issue.message);
    return `${path}:${issue.code}:${message}`;
  });
  const suffix =
    flatIssues.length > MAX_RESPONSE_ISSUE_COUNT
      ? `; +${flatIssues.length - MAX_RESPONSE_ISSUE_COUNT} more`
      : "";
  return `${issues.join("; ")}${suffix}`;
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

function truncateResponseIssueText(message: string): string {
  if (message.length <= MAX_RESPONSE_ISSUE_TEXT_LENGTH) {
    return message;
  }
  return `${message.slice(0, MAX_RESPONSE_ISSUE_TEXT_LENGTH)}...`;
}

function invalidResponseMessage(requestId: string): string {
  return `${WORKER_INVALID_RESPONSE_MESSAGE_PREFIX} for ${requestId}`;
}

function boundedDiagnosticText(text: string): string {
  const sanitized = sanitizeHistoricalWorkerDiagnosticText(text);
  if (Buffer.byteLength(sanitized, "utf8") <= MAX_LONG_TEXT_LENGTH) {
    return sanitized;
  }
  return truncateUtf8(sanitized, MAX_LONG_TEXT_LENGTH);
}

function summarizeHistoricalWorkerStderrPreview(text: string): string {
  const sanitized = sanitizeHistoricalWorkerDiagnosticText(text);
  const preview =
    Buffer.byteLength(sanitized, "utf8") <= MAX_WORKER_STDERR_PREVIEW_BYTES
      ? sanitized
      : `${truncateUtf8(
          sanitized,
          MAX_WORKER_STDERR_PREVIEW_BYTES -
            Buffer.byteLength(TRUNCATED_STDERR_PREVIEW_SUFFIX, "utf8")
        )}${TRUNCATED_STDERR_PREVIEW_SUFFIX}`;
  return preview || "<empty>";
}

function sanitizeHistoricalWorkerDiagnosticText(text: string): string {
  return redactHistoricalWorkerStderrPaths(
    redactHistoricalWorkerStderrSecrets(
      text
        .replaceAll(ANSI_ESCAPE_RE, "")
        .replaceAll(CONTROL_CHARACTERS_RE, "")
        .replaceAll(LINE_BREAKS_RE, " | ")
        .replaceAll(REPEATED_WHITESPACE_RE, " ")
        .trim()
    )
  );
}

function flattenZodIssues(issues: z.ZodIssue[], depth = 0): z.ZodIssue[] {
  const flattened: z.ZodIssue[] = [];
  for (const issue of issues) {
    if (issue.code === "invalid_union") {
      if (depth >= MAX_RESPONSE_ISSUE_UNION_DEPTH) {
        flattened.push(issue);
        continue;
      }
      let nestedIssueCount = 0;
      for (const nested of issue.errors) {
        const nestedIssues = flattenZodIssues(nested, depth + 1);
        nestedIssueCount += nestedIssues.length;
        flattened.push(...nestedIssues);
      }
      if (nestedIssueCount === 0) {
        flattened.push(issue);
      }
      continue;
    }
    flattened.push(issue);
  }
  return flattened;
}

function isIgnorableHistoricalWorkerStderr(text: string): boolean {
  const lines = text
    .replaceAll(ANSI_ESCAPE_RE, "")
    .replaceAll(CONTROL_CHARACTERS_RE, "")
    .split(LINE_BREAKS_RE)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return (
    lines.length > 0 &&
    lines.every(
      (line) =>
        NODE_SQLITE_EXPERIMENTAL_WARNING_RE.test(line) ||
        NODE_TRACE_WARNINGS_HINT_RE.test(line)
    )
  );
}

function redactHistoricalWorkerStderrSecrets(text: string): string {
  return text
    .replaceAll(CREDENTIAL_URL_RE, `https://${REDACTED_SECRET_SEGMENT}@$1`)
    .replaceAll(AWS_ACCESS_KEY_RE, REDACTED_TOKEN_SEGMENT)
    .replaceAll(BEARER_TOKEN_RE, `Bearer ${REDACTED_TOKEN_SEGMENT}`)
    .replaceAll(SK_KEY_RE, REDACTED_TOKEN_SEGMENT)
    .replaceAll(GITHUB_TOKEN_RE, REDACTED_TOKEN_SEGMENT)
    .replaceAll(SLACK_TOKEN_RE, REDACTED_TOKEN_SEGMENT)
    .replaceAll(SECRET_ASSIGNMENT_RE, `$1=${REDACTED_SECRET_SEGMENT}`);
}

function redactHistoricalWorkerStderrPaths(text: string): string {
  return text
    .replaceAll(
      FILE_URL_ABSOLUTE_PATH_RE,
      `file:///${REDACTED_PATH_SEGMENT}/$1`
    )
    .replaceAll(POSIX_ABSOLUTE_PATH_RE, `$1${REDACTED_PATH_SEGMENT}/$2`)
    .replaceAll(WINDOWS_ABSOLUTE_PATH_RE, `${REDACTED_PATH_SEGMENT}\\$1`);
}

function isBoundedUnknownValue(value: unknown, depth: number): boolean {
  if (depth > MAX_UNKNOWN_DEPTH) {
    return false;
  }
  if (value === null || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value === "string") {
    return Buffer.byteLength(value) <= MAX_LONG_TEXT_LENGTH;
  }
  if (Array.isArray(value)) {
    return (
      value.length <= MAX_UNKNOWN_ARRAY_ITEMS &&
      value.every((item) => isBoundedUnknownValue(item, depth + 1))
    );
  }
  if (isPlainRecord(value)) {
    const entries = Object.entries(value);
    return (
      entries.length <= MAX_UNKNOWN_OBJECT_KEYS &&
      entries.every(
        ([key, item]) =>
          key.length <= MAX_SHORT_TEXT_LENGTH &&
          isBoundedUnknownValue(item, depth + 1)
      )
    );
  }
  return false;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function summarizeWorkerResponsePayload(value: unknown): {
  arrayItems: number;
  textBytes: number;
} {
  if (typeof value === "string") {
    return { arrayItems: 0, textBytes: Buffer.byteLength(value) };
  }
  if (Array.isArray(value)) {
    return value.reduce(
      (summary, item) => {
        const child = summarizeWorkerResponsePayload(item);
        return {
          arrayItems: summary.arrayItems + 1 + child.arrayItems,
          textBytes: summary.textBytes + child.textBytes,
        };
      },
      { arrayItems: 0, textBytes: 0 }
    );
  }
  if (isPlainRecord(value)) {
    return Object.entries(value).reduce(
      (summary, [key, item]) => {
        const child = summarizeWorkerResponsePayload(item);
        return {
          arrayItems: summary.arrayItems + child.arrayItems,
          textBytes:
            summary.textBytes + Buffer.byteLength(key) + child.textBytes,
        };
      },
      { arrayItems: 0, textBytes: 0 }
    );
  }
  return { arrayItems: 0, textBytes: 0 };
}
