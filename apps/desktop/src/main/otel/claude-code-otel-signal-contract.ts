/**
 * @file The Claude Code OTel lane's SIGNAL CONTRACT — the signal-type and
 * table-name constants, the closed sets the normalizer maps onto, the Zod
 * schemas that admit a row, and the derived natural-key columns.
 *
 * Extracted from `claude-code-persistence.ts` when ISS-7352 added capture list
 * C and G: that file owns how a validated signal becomes a WRITE, this one owns
 * what a signal IS. Splitting them keeps either side under the 1,000-line
 * ceiling and gives the producers (the normalizer and its signal builders) a
 * contract to type against that does not drag the Prisma client in with it.
 *
 * Nothing here imports the persister, so the dependency runs one way:
 * contract -> writers -> persister.
 */

import { canStoreAuthoritativeCostUsd } from "@repo/api/src/constants";
import { z } from "zod";
import { safeStorageTokenCountSchema } from "../cost/token-counts.js";
import { joinKeyParts } from "./claude-code-otel-key-encoding.js";

export const ClaudeCodeOtelSignalType = {
  CostUsage: "cost_usage",
  PermissionDecision: "permission_decision",
  ApiRequest: "api_request",
  TokenUsage: "token_usage",
  /** ISS-7352 item A — `api_error` / `api_refusal` / `internal_error`. */
  ErrorEvent: "error_event",
  /** ISS-7352 item B — `permission_mode_changed`. */
  PermissionModeChange: "permission_mode_change",
  /** ISS-7352 item C — `mcp_server_connection`. */
  McpServerConnection: "mcp_server_connection",
  /** ISS-7352 item C — `auth`. */
  AuthEvent: "auth_event",
  /** ISS-7352 item C — `plugin_installed` / `plugin_loaded`. */
  PluginEvent: "plugin_event",
  /** ISS-7352 item G — the `claude_code.lines_of_code.count` counter. */
  LinesOfCode: "lines_of_code",
  /** ISS-7352 item G — the `claude_code.session.count` counter. */
  SessionStart: "session_start",
  /** ISS-7352 item G — `tool_result`. */
  ToolResult: "tool_result",
  /** ISS-7352 item D — the GA `claude_code.active_time.total` counter. */
  ActiveTime: "active_time",
  /** ISS-7352 item F — the per-session account / organization identifiers. */
  SessionIdentity: "session_identity",
  /** ISS-7352 item D — one beta `claude_code.llm_request` span. */
  LlmRequest: "llm_request",
} as const;
export type ClaudeCodeOtelSignalType =
  (typeof ClaudeCodeOtelSignalType)[keyof typeof ClaudeCodeOtelSignalType];

export const ClaudeCodeOtelWarningSignalType = {
  Unknown: "unknown",
} as const;
export type ClaudeCodeOtelWarningSignalType =
  | ClaudeCodeOtelSignalType
  | (typeof ClaudeCodeOtelWarningSignalType)[keyof typeof ClaudeCodeOtelWarningSignalType];

export const ClaudeCodePermissionDecision = {
  Allow: "allow",
  Deny: "deny",
} as const;
export type ClaudeCodePermissionDecision =
  (typeof ClaudeCodePermissionDecision)[keyof typeof ClaudeCodePermissionDecision];

// The published closed set for `claude_code.tool_decision`'s `source`
// (https://code.claude.com/docs/en/monitoring-usage). `user_temporary` (a
// one-time "Yes") and `user_abort` (prompt dismissed unanswered) were missing,
// so ISS-7352's normalizer would have dropped every decision carrying them.
export const ClaudeCodePermissionSource = {
  Config: "config",
  Hook: "hook",
  UserPermanent: "user_permanent",
  UserTemporary: "user_temporary",
  UserAbort: "user_abort",
  UserReject: "user_reject",
  /**
   * A `source` this build does not know — NOT a value Claude Code emits.
   *
   * Claude Code is a version-skewed external producer that can add a source at
   * any time. Dropping the decision on an unrecognized one would silently lose
   * the whole allow/deny record (which we DO understand) over one attribute we
   * do not, so an unknown source degrades to this rather than failing the row.
   */
  Unknown: "unknown",
} as const;
export type ClaudeCodePermissionSource =
  (typeof ClaudeCodePermissionSource)[keyof typeof ClaudeCodePermissionSource];

// The published closed set for `claude_code.active_time.total`'s `type`
// (https://code.claude.com/docs/en/monitoring-usage): `user` for keyboard
// interactions, `cli` for tool execution and AI responses.
//
// Unlike `ClaudeCodePermissionSource` above, an unrecognized value CANNOT
// degrade to an `unknown` member here: this one keys the row, so storing it
// would invent a third activity category that any user-plus-cli total then
// silently misses. The point is refused and counted `unusable` instead, the
// same answer an absent `type` already gets, which keeps the table the LOWER
// BOUND its siblings are rather than a total over undefined buckets.
export const ClaudeCodeActivityType = {
  User: "user",
  Cli: "cli",
} as const;
export type ClaudeCodeActivityType =
  (typeof ClaudeCodeActivityType)[keyof typeof ClaudeCodeActivityType];

/**
 * ISS-7352 item A — the three failure events, sharing one table because they
 * share a grain (one row per failed attempt) and differ only in which taxonomy
 * columns they fill. The value is the discriminant stored in `error_kind`.
 */
export const ClaudeCodeErrorKind = {
  ApiError: "api_error",
  ApiRefusal: "api_refusal",
  InternalError: "internal_error",
} as const;
export type ClaudeCodeErrorKind =
  (typeof ClaudeCodeErrorKind)[keyof typeof ClaudeCodeErrorKind];

/**
 * ISS-7352 item C — which plugin lifecycle moment a row records.
 *
 * `plugin_installed` and `plugin_loaded` share one table for the same reason
 * the three error kinds do: one grain (one row per plugin per moment) and one
 * column set. They are NOT interchangeable — an install happens once and a load
 * happens at every session start — so the discriminant is stored rather than
 * inferred from which columns are populated.
 */
export const ClaudeCodePluginLifecycle = {
  Installed: "installed",
  Loaded: "loaded",
} as const;
export type ClaudeCodePluginLifecycle =
  (typeof ClaudeCodePluginLifecycle)[keyof typeof ClaudeCodePluginLifecycle];

export const ClaudeCodeOtelTableName = {
  CostEvent: "claude_code_cost_event",
  PermissionEvent: "claude_code_permission_event",
  ApiRequest: "claude_code_api_request",
  TokenUsage: "token_usage",
  ErrorEvent: "claude_code_error_event",
  PermissionModeChange: "claude_code_permission_mode_change",
  McpServerConnection: "claude_code_mcp_server_connection",
  AuthEvent: "claude_code_auth_event",
  PluginEvent: "claude_code_plugin_event",
  LinesOfCode: "claude_code_lines_of_code",
  SessionStart: "claude_code_session_start",
  ToolResult: "claude_code_tool_result",
  ActiveTime: "claude_code_active_time",
  SessionIdentity: "claude_code_session_identity",
  LlmRequest: "claude_code_llm_request",
} as const;
export type ClaudeCodeOtelTableName =
  (typeof ClaudeCodeOtelTableName)[keyof typeof ClaudeCodeOtelTableName];

/**
 * The validated signal shape this lane persists. Exported so producers (the
 * OTLP normalizer) are typed against the same contract `validate()` enforces —
 * a new required field then fails their typecheck rather than their payload.
 */
export type ClaudeCodeOtelSignal = z.infer<typeof claudeCodeOtelSignalSchema>;

/** The cost counter member of the union — ISS-7352 item E rides on this one. */
export type ClaudeCodeCostUsageSignal = Extract<
  ClaudeCodeOtelSignal,
  { type: typeof ClaudeCodeOtelSignalType.CostUsage }
>;

/** The error/refusal member of the union — ISS-7352 item A. */
export type ClaudeCodeErrorEventSignal = Extract<
  ClaudeCodeOtelSignal,
  { type: typeof ClaudeCodeOtelSignalType.ErrorEvent }
>;

/** The permission-mode-transition member of the union — ISS-7352 item B. */
export type ClaudeCodePermissionModeChangeSignal = Extract<
  ClaudeCodeOtelSignal,
  { type: typeof ClaudeCodeOtelSignalType.PermissionModeChange }
>;

/** The MCP connection member of the union — ISS-7352 item C. */
export type ClaudeCodeMcpServerConnectionSignal = Extract<
  ClaudeCodeOtelSignal,
  { type: typeof ClaudeCodeOtelSignalType.McpServerConnection }
>;

/** The auth member of the union — ISS-7352 item C. */
export type ClaudeCodeAuthEventSignal = Extract<
  ClaudeCodeOtelSignal,
  { type: typeof ClaudeCodeOtelSignalType.AuthEvent }
>;

/** The plugin-lifecycle member of the union — ISS-7352 item C. */
export type ClaudeCodePluginEventSignal = Extract<
  ClaudeCodeOtelSignal,
  { type: typeof ClaudeCodeOtelSignalType.PluginEvent }
>;

/** The lines-of-code counter member of the union — ISS-7352 item G. */
export type ClaudeCodeLinesOfCodeSignal = Extract<
  ClaudeCodeOtelSignal,
  { type: typeof ClaudeCodeOtelSignalType.LinesOfCode }
>;

/** The session-start counter member of the union — ISS-7352 item G. */
export type ClaudeCodeSessionStartSignal = Extract<
  ClaudeCodeOtelSignal,
  { type: typeof ClaudeCodeOtelSignalType.SessionStart }
>;

/** The tool-result member of the union — ISS-7352 item G. */
export type ClaudeCodeToolResultSignal = Extract<
  ClaudeCodeOtelSignal,
  { type: typeof ClaudeCodeOtelSignalType.ToolResult }
>;

/** The active-time counter member of the union — ISS-7352 item D. */
export type ClaudeCodeActiveTimeSignal = Extract<
  ClaudeCodeOtelSignal,
  { type: typeof ClaudeCodeOtelSignalType.ActiveTime }
>;

/** The per-session identity member of the union — ISS-7352 item F. */
export type ClaudeCodeSessionIdentitySignal = Extract<
  ClaudeCodeOtelSignal,
  { type: typeof ClaudeCodeOtelSignalType.SessionIdentity }
>;

/** The beta span member of the union — ISS-7352 item D. */
export type ClaudeCodeLlmRequestSignal = Extract<
  ClaudeCodeOtelSignal,
  { type: typeof ClaudeCodeOtelSignalType.LlmRequest }
>;

/** The per-request member of the union, for the collision guard. */
export type ClaudeCodeApiRequestSignal = Extract<
  ClaudeCodeOtelSignal,
  { type: typeof ClaudeCodeOtelSignalType.ApiRequest }
>;

/** The allow/deny member of the union, for the collision guard. */
export type ClaudeCodePermissionDecisionSignal = Extract<
  ClaudeCodeOtelSignal,
  { type: typeof ClaudeCodeOtelSignalType.PermissionDecision }
>;

/**
 * The signals the OTel lane is allowed to write: everything except
 * `token_usage`.
 *
 * `token_usage` is owned by the transcript parser, whose unique key is
 * `(session_id, model)`; an OTel writer would overwrite those totals rather
 * than add to them. Excluding it at the TYPE level means a caller that reaches
 * for it fails typecheck instead of quietly taking the table over.
 *
 * Types do not survive the db-host process boundary, so `isTokenUsageOtelSignal`
 * in `claude-code-persistence.ts` is the runtime half of the same rule.
 */
export type ClaudeCodeOtelSideTableSignal = Exclude<
  ClaudeCodeOtelSignal,
  { type: typeof ClaudeCodeOtelSignalType.TokenUsage }
>;

/**
 * ISS-7352 item F — the per-event join keys every EVENT-sourced signal carries.
 *
 * Declared once and spread into each event schema, so the reader
 * (`eventCorrelationFrom`), the collision comparison (`sameEventCorrelation`)
 * and the persisted columns (`eventCorrelationColumns`) all key off one
 * definition and a fifth key cannot be added to some of them and not others.
 */
export type ClaudeCodeEventCorrelation = z.infer<typeof eventCorrelationSchema>;

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const isoTimestampSchema = z.string().trim().min(1).refine(isValidTimestamp, {
  message: "must be a valid timestamp",
});
const nonEmptyStringSchema = z.string().trim().min(1);
const finiteNonNegativeNumberSchema = z.number().finite().nonnegative();
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const baseSignalSchema = z.object({
  sessionId: nonEmptyStringSchema,
});
const tokenCountsSchema = z.object({
  inputTokens: safeStorageTokenCountSchema,
  outputTokens: safeStorageTokenCountSchema,
  cacheReadTokens: safeStorageTokenCountSchema,
  cacheCreationTokens: safeStorageTokenCountSchema,
});
/**
 * ISS-7352 item E — the component attribution rider on a cost counter.
 *
 * Every field is optional because the OTLP attribute set is sparse: an
 * ordinary main-loop request carries none of them. The derived
 * `attribution_key` and `attribution_source` columns are NOT part of this
 * contract — `attributionKeyOf` and `attributionSourceOf` compute them at write
 * time from exactly these fields, so the key the normalizer aggregates on and
 * the key the row is stored under cannot drift apart.
 */
const componentAttributionSchema = z.object({
  agentName: nonEmptyStringSchema.optional(),
  skillName: nonEmptyStringSchema.optional(),
  pluginName: nonEmptyStringSchema.optional(),
  marketplaceName: nonEmptyStringSchema.optional(),
  mcpServerName: nonEmptyStringSchema.optional(),
  mcpToolName: nonEmptyStringSchema.optional(),
  querySource: nonEmptyStringSchema.optional(),
  speed: nonEmptyStringSchema.optional(),
  effort: nonEmptyStringSchema.optional(),
});
/**
 * ISS-7352 item F — the per-event join keys.
 *
 * Every field optional: Claude Code stamps `prompt.id` and `message.uuid` on
 * the records belonging to a turn and omits them on the ones that belong to no
 * turn (an `auth` at startup), and the two `workflow.*` keys only exist when
 * the session was launched by one. None of them enters a natural key — a
 * nullable column in a SQLite UNIQUE index makes every row carrying a NULL
 * distinct from itself, which turns the persister's upsert into a duplicate
 * insert on every export. They are compared by `sameEventCorrelation` instead,
 * which is what makes a provably-distinct collision COUNTABLE rather than
 * silent.
 */
const eventCorrelationSchema = z.object({
  promptId: nonEmptyStringSchema.optional(),
  messageUuid: nonEmptyStringSchema.optional(),
  workflowRunId: nonEmptyStringSchema.optional(),
  workflowName: nonEmptyStringSchema.optional(),
});
const costUsageSignalSchema = baseSignalSchema.extend({
  type: z.literal(ClaudeCodeOtelSignalType.CostUsage),
  model: nonEmptyStringSchema,
  observedAt: isoTimestampSchema,
  // ISS-7229 (whitlockk, #6385 review): bounded by the CLOUD column's width, because
  // this figure is summed into `sessions.authoritative_cost_usd` and synced to a
  // `Decimal(14,6)`. Without it a `1e100` point was stored locally at a
  // magnitude the cloud reads back as absent — the two ends disagreeing about
  // one session's cost.
  //
  // The normalizer applies the SAME bound at read time, and both are needed for
  // the reason the non-negative guard already gives: colliding points are SUMMED
  // before they reach this schema, so an unstorable point netted against valid
  // ones would arrive here innocuous and take them down with it. This one is the
  // PROCESS-BOUNDARY half — the db-host receives whatever IPC hands it, which
  // never passed through the normalizer at all.
  // Refines rather than `.lt(...)`: the shared predicate rounds to the column's
  // six decimals before comparing, and a bare inequality admits the sliver that
  // rounds UP past the ceiling on its way into the rollup this sum feeds.
  costUsd: finiteNonNegativeNumberSchema.refine(canStoreAuthoritativeCostUsd),
  ...componentAttributionSchema.shape,
});
/**
 * ISS-7352 item F / ISS-7481 — `toolUseId` is the harness's own identifier for
 * the invocation the decision is about, and the join to this call's
 * `claude_code_tool_result` row.
 *
 * It stays OUT of the natural key, which remains
 * `(session_id, tool_name, observed_at)`: it is nullable, and a nullable column
 * in a SQLite UNIQUE index makes every row carrying a NULL distinct from
 * itself. `samePermissionDecisionOutcome` compares it instead, which is what
 * turns two parallel auto-approved `Read`s from a silent overwrite into a
 * counted `unusable` (ISS-7481).
 */
const permissionDecisionSignalSchema = baseSignalSchema.extend({
  type: z.literal(ClaudeCodeOtelSignalType.PermissionDecision),
  toolName: nonEmptyStringSchema,
  observedAt: isoTimestampSchema,
  decision: z.enum(ClaudeCodePermissionDecision),
  source: z.enum(ClaudeCodePermissionSource),
  toolUseId: nonEmptyStringSchema.optional(),
  ...eventCorrelationSchema.shape,
});
/**
 * `costUsdMicros` (ISS-7352 item D) is the SAME cost as `costUsd`, in exact
 * integer millionths rather than a float that cannot hold most cent values —
 * never a second cost to sum. Optional, because a Claude Code older than the
 * build that added it stamps only `cost_usd` and refusing those rows would
 * trade every pre-upgrade request for a precision improvement.
 */
const apiRequestSignalSchema = baseSignalSchema.extend({
  type: z.literal(ClaudeCodeOtelSignalType.ApiRequest),
  model: nonEmptyStringSchema,
  startedAt: isoTimestampSchema,
  durationMs: nonNegativeIntegerSchema,
  costUsd: finiteNonNegativeNumberSchema,
  costUsdMicros: safeStorageTokenCountSchema.optional(),
  // ISS-7352 item F — the join back to Anthropic's own record of this request.
  // Anthropic issues one `request_id` per request, which makes it the strongest
  // evidence this table has that two records colliding on
  // `(session, started_at, model)` are two requests rather than one re-sent.
  requestId: nonEmptyStringSchema.optional(),
  clientRequestId: nonEmptyStringSchema.optional(),
  ...tokenCountsSchema.shape,
  ...eventCorrelationSchema.shape,
});
const tokenUsageSignalSchema = baseSignalSchema.extend({
  type: z.literal(ClaudeCodeOtelSignalType.TokenUsage),
  model: nonEmptyStringSchema,
  observedAt: isoTimestampSchema.optional(),
  ...tokenCountsSchema.shape,
});
/**
 * An HTTP status code's actual domain. Bounded at BOTH ends deliberately: a
 * lower bound alone admits 99999 and an upper bound alone admits a negative,
 * and either would be stored as a real observation of a status that cannot
 * exist. A present-but-out-of-range code fails the whole record, matching what
 * `api_request` already does with a corrupt token count — a row is
 * valid-or-absent, never partially-corrupt.
 */
const httpStatusCodeSchema = z.number().int().min(100).max(599);
const errorEventSignalSchema = baseSignalSchema.extend({
  type: z.literal(ClaudeCodeOtelSignalType.ErrorEvent),
  errorKind: z.enum(ClaudeCodeErrorKind),
  observedAt: isoTimestampSchema,
  model: nonEmptyStringSchema.optional(),
  statusCode: httpStatusCodeSchema.optional(),
  attempt: nonNegativeIntegerSchema.optional(),
  errorCategory: nonEmptyStringSchema.optional(),
  durationMs: nonNegativeIntegerSchema.optional(),
  requestId: nonEmptyStringSchema.optional(),
  clientRequestId: nonEmptyStringSchema.optional(),
  refusalCategory: nonEmptyStringSchema.optional(),
  serverFallbackHop: nonNegativeIntegerSchema.optional(),
  hasCategory: z.boolean().optional(),
  hasExplanation: z.boolean().optional(),
  errorName: nonEmptyStringSchema.optional(),
  errorCode: nonEmptyStringSchema.optional(),
  ...eventCorrelationSchema.shape,
});
const permissionModeChangeSignalSchema = baseSignalSchema.extend({
  type: z.literal(ClaudeCodeOtelSignalType.PermissionModeChange),
  observedAt: isoTimestampSchema,
  // Both ends are required: a transition is the pair, and a row naming only
  // where it landed says no more than the session's current mode already does.
  fromMode: nonEmptyStringSchema,
  toMode: nonEmptyStringSchema,
  trigger: nonEmptyStringSchema.optional(),
  ...eventCorrelationSchema.shape,
});
/**
 * ISS-7352 item C — one MCP server connection attempt.
 *
 * `status` is a plain string rather than a `z.enum`. It is an OPEN external
 * taxonomy (`connected` / `failed` / `disconnected` today) from a version-skewed
 * producer, and it is the row's whole point: refusing a record whose status this
 * build does not recognize would lose the fact that a connection attempt
 * happened at all. Same posture the landed `errorCategory` / `refusalCategory`
 * take. It IS required — a connection row that cannot say how the attempt ended
 * carries nothing.
 */
const mcpServerConnectionSignalSchema = baseSignalSchema.extend({
  type: z.literal(ClaudeCodeOtelSignalType.McpServerConnection),
  observedAt: isoTimestampSchema,
  status: nonEmptyStringSchema,
  transportType: nonEmptyStringSchema.optional(),
  serverScope: nonEmptyStringSchema.optional(),
  durationMs: nonNegativeIntegerSchema.optional(),
  errorCode: nonEmptyStringSchema.optional(),
  isPlugin: z.boolean().optional(),
  pluginIdHash: nonEmptyStringSchema.optional(),
  ...eventCorrelationSchema.shape,
});
/**
 * ISS-7352 item C — one `login` / `logout` action.
 *
 * `action` is required for the same reason `status` is above. `success` is a
 * real boolean here because the producer documents it as the strings
 * `"true"`/`"false"`, which `readBoolean` resolves before this boundary.
 */
const authEventSignalSchema = baseSignalSchema.extend({
  type: z.literal(ClaudeCodeOtelSignalType.AuthEvent),
  observedAt: isoTimestampSchema,
  action: nonEmptyStringSchema,
  success: z.boolean().optional(),
  authMethod: nonEmptyStringSchema.optional(),
  errorCategory: nonEmptyStringSchema.optional(),
  statusCode: httpStatusCodeSchema.optional(),
  ...eventCorrelationSchema.shape,
});
/**
 * ISS-7352 item C — one plugin install or load.
 *
 * `pluginName` is optional even though it is the row's subject: Claude Code
 * replaces it with the literal `"third-party"` (or omits it) for third-party
 * marketplaces unless `OTEL_LOG_TOOL_DETAILS=1`. Refusing those records would
 * silently make the plugin inventory describe only first-party plugins, which
 * is a worse lie than a row that records an install it cannot name.
 */
const pluginEventSignalSchema = baseSignalSchema.extend({
  type: z.literal(ClaudeCodeOtelSignalType.PluginEvent),
  observedAt: isoTimestampSchema,
  lifecycle: z.enum(ClaudeCodePluginLifecycle),
  pluginName: nonEmptyStringSchema.optional(),
  pluginVersion: nonEmptyStringSchema.optional(),
  marketplaceName: nonEmptyStringSchema.optional(),
  marketplaceIsOfficial: z.boolean().optional(),
  installTrigger: nonEmptyStringSchema.optional(),
  ...eventCorrelationSchema.shape,
});
/**
 * ISS-7352 item G — the `claude_code.lines_of_code.count` delta counter.
 *
 * `model` and `changeType` are both required and both in the natural key: the
 * value of this counter over our own session-level `diffStats` is precisely
 * that it splits by added-vs-removed AND by which model made the change, so a
 * point that cannot say either is not the measurement this table exists for.
 */
const linesOfCodeSignalSchema = baseSignalSchema.extend({
  type: z.literal(ClaudeCodeOtelSignalType.LinesOfCode),
  model: nonEmptyStringSchema,
  observedAt: isoTimestampSchema,
  changeType: nonEmptyStringSchema,
  lineCount: safeStorageTokenCountSchema,
});
/**
 * ISS-7352 item G — the `claude_code.session.count` delta counter.
 *
 * `startType` (fresh / resume / continue / agents_view) is the reason to keep
 * this counter at all: nothing else we collect distinguishes a resumed session
 * from a fresh one. Required and in the key for that reason.
 */
const sessionStartSignalSchema = baseSignalSchema.extend({
  type: z.literal(ClaudeCodeOtelSignalType.SessionStart),
  observedAt: isoTimestampSchema,
  startType: nonEmptyStringSchema,
  sessionCount: safeStorageTokenCountSchema,
});
/**
 * ISS-7352 item G — one `tool_result`.
 *
 * `success` is captured alongside `errorType` deliberately. `error_type` is only
 * stamped on a FAILED tool call, so on its own a NULL cannot distinguish a tool
 * that succeeded from one that failed without a category — the row would not be
 * able to say whether the call worked.
 *
 * The free-text `error`, `tool_input` and `tool_parameters` attributes are NOT
 * captured: they are content, and the operator's 2026-09-11 ruling is that the
 * error message itself is never taken — no substring, first line, truncation,
 * hash or "sanitized" rendering, and no classification derived by reading it.
 * The two SIZE attributes carry the shape of that content without the content.
 */
const toolResultSignalSchema = baseSignalSchema.extend({
  type: z.literal(ClaudeCodeOtelSignalType.ToolResult),
  observedAt: isoTimestampSchema,
  toolName: nonEmptyStringSchema,
  toolUseId: nonEmptyStringSchema.optional(),
  success: z.boolean().optional(),
  errorType: nonEmptyStringSchema.optional(),
  toolInputSizeBytes: safeStorageTokenCountSchema.optional(),
  toolResultSizeBytes: safeStorageTokenCountSchema.optional(),
  mcpServerScope: nonEmptyStringSchema.optional(),
  ...eventCorrelationSchema.shape,
});
/**
 * ISS-7352 item D — the `claude_code.active_time.total` delta counter. GA
 * despite item D reading as beta-gated: only the TRACE tier sits behind
 * `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA`, and this is a metric.
 *
 * `activityType` is required, closed to the published `user` / `cli` set, and
 * keys the row: the split between the human typing and the CLI working IS the
 * measurement, and an undifferentiated total answers nothing our timestamps do
 * not.
 *
 * `seconds` tolerates a fraction because the unit is seconds and the value is a
 * duration — rounding would discard every sub-second interval.
 */
const activeTimeSignalSchema = baseSignalSchema.extend({
  type: z.literal(ClaudeCodeOtelSignalType.ActiveTime),
  observedAt: isoTimestampSchema,
  activityType: z.enum(ClaudeCodeActivityType),
  seconds: finiteNonNegativeNumberSchema,
});
/**
 * ISS-7352 item F, IDENTITY half — who a session belongs to.
 *
 * Every identifier is OPTIONAL because the producer stamps them at different
 * moments: `organization.id` appears only once the session has authenticated,
 * so a record emitted before that carries none of them.
 *
 * The refusal below is what keeps optional-everything from meaning
 * says-nothing. `sessionIdentitySignalFrom` already declines to build a signal
 * that resolved no identifier, but this schema is the db-host BOUNDARY — the
 * last thing between any producer and the column — and a boundary that trusts
 * one producer's discipline is not a boundary. Without it a signal carrying
 * only `sessionId` and `observedAt` validates and writes the all-NULL row this
 * table exists to make impossible: a reader cannot tell that row from a session
 * resolved to an empty account, and the unattributed population this lane was
 * built to measure stops being countable.
 *
 * There is no field here for `user.email` or `user.groups`. They are excluded
 * by decision, not merely unbuilt — this table joins rows to an account, it
 * does not describe a person.
 */
const sessionIdentifierSchemas = {
  organizationId: nonEmptyStringSchema.optional(),
  userAccountUuid: nonEmptyStringSchema.optional(),
  userAccountId: nonEmptyStringSchema.optional(),
  identitySource: nonEmptyStringSchema.optional(),
  terminalType: nonEmptyStringSchema.optional(),
  appVersion: nonEmptyStringSchema.optional(),
  appEntrypoint: nonEmptyStringSchema.optional(),
};
// Spread into the schema AND iterated by the refusal below, so the two cannot
// drift: an identifier added here is checked without anyone remembering to add
// it to a second list.
const SESSION_IDENTIFIER_KEYS = Object.keys(
  sessionIdentifierSchemas
) as readonly (keyof typeof sessionIdentifierSchemas)[];
const sessionIdentitySignalSchema = baseSignalSchema
  .extend({
    type: z.literal(ClaudeCodeOtelSignalType.SessionIdentity),
    observedAt: isoTimestampSchema,
    ...sessionIdentifierSchemas,
  })
  .refine(
    (signal) =>
      SESSION_IDENTIFIER_KEYS.some((key) => signal[key] !== undefined),
    {
      error:
        "a session identity resolved no identifier: an all-NULL row cannot be told from a session attributed to an empty account",
    }
  );

/**
 * ISS-7352 item D — one beta `claude_code.llm_request` span.
 *
 * `traceId`/`spanId` are required and carry the producer's own identity for the
 * request; `startedAt` is the span's start instant. Everything the span
 * MEASURES is optional, because the tier is beta and an attribute it stops
 * stamping must cost that column rather than the whole request. A
 * present-but-invalid value never reaches here — the span builder fails the
 * record first, so a row is valid-or-absent.
 *
 * `finishReasons` is a comma-joined rendering of the `string[]` the gen-AI
 * semantic conventions define, flattened by `readStringList` so the column can
 * hold it whole or not at all.
 *
 * No field carries the span's `status.message` or any span event: both are
 * free-text content and neither is read.
 */
const llmRequestSignalSchema = baseSignalSchema.extend({
  type: z.literal(ClaudeCodeOtelSignalType.LlmRequest),
  traceId: nonEmptyStringSchema,
  spanId: nonEmptyStringSchema,
  parentSpanId: nonEmptyStringSchema.optional(),
  startedAt: isoTimestampSchema,
  model: nonEmptyStringSchema.optional(),
  querySource: nonEmptyStringSchema.optional(),
  speed: nonEmptyStringSchema.optional(),
  requestContext: nonEmptyStringSchema.optional(),
  durationMs: nonNegativeIntegerSchema.optional(),
  ttftMs: nonNegativeIntegerSchema.optional(),
  stopReason: nonEmptyStringSchema.optional(),
  finishReasons: nonEmptyStringSchema.optional(),
  responseHasToolCall: z.boolean().optional(),
  attempt: nonNegativeIntegerSchema.optional(),
  success: z.boolean().optional(),
  statusCode: httpStatusCodeSchema.optional(),
  requestId: nonEmptyStringSchema.optional(),
  clientRequestId: nonEmptyStringSchema.optional(),
  responseId: nonEmptyStringSchema.optional(),
  agentId: nonEmptyStringSchema.optional(),
  parentAgentId: nonEmptyStringSchema.optional(),
  workflowRunId: nonEmptyStringSchema.optional(),
  workflowName: nonEmptyStringSchema.optional(),
  ...tokenCountsSchema.shape,
});
const claudeCodeOtelSignalSchema = z.discriminatedUnion("type", [
  costUsageSignalSchema,
  permissionDecisionSignalSchema,
  apiRequestSignalSchema,
  tokenUsageSignalSchema,
  errorEventSignalSchema,
  permissionModeChangeSignalSchema,
  mcpServerConnectionSignalSchema,
  authEventSignalSchema,
  pluginEventSignalSchema,
  linesOfCodeSignalSchema,
  sessionStartSignalSchema,
  toolResultSignalSchema,
  activeTimeSignalSchema,
  sessionIdentitySignalSchema,
  llmRequestSignalSchema,
]);

export const claudeCodeOtelSignalTypeSchema = z.enum(ClaudeCodeOtelSignalType);

export function parseClaudeCodeOtelSignal(event: unknown) {
  return claudeCodeOtelSignalSchema.safeParse(event);
}

function isValidTimestamp(value: string): boolean {
  if (!ISO_TIMESTAMP_RE.test(value)) {
    return false;
  }
  const timestamp = new Date(value);
  return (
    Number.isFinite(timestamp.valueOf()) && timestamp.toISOString() === value
  );
}

/**
 * The parts of a derived key, or `""` when the event offered nothing that
 * distinguishes one record from another at the same instant.
 *
 * `""` is not a convenience sentinel: it is the value the migration gives every
 * pre-existing row, so an old row and a genuinely undistinguished new one share
 * one natural key instead of splitting apart. The flattening is
 * {@link joinKeyParts}, which is injective whatever the values contain.
 */
function derivedKeyOf(parts: readonly (string | undefined)[]): string {
  if (parts.every((part) => part === undefined)) {
    return "";
  }
  return joinKeyParts(parts);
}

/**
 * What tells two failures reported in the same millisecond apart, and `""` when
 * the event offered nothing that does.
 *
 * Same shape and the same SQLite NULL-is-distinct reason as `attributionKeyOf`
 * — see `claude_code_error_event.occurrence_key`. It is derived HERE, from the
 * validated signal, so the key the normalizer refuses collisions on and the key
 * the row is stored under are one function.
 *
 * Spans ALL three kinds' distinguishing attributes, not just `api_error`'s. The
 * first five parts are what an `api_error` or `internal_error` carries; an
 * `api_refusal` carries NONE of them, so building the key from those alone gave
 * every refusal `""` and collapsed its natural key to
 * `(session, "api_refusal", observed_at, "")` — two refusals in one millisecond
 * then looked like one contradictory row and the second was dropped (tamsinb,
 * ISS-7352 review). The refusal taxonomy is appended so each kind contributes
 * what it actually has; an attribute a kind never emits contributes an empty
 * part and costs it nothing.
 */
export function errorOccurrenceKeyOf(
  event: ClaudeCodeErrorEventSignal
): string {
  return derivedKeyOf([
    event.attempt?.toString(),
    event.requestId,
    event.clientRequestId,
    event.errorName,
    event.errorCode,
    event.refusalCategory,
    event.serverFallbackHop?.toString(),
    event.hasCategory?.toString(),
    event.hasExplanation?.toString(),
  ]);
}

/**
 * What tells two MCP connection attempts in one millisecond apart —
 * `claude_code_mcp_server_connection.connection_key`.
 *
 * The server's configured NAME would be the natural discriminator, but Claude
 * Code only stamps `server_name` under `OTEL_LOG_TOOL_DETAILS=1` and ISS-7352's
 * capture list does not claim it, so this key is built from what every export
 * carries. Two attempts that agree on all of it in the same millisecond are
 * indistinguishable from what we captured, and the normalizer REFUSES the
 * second rather than letting the upsert overwrite the first.
 *
 * `isPlugin` is in the key on its own account, not as a weaker echo of
 * `pluginIdHash`. The hash is stamped only for a plugin-provided server, so
 * when it is absent — a plugin whose id the producer did not hash, or a plain
 * configured server — the boolean is the ONLY thing left distinguishing a
 * plugin-backed connection from a non-plugin one. Omitting it collapsed that
 * pair onto one key: the second was counted unusable in-batch, and a later
 * batch overwrote the survivor through the upsert (whitlockk, ISS-7352 review).
 */
export function mcpConnectionKeyOf(
  event: ClaudeCodeMcpServerConnectionSignal
): string {
  return derivedKeyOf([
    event.transportType,
    event.serverScope,
    event.isPlugin?.toString(),
    event.pluginIdHash,
    event.errorCode,
  ]);
}

/**
 * What tells two auth events at one instant apart —
 * `claude_code_auth_event.occurrence_key`.
 *
 * Every non-key attribute the event carries is folded in, so a collision here
 * means two records that agree on everything we captured. There is nothing left
 * for the collision check to compare, which is exactly why an identical repeat
 * collapses silently instead of being reported as a data problem.
 */
export function authOccurrenceKeyOf(event: ClaudeCodeAuthEventSignal): string {
  return derivedKeyOf([
    event.authMethod,
    event.success?.toString(),
    event.errorCategory,
    event.statusCode?.toString(),
  ]);
}

/**
 * Which plugin a lifecycle row is about — `claude_code_plugin_event.plugin_key`.
 *
 * Load-bearing rather than incidental: `plugin_loaded` fires once per enabled
 * plugin at session start, so a fleet with ten plugins emits ten records that
 * agree on session and instant and differ ONLY here. Without this in the
 * natural key the upsert would keep exactly one of them.
 */
export function pluginKeyOf(event: ClaudeCodePluginEventSignal): string {
  return derivedKeyOf([
    event.pluginName,
    event.pluginVersion,
    event.marketplaceName,
  ]);
}

/**
 * Which invocation a tool result belongs to — `claude_code_tool_result.result_key`.
 *
 * `tool_use_id` is the harness's own identifier for the invocation (the same one
 * it passes to hooks), so it identifies the row exactly when present. When the
 * producer omits it, two results for the same tool in one millisecond are
 * indistinguishable and the normalizer refuses the differing second rather than
 * overwriting.
 *
 * That refusal is per-EXPORT, which is this whole lane's dedup grain and not a
 * property of this key: the collision guards hold an in-memory map for one
 * batch, and across batches the natural key plus the upsert is the identity.
 * Two records that collide across separate exports therefore last-write-win, on
 * every table here and on the three that shipped in #5636. It is the right
 * default — an OTLP exporter retries a batch it did not see ACKed, so a repeat
 * is overwhelmingly a re-delivery — but a reader must not treat a row as proof
 * that no other record ever held its key.
 */
export function toolResultKeyOf(event: ClaudeCodeToolResultSignal): string {
  return derivedKeyOf([event.toolUseId]);
}
