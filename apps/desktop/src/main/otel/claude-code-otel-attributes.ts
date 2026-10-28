/**
 * @file The attribute keys the Claude Code OTLP normalizer reads, and the
 * guarded readers that turn them into values.
 *
 * Extracted from `claude-code-otel-normalizer.ts` when ISS-7352 added capture
 * list A, B and E: that file owns which SIGNALS exist and how they aggregate,
 * this one owns how a single external attribute becomes a trusted value. Every
 * reader here refuses malformed input rather than repairing it — see
 * {@link readNonNegativeInteger} for why.
 */

import { numberFromOtlpValue } from "../otlp/decode-utilities.js";
import type { ClaudeCodeAttributionAttributeKey } from "./claude-code-otel-attribution.js";

/**
 * The ONLY non-attribution attribute keys the normalizer reads. Claude Code
 * stamps every export with far more than this — `user.email`, `user.groups`,
 * `prompt`, `response`, `tool_parameters`, `tool_input`, `body`, `error` — none
 * of which may reach persistence or a log line. Keeping the read set a closed
 * literal (rather than copying an attribute bag through) is what makes that
 * auditable.
 *
 * `error` is the pointed omission. ISS-7352's capture list names it under
 * `api_error`, but it is an error MESSAGE — content. The operator ruling of
 * 2026-09-11 settles what may be taken from a free-text field like it: its
 * PRESENCE, and nothing else. Not a substring, a first line, a truncation, a
 * hash, or a "sanitized" rendering — each of those is still the content — and
 * not a classification derived from reading it. `ErrorCategory` below is the
 * closed taxonomy value the producer stamps beside it, and carries the signal
 * without the message.
 *
 * No key for `error` appears here, and no reader below takes one. Nothing in
 * this lane captures the message's presence either: the table it adds
 * (`claude_code_llm_request`) has no column built from `error` or from a span's
 * nested `status`, and the already-shipped `api_error` capture is not
 * retrofitted with a presence column here. A lane that wants presence adds the
 * column and reads the field's EXISTENCE — never its value.
 */
export const ClaudeCodeOtelAttributeKey = {
  SessionId: "session.id",
  Model: "model",
  EventName: "event.name",
  EventTimestamp: "event.timestamp",
  ToolName: "tool_name",
  Decision: "decision",
  Source: "source",
  CostUsd: "cost_usd",
  DurationMs: "duration_ms",
  InputTokens: "input_tokens",
  OutputTokens: "output_tokens",
  CacheReadTokens: "cache_read_tokens",
  CacheCreationTokens: "cache_creation_tokens",
  // ISS-7352 item A — error / refusal taxonomy.
  StatusCode: "status_code",
  Attempt: "attempt",
  ErrorCategory: "error_category",
  RequestId: "request_id",
  ClientRequestId: "client_request_id",
  RefusalCategory: "category",
  ServerFallbackHop: "server_fallback_hop",
  HasCategory: "has_category",
  HasExplanation: "has_explanation",
  ErrorName: "error_name",
  ErrorCode: "error_code",
  // ISS-7352 item B — permission mode transitions.
  FromMode: "from_mode",
  ToMode: "to_mode",
  Trigger: "trigger",
  // ISS-7352 item C — MCP / auth / plugin lifecycle.
  //
  // `server_name` and the free-text `error` are the pointed omissions on
  // `mcp_server_connection`: Claude Code stamps both only under
  // `OTEL_LOG_TOOL_DETAILS=1`, `error` is a message (content — see the read
  // set's docstring above), and the capture list claims neither. `plugin.name` / `marketplace.name` are
  // NOT redeclared here — they already have a canonical spelling in
  // `ClaudeCodeAttributionAttributeKey`, and the readers below accept both sets.
  Status: "status",
  TransportType: "transport_type",
  ServerScope: "server_scope",
  IsPlugin: "is_plugin",
  PluginIdHash: "plugin_id_hash",
  Action: "action",
  Success: "success",
  AuthMethod: "auth_method",
  PluginVersion: "plugin.version",
  MarketplaceIsOfficial: "marketplace.is_official",
  InstallTrigger: "install.trigger",
  // ISS-7352 item G — counters we approximated but did not carry natively.
  //
  // `tool_input` / `tool_parameters` are omitted for the same content reason as
  // `error`; the two SIZE attributes carry the shape without the payload.
  //
  // `type` is Claude Code's GENERIC dimension key — added/removed on
  // `lines_of_code.count`, user/cli on `active_time.total`. One member rather
  // than one per counter, so the readings cannot drift to different spellings.
  MeasurementType: "type",
  StartType: "start_type",
  ToolUseId: "tool_use_id",
  ToolInputSizeBytes: "tool_input_size_bytes",
  ToolResultSizeBytes: "tool_result_size_bytes",
  McpServerScope: "mcp_server_scope",
  ErrorType: "error_type",
  // ISS-7352 item D's GA half: integer millionths of a dollar, so it survives a
  // round trip `cost_usd`'s binary float does not.
  CostUsdMicros: "cost_usd_micros",
  // ISS-7352 item D's BETA half — the `claude_code.llm_request` span tier, which
  // only arrives when the user has set `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`.
  // Nothing in this lane sets that variable; these keys say what is read when a
  // span does arrive. `ttft_ms` and `stop_reason` have no GA carrier at all.
  //
  // `RequestModel` is the gen-AI semconv spelling of the model the harness also
  // stamps bare as `model`; both are read so a producer that drops one still
  // names the model. `FinishReasons` is a `string[]` in those conventions, which
  // is why it needs {@link readStringList} rather than {@link readString}.
  //
  // The span also reports `workflow.run_id` / `workflow.name`, declared once by
  // item F below rather than twice here: one wire spelling serves both tiers,
  // and a second member holding a second spelling is how they drift apart.
  TtftMs: "ttft_ms",
  StopReason: "stop_reason",
  FinishReasons: "gen_ai.response.finish_reasons",
  ResponseHasToolCall: "response.has_tool_call",
  RequestModel: "gen_ai.request.model",
  RequestContext: "llm_request.context",
  ResponseId: "gen_ai.response.id",
  AgentId: "agent_id",
  ParentAgentId: "parent_agent_id",
  // ISS-7352 item F, JOIN-KEY half — the per-event keys that join one of our
  // rows back to Anthropic's own records and to each other.
  PromptId: "prompt.id",
  MessageUuid: "message.uuid",
  WorkflowRunId: "workflow.run_id",
  WorkflowName: "workflow.name",
  // ISS-7352 item F, IDENTITY half — per-SESSION, so these land in one
  // `claude_code_session_identity` row rather than on every event table.
  //
  // `user.email` and `user.groups` ride on these same records and are NOT read,
  // by decision rather than by oversight: an identifier is a stable join key,
  // while an email address or a group membership is a person. Keeping this read
  // set a closed literal is what makes that exclusion checkable rather than
  // merely claimed — a reader can diff the members below against the
  // producer's attribute list and see what was left out.
  OrganizationId: "organization.id",
  UserAccountUuid: "user.account_uuid",
  UserAccountId: "user.account_id",
  IdentitySource: "identity.source",
  TerminalType: "terminal.type",
  AppVersion: "app.version",
  AppEntrypoint: "app.entrypoint",
} as const;
export type ClaudeCodeOtelAttributeKey =
  (typeof ClaudeCodeOtelAttributeKey)[keyof typeof ClaudeCodeOtelAttributeKey];

/**
 * Every key a reader in this module accepts. The union rather than `string`, so
 * reaching for an attribute outside the audited read set fails typecheck.
 */
export type ClaudeCodeReadableAttributeKey =
  | ClaudeCodeOtelAttributeKey
  | ClaudeCodeAttributionAttributeKey;

const MS_PER_NANO = 1_000_000n;

/**
 * A date-time carrying an EXPLICIT zone — `Z`/`z`, or a `±HH:MM` / `±HHMM`
 * offset — which is the only form {@link eventTimeMsFrom} will hand to
 * `Date.parse`. See that function for why a zone-less form is refused.
 *
 * Requires the `T`, so a date-only `2026-06-18` cannot match on its `-18`
 * looking like an offset.
 */
const ZONED_DATE_TIME_RE = /T[\d:.]+(?:[Zz]|[+-]\d{2}:?\d{2})$/;

/** The inclusive bounds of an HTTP status code — see {@link readHttpStatusCode}. */
const HTTP_STATUS_MIN = 100;
const HTTP_STATUS_MAX = 599;

/**
 * Every spelling of a boolean {@link readBoolean} accepts, lower-cased and
 * stringified. A Map rather than an object literal because the lookup key comes
 * straight from an external attribute value, and `{}["constructor"]` is not
 * `undefined`.
 */
const BOOLEAN_SPELLINGS = new Map<string, boolean>([
  ["true", true],
  ["false", false],
  ["1", true],
  ["0", false],
]);

export function readString(
  attributes: Record<string, unknown>,
  key: ClaudeCodeReadableAttributeKey
): string | undefined {
  const value = attributes[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * An optional string, distinguishing ABSENT (`undefined`) from
 * PRESENT-BUT-INVALID (`null`).
 *
 * {@link readString} folds both into `undefined`, which is right for a key a
 * caller then REQUIRES — the record fails either way — and wrong for one it
 * leaves NULL when absent: a `stop_reason` that arrived as a number would be
 * stored as "the producer did not say" and the row would read as a normal
 * request whose stop reason silently went missing. Present is
 * `key in attributes`, for the reason {@link readTokenCount} gives.
 *
 * EMPTY IS ABSENT, not malformed: a blank string reads as `undefined`, exactly
 * as {@link readString} reads it for the GA `api_request` attributes, so the
 * beta span and the GA event agree on what a blank `request_id` means. Only a
 * value of the wrong TYPE — a number, a boolean, an array, an AnyValue that
 * decoded to nothing — is `null`.
 */
export function readOptionalString(
  attributes: Record<string, unknown>,
  key: ClaudeCodeReadableAttributeKey
): string | null | undefined {
  if (!(key in attributes)) {
    return undefined;
  }
  const value = attributes[key];
  if (typeof value !== "string") {
    return null;
  }
  return trimmedString(value);
}

export function trimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function readNonNegativeNumber(
  attributes: Record<string, unknown>,
  key: ClaudeCodeReadableAttributeKey
): number | undefined {
  return nonNegativeMeasurement(numberFromOtlpValue(attributes[key]));
}

/**
 * A measurement, or `undefined` when it is absent or not a finite non-negative
 * number.
 *
 * Exported because a cost data point's value is a proto oneof read off the
 * point itself rather than out of an attribute bag, so the normalizer has to
 * apply this guard by hand. It has to run at READ time and not at the
 * persister's Zod boundary because colliding cost points are summed first: a
 * corrupt `-0.40` netted against a valid `+1.00` reaches that boundary as
 * `0.60`, which `z.number().finite().nonnegative()` admits, and a NaN erases
 * the valid point entirely.
 */
export function nonNegativeMeasurement(
  value: number | undefined
): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

/**
 * A count, or `undefined` when the attribute is absent OR present-but-invalid.
 *
 * Deliberately NOT rounding. `Math.round` turned malformed external data into
 * plausible measurements — 1.5 tokens became 2, a negative or non-numeric value
 * became 0 — which is exactly the "never emit a plausible-but-wrong number"
 * rule. A count that is not already a safe non-negative integer is not a count
 * we observed, so it is refused rather than repaired.
 */
export function readNonNegativeInteger(
  attributes: Record<string, unknown>,
  key: ClaudeCodeReadableAttributeKey
): number | undefined {
  const value = readNonNegativeNumber(attributes, key);
  if (value === undefined || !Number.isSafeInteger(value)) {
    return undefined;
  }
  return value;
}

/**
 * A boolean attribute, distinguishing ABSENT (`undefined`) from
 * PRESENT-BUT-INVALID (`null`) — the same three-way contract
 * {@link readOptionalCount} and {@link readHttpStatusCode} carry, for the same
 * reason. These flags are what SAY whether a refusal carried a category or an
 * explanation, so collapsing a malformed one onto "the producer said nothing"
 * would store a real-looking refusal row whose taxonomy is silently missing a
 * field, while the neighbouring readers refuse the whole record for exactly
 * that class of corruption. A row is valid-or-absent, never partially-corrupt.
 *
 * The ACCEPTED spellings are a deliberate closed set: a real boolean, the
 * strings `"true"`/`"false"`, and `1`/`0` in either number or string form.
 * Claude Code is a version-skewed external producer and OTLP exporters do
 * stringify and int-encode scalars, and on a `has_*` predicate `1` has exactly
 * one reading — refusing it would drop whole refusal records over a spelling,
 * not over a corruption. Anything else (`"yes"`, `2`, `""`, an AnyValue that
 * decoded to nothing) has no reading at all and fails its record.
 */
export function readBoolean(
  attributes: Record<string, unknown>,
  key: ClaudeCodeReadableAttributeKey
): boolean | null | undefined {
  if (!(key in attributes)) {
    return undefined;
  }
  const value = attributes[key];
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  return BOOLEAN_SPELLINGS.get(String(value).trim().toLowerCase()) ?? null;
}

/**
 * A token count, distinguishing ABSENT from PRESENT-BUT-INVALID.
 *
 * Absence defaults to 0: the OTLP attribute set is sparse and the column's own
 * default is 0, so an omitted count means "none of this kind", which cannot
 * overstate usage. A present value that is not a safe non-negative integer is
 * corrupt input, and `null` propagates that so the caller drops the record
 * instead of persisting a partially-corrupt one.
 *
 * Absence is `key in attributes`, NOT `attributes[key] === undefined`.
 * `decodeOtlpAttributes` writes the key for every attribute that carried one,
 * and `decodeOtlpAnyValue` yields `undefined` for an AnyValue holding none of
 * the scalar members — so a PRESENT but undecodable count would otherwise read
 * as absent and silently become 0, which is the exact conflation this function
 * exists to prevent.
 */
export function readTokenCount(
  attributes: Record<string, unknown>,
  key: ClaudeCodeReadableAttributeKey
): number | null {
  if (!(key in attributes)) {
    return 0;
  }
  return readNonNegativeInteger(attributes, key) ?? null;
}

/**
 * An optional count, distinguishing ABSENT (`undefined`) from
 * PRESENT-BUT-INVALID (`null`).
 *
 * {@link readTokenCount} defaults absence to 0 because a token column's own
 * default is 0 and "none of this kind" is a true statement about usage. These
 * attributes have no such zero: an absent `attempt` does not mean attempt 0, it
 * means the producer did not say. So absence leaves the column NULL and only a
 * corrupt value fails its record, which is why the two cases must be
 * distinguishable rather than both collapsing to `undefined`.
 */
export function readOptionalCount(
  attributes: Record<string, unknown>,
  key: ClaudeCodeReadableAttributeKey
): number | null | undefined {
  if (!(key in attributes)) {
    return undefined;
  }
  return readNonNegativeInteger(attributes, key) ?? null;
}

/**
 * An HTTP status code, distinguishing ABSENT (`undefined`) from
 * PRESENT-BUT-INVALID (`null`).
 *
 * Bounded at BOTH ends against the status code's actual domain. A non-negative
 * check alone admits `99999`, and `Math.min` alone would admit a negative;
 * either would be stored as a real observation of a status that cannot exist.
 * Refused rather than clamped — a clamped `599` is a plausible-but-wrong value
 * a reader could not tell from a real one.
 */
export function readHttpStatusCode(
  attributes: Record<string, unknown>,
  key: ClaudeCodeReadableAttributeKey
): number | null | undefined {
  const value = readOptionalCount(attributes, key);
  if (value === undefined || value === null) {
    return value;
  }
  return value >= HTTP_STATUS_MIN && value <= HTTP_STATUS_MAX ? value : null;
}

/**
 * The event's instant, from its stamped `event.timestamp` when that names an
 * unambiguous one, and from the record's own `timeUnixNano` otherwise.
 *
 * `event.timestamp` is the one EXTERNAL STRING this lane does arithmetic on,
 * and it is guarded for the same reason every external numeric here is. An
 * ECMAScript date-time form with NO zone designator — `2026-06-18T19:00:05` —
 * is parsed as LOCAL time, so a producer that omits the `Z` would yield an
 * instant shifted by whatever offset the user's machine happens to be at. That
 * shift does not announce itself: {@link isoFromEpochMs} re-emits it as a
 * well-formed UTC ISO, the persister's timestamp regex accepts it, and
 * `started_at` is half the api_request row's natural key — so the same request
 * would land under a different identity on a laptop that crossed a timezone.
 *
 * Refused rather than repaired, and refusal costs nothing here: `timeUnixNano`
 * is epoch nanos and therefore UTC by construction, so the fallback below is a
 * BETTER instant than either reading of the ambiguous string, not a lossy one.
 */
export function eventTimeMsFrom(
  attributes: Record<string, unknown>,
  record: Record<string, unknown>
): number | undefined {
  const stamped = readString(
    attributes,
    ClaudeCodeOtelAttributeKey.EventTimestamp
  );
  const parsed =
    stamped !== undefined && ZONED_DATE_TIME_RE.test(stamped)
      ? Date.parse(stamped)
      : Number.NaN;
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return epochMsFromUnixNano(record.timeUnixNano);
}

export function epochMsFromUnixNano(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  let nanos: bigint;
  try {
    nanos = BigInt(value);
  } catch {
    return undefined;
  }
  if (nanos <= 0n) {
    return undefined;
  }
  const millis = Number(nanos / MS_PER_NANO);
  return Number.isSafeInteger(millis) ? millis : undefined;
}

export function isoFromUnixNano(value: unknown): string | undefined {
  return isoFromEpochMs(epochMsFromUnixNano(value));
}

export function isoFromEpochMs(millis: number | undefined): string | undefined {
  if (millis === undefined || millis < 0) {
    return undefined;
  }
  const date = new Date(millis);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : undefined;
}

/**
 * The same signal with every undefined-valued key REMOVED.
 *
 * An absent attribute must produce an ABSENT key, not a key holding
 * `undefined`. The two are interchangeable to Zod and to the persister's
 * `?? null`, but not to everything downstream: the receiver-persistence suite
 * walks each emitted signal's entries and asserts every value is a scalar, and
 * a `{ agentName: undefined }` is a key that suddenly exists on a payload that
 * carried nothing. Preserving omission is also the repo's cross-repo rule for
 * optional fields, and it keeps the signal a faithful description of what
 * arrived rather than of which fields this build knows about.
 */
export function withoutUndefinedValues<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as T;
}

/**
 * A list-valued attribute flattened to one comma-joined string, distinguishing
 * ABSENT (`undefined`) from PRESENT-BUT-INVALID (`null`).
 *
 * `gen_ai.response.finish_reasons` is a `string[]` in the gen-AI semantic
 * conventions, so it arrives as an OTLP `arrayValue` AnyValue — which
 * {@link readString} reads as absent, silently dropping the only record of why
 * generation stopped. A single string is accepted too: this is a version-skewed
 * external producer and the scalar spelling is what a pre-semconv build sends.
 *
 * A member that is not a non-empty string fails the WHOLE attribute rather than
 * being skipped. Dropping one reason out of two would store a shorter list that
 * reads exactly like a genuine one-reason response, which is the
 * plausible-but-wrong value this lane's readers exist to refuse.
 *
 * EMPTY IS ABSENT, the same posture as {@link readOptionalString}: an array
 * with no members, or a blank scalar, reads as `undefined`. A request that
 * failed before the model answered is a realistic producer of
 * `finish_reasons: []`, and refusing it would drop every such request from the
 * table over an attribute whose column is NULL for "no reasons" either way;
 * `success` and `status_code` carry the failure. Only the wrong TYPE is
 * malformed — a non-array scalar, or a member that is not a non-empty string.
 */
export function readStringList(
  attributes: Record<string, unknown>,
  key: ClaudeCodeReadableAttributeKey
): string | null | undefined {
  if (!(key in attributes)) {
    return undefined;
  }
  const value = attributes[key];
  if (typeof value === "string") {
    return trimmedString(value);
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const members: string[] = [];
  for (const member of value) {
    const trimmed = trimmedString(member);
    if (trimmed === undefined) {
      return null;
    }
    members.push(trimmed);
  }
  return members.length > 0 ? members.join(",") : undefined;
}
