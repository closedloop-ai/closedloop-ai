import { z } from "zod";

/**
 * ISS-10717 — the desktop→cloud Claude Code OTel telemetry WIRE contract.
 *
 * ISS-7352 shipped fourteen `claude_code_*` tables into desktop SQLite and every
 * one of them was write-only: the only readers were the writer itself and two
 * delete paths, and the sole derived value that reached cloud was the summed
 * scalar `session_detail.authoritative_cost_usd`. Every cloud surface therefore
 * reads this corpus as NOT CAPTURED even though it is captured. This module is
 * the contract the desktop lane POSTs and `/desktop/claude-code-telemetry/sync`
 * ingests.
 *
 * ── THE GRAIN DECISION (ISS-10717 AC 1) ─────────────────────────────────────
 * The choice was per-event rows, per-session rollups, or both. What ships is
 * **per-session rollups plus a per-COMPONENT breakdown**, and NOT per-event rows.
 *
 * - Per-event is the local grain and it is large: ISS-7352's own measurement was
 *   32,930 cost events on one machine. Shipping that grain would multiply the
 *   cloud's row count by the busiest table on every device, to serve questions
 *   that are almost never asked at that grain.
 * - A rollup ALONE would lose the drilldown that is the headline of this ticket.
 *   The harness stamps component attribution (`agent_name`, `skill_name`,
 *   `plugin_name`, `mcp_server_name`, `mcp_tool_name`, `query_source`, `speed`,
 *   `effort`) on every cost counter, and that is the answer to "which component
 *   burned this", which no cloud surface can currently give.
 * - So the component dimension is preserved as its own grain — one row per
 *   `(session, attribution_key)` — while everything else is counted per session.
 *   The raw per-event rows stay on the machine that recorded them and remain
 *   reachable there.
 *
 * ── UNKNOWN IS NOT ZERO (ISS-10717 AC 5) ────────────────────────────────────
 * Every count on {@link desktopClaudeCodeSessionTelemetrySchema} is OPTIONAL, and
 * the producer OMITS it when the signal family has never been recorded on this
 * machine. An omitted count means "this machine has never seen this signal", a
 * present `0` means "measured, and there were none for this session". They are
 * different claims and no reader may collapse them.
 *
 * This matters most for `llmRequestCount`: `claude_code_llm_request` is fed only
 * when `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`, which nothing in this repo sets,
 * so that table is structurally empty today. Emitting `0` there would state a
 * measured absence of LLM requests, which is false.
 *
 * ── TWO COST LEDGERS, BOTH NAMED (ISS-7352 Q2) ──────────────────────────────
 * Three costs now exist for one session and none of them is a second opinion of
 * another:
 *
 * - `session_detail.estimated_cost` — OUR pricing engine over collected tokens.
 * - `session_detail.authoritative_cost_usd` — Claude's own `result` envelope.
 * - the two carried here: {@link DesktopClaudeCodeSessionTelemetryInput.costEventUsd}
 *   (the harness's `claude_code_cost_event` counter) and
 *   {@link DesktopClaudeCodeSessionTelemetryInput.apiRequestCostUsdMicros} (the
 *   producer's own exact-integer cost, in millionths of a dollar).
 *
 * The read contract names the source of each. A reader that shows one without
 * saying which ledger it came from is the defect that ruling exists to prevent.
 *
 * ── HARNESS REACH (ISS-10717 AC 3) ──────────────────────────────────────────
 * Only Claude Code produces these signals. Codex, Cursor, Copilot and OpenCode
 * produce none, so `harness` is carried on the row and the read contract answers
 * absent-BY-HARNESS rather than absent-by-failure for them.
 *
 * ── VERSION SKEW (both directions) ──────────────────────────────────────────
 * This crosses a deploy boundary: desktop tags cut from `main` while the API
 * deploys from `production`.
 *
 * - OLDER DESKTOP → NEWER API. Every field is optional or defaulted, and the
 *   request schema is deliberately NOT `.strict()`: a NEWER desktop's unknown
 *   keys are ignored rather than rejecting the whole payload. That is the
 *   ISS-4976 / ISS-7795 lesson — a field added on top of an accepted version got
 *   rejected by a `.strict()` boundary as a permanent 400.
 * - NEWER DESKTOP → OLDER API. The route may not exist. The client reads
 *   404/410/501 as "protocol unavailable" and defers with its retry budget
 *   INTACT, so a desktop ahead of the API never dead-letters a healthy session.
 * - UNKNOWN `protocolVersion`. Answered with a RETRYABLE
 *   {@link DesktopClaudeCodeTelemetrySyncAckReason.ProtocolUnsupported}, never a
 *   validation failure, so a deployment skew cannot burn a row's budget.
 *
 * Absent optionals are OMITTED on the wire, never serialized as `null`.
 *
 * - ISS-11322 WIDENS THE FIELD SET AND BUMPS THE VERSION TO 2, and the reason is
 *   the WATERMARK rather than the parse. Being additive and optional is enough to
 *   keep an older API from REJECTING the payload — it drops the unknown keys and
 *   answers `accepted: true` — and that ack is exactly the problem: the desktop
 *   advances the session's cursor to the corpus-wide `MAX(observed)` across all
 *   fourteen families and stamps it with the CURRENT `DATA_REVISION`. The six
 *   families the old API silently dropped are then behind a watermark, at a
 *   revision that matches, so the invariant-7 re-walk can never re-admit that
 *   session either. The data is lost permanently with nothing red anywhere.
 *
 *   The bump converts that silent loss into the designed safe behaviour: an API
 *   that does not list 2 answers a RETRYABLE `ProtocolUnsupported`, the row's
 *   budget stays intact, and the session is delivered whole the moment the API
 *   deploys. Deferring for the length of a skew window is the correct cost here;
 *   it is not comparable to losing the payload. `1` stays in the supported SET so
 *   an older desktop is unaffected — the set is what the route checks, never an
 *   equality against the current version (the ISS-4976 defect).
 *
 *   The rule this establishes: a change is version-bearing when an older reader
 *   ACKNOWLEDGING it would advance a watermark past data it did not store, not
 *   only when it would misread a field it does know.
 *
 * ── TWO SHAPES OF DELIVERY ──────────────────────────────────────────────────
 * Ordinarily one session rollup with the machine's drop counters riding along.
 * The second shape is COUNTERS-ONLY, with `session` omitted, and it exists
 * because the counter can move when nothing else does: an export lost before any
 * signal row is persisted dirties no session, so a counters-as-passenger-only
 * lane would never deliver it and the cloud would keep reading that machine as
 * complete. Both shapes write the counters through the same path; only the
 * session half is conditional, and the ack omits `externalSessionId` when there
 * was no session to name.
 */

/**
 * The protocol version THIS build speaks.
 *
 * 2 as of ISS-11322. See the version-skew note above for why widening the field
 * set required a bump even though every added field is optional.
 */
export const DESKTOP_CLAUDE_CODE_TELEMETRY_SYNC_PROTOCOL_VERSION = 2;

/**
 * Every protocol version this build can INGEST. A SET, never an equality test
 * against the current version — the invocation lane's ISS-4976 defect was
 * exactly a single-scalar comparison rejecting its own producer's output once a
 * second version existed.
 */
export const SUPPORTED_DESKTOP_CLAUDE_CODE_TELEMETRY_SYNC_PROTOCOL_VERSIONS: readonly number[] =
  [1, 2];

/** True when `value` is a protocol version this build can ingest. */
export function isSupportedDesktopClaudeCodeTelemetrySyncProtocolVersion(
  value: unknown
): value is number {
  return (
    typeof value === "number" &&
    SUPPORTED_DESKTOP_CLAUDE_CODE_TELEMETRY_SYNC_PROTOCOL_VERSIONS.includes(
      value
    )
  );
}

/** Request-body byte cap for `/desktop/claude-code-telemetry/sync`. */
export const DESKTOP_CLAUDE_CODE_TELEMETRY_SYNC_REQUEST_MAX_BYTES = 262_144;

/**
 * Components one request may carry for a single session. Bounds ONE request; the
 * lane pages the rest behind its cursor, so this never caps how much attribution
 * can eventually sync.
 */
export const DESKTOP_CLAUDE_CODE_TELEMETRY_MAX_COMPONENTS_PER_REQUEST = 200;

/** Drop-counter rows one request may carry. Bounded by `(harness, reason)`. */
export const DESKTOP_CLAUDE_CODE_TELEMETRY_MAX_DROP_COUNTERS_PER_REQUEST = 32;

/**
 * Active-time rows one request may carry, keyed by `activity_type`.
 *
 * The harness emits a small closed-ish set of activity types, so this is a
 * ceiling against an unbounded dimension rather than an expected cut — but it is
 * a REAL cap and a request that hits it says so through
 * {@link DesktopClaudeCodeSessionTelemetryInput.activeTimeTruncated} instead of
 * presenting the slice as the session's whole active time.
 */
export const DESKTOP_CLAUDE_CODE_TELEMETRY_MAX_ACTIVE_TIME_ROWS = 32;

/**
 * Lines-of-code rows one request may carry, keyed by `(model, change_type)`.
 *
 * Larger than the active-time cap because `model` is open: a long-lived session
 * can touch several models and each carries its own change types. Hitting it
 * sets {@link DesktopClaudeCodeSessionTelemetryInput.linesOfCodeTruncated}.
 */
export const DESKTOP_CLAUDE_CODE_TELEMETRY_MAX_LINES_OF_CODE_ROWS = 100;

/** Cap on any free-text identifier crossing this boundary. */
export const CLAUDE_CODE_TELEMETRY_TEXT_MAX = 512;

/**
 * Why the server declined a sync. Split so the desktop can tell a
 * ROW-attributable rejection (which may burn the row's budget) from a LANE-WIDE
 * one (which must not) — invariant 4 in `apps/desktop/src/main/sync/AGENTS.md`.
 */
export const DesktopClaudeCodeTelemetrySyncAckReason = {
  /** Row-attributable: the payload itself is invalid. Burns budget. */
  ValidationFailed: "validation_failed",
  /** Lane-wide: this compute target / org may not sync. Budget intact. */
  Forbidden: "forbidden",
  /** Lane-wide: throttled. Budget intact. */
  RateLimited: "rate_limited",
  /** Lane-wide: the server could not say why it failed. Budget intact. */
  IngestionFailed: "ingestion_failed",
  /**
   * Lane-wide: the server does not speak this payload's `protocolVersion`.
   * Retryable on purpose — a skew is a property of the deployment, not the row.
   */
  ProtocolUnsupported: "protocol_unsupported",
  /**
   * Row-attributable and TERMINAL: no session with this
   * `(computeTargetId, externalSessionId)` exists in the cloud. The session lane
   * is what creates it, and it runs independently, so this is ordinary and must
   * not be read as a failure — the row defers and the session lane's own
   * delivery is what resolves it.
   */
  SessionNotFound: "session_not_found",
} as const;
export type DesktopClaudeCodeTelemetrySyncAckReason =
  (typeof DesktopClaudeCodeTelemetrySyncAckReason)[keyof typeof DesktopClaudeCodeTelemetrySyncAckReason];

/** Coded error envelope values the route returns alongside its HTTP status. */
export const DesktopClaudeCodeTelemetrySyncErrorCode = {
  ValidationFailed: "claude_code_telemetry_sync_validation_failed",
  Forbidden: "claude_code_telemetry_sync_forbidden",
  RateLimited: "claude_code_telemetry_sync_rate_limited",
  IngestionFailed: "claude_code_telemetry_sync_ingestion_failed",
  ProtocolUnsupported: "claude_code_telemetry_sync_protocol_unsupported",
  InternalError: "claude_code_telemetry_sync_internal_error",
} as const;
export type DesktopClaudeCodeTelemetrySyncErrorCode =
  (typeof DesktopClaudeCodeTelemetrySyncErrorCode)[keyof typeof DesktopClaudeCodeTelemetrySyncErrorCode];

/**
 * Why a signal was lost on the recording machine. Mirrors the desktop's
 * `ClaudeCodeSignalDropReason`; a bare bounded string on the wire rather than a
 * `z.enum` so a NEWER desktop's reason does not fail the element, which would
 * fail the array, which would fail the whole payload over a word.
 */
export const ClaudeCodeTelemetryDropReason = {
  ReceiverBackpressure: "receiver_backpressure",
  NormalizerUnusable: "normalizer_unusable",
  PersistenceRejected: "persistence_rejected",
  /**
   * ISS-7481: two DIFFERING records reduced to one stored row because they
   * share a natural key — the `tool_decision` overwrite path. Its own reason
   * rather than folded into `normalizer_unusable`, because the disclosure is
   * different: the table is a LOWER BOUND on real events, not a table that
   * failed to read one.
   */
  NaturalKeyCollision: "natural_key_collision",
} as const;
export type ClaudeCodeTelemetryDropReason =
  (typeof ClaudeCodeTelemetryDropReason)[keyof typeof ClaudeCodeTelemetryDropReason];

/** A non-negative count that must be a real integer to be accepted. */
const countSchema = z.number().int().nonnegative();

/**
 * One component's share of a session, keyed by the harness's own
 * `attribution_key`. The name columns are each nullable because the harness
 * stamps whichever dimensions apply — a skill invocation has no `mcp_tool_name`.
 */
/**
 * A USD amount the cloud stores in a `Decimal(14,6)` column.
 *
 * SHAPED, not merely length-capped, and the difference is a 500 rather than a
 * 400. These strings land straight in `Decimal(14,6)`; a value Prisma cannot
 * convert — a word, an exponent form, more than eight integer digits — throws
 * INSIDE the ingest service, which the route answers as `IngestionFailed` 500.
 * The desktop client reads any 5xx as a lane-wide `retry`, so the same payload
 * returns to the head of an oldest-owed-first queue every tick, forever, with no
 * budget spent and the rest of the corpus stuck behind it. Refusing the value
 * here makes it a 400 instead: session-attributable, bounded by the rejection
 * budget, and the lane moves on. `droppedCount` and `apiRequestCostUsdMicros`
 * already carry their own shape for the same reason.
 *
 * The domain is the column's: up to eight integer digits, up to six fractional,
 * non-negative. A cost cannot be negative, so a leading `-` is part of the
 * impossible set and is refused rather than rounded away.
 */
export const CLAUDE_CODE_USD_DECIMAL_PATTERN = /^\d{1,8}(?:\.\d{1,6})?$/;
/** Fractional digits `Decimal(14,6)` holds. */
export const CLAUDE_CODE_USD_DECIMAL_PLACES = 6;
/** One past the largest eight-integer-digit amount the column can hold. */
export const CLAUDE_CODE_MAX_USD_EXCLUSIVE = 100_000_000;
const usdDecimalSchema = z
  .string()
  .max(CLAUDE_CODE_TELEMETRY_TEXT_MAX)
  .regex(CLAUDE_CODE_USD_DECIMAL_PATTERN);

export const desktopClaudeCodeComponentTelemetrySchema = z.object({
  attributionKey: z.string().max(CLAUDE_CODE_TELEMETRY_TEXT_MAX),
  /**
   * Which producer supplied the attribution, so a later disagreement with
   * transcript-derived attribution is diagnosable instead of invisible.
   */
  attributionSource: z.string().max(CLAUDE_CODE_TELEMETRY_TEXT_MAX),
  agentName: z.string().max(CLAUDE_CODE_TELEMETRY_TEXT_MAX).optional(),
  skillName: z.string().max(CLAUDE_CODE_TELEMETRY_TEXT_MAX).optional(),
  pluginName: z.string().max(CLAUDE_CODE_TELEMETRY_TEXT_MAX).optional(),
  mcpServerName: z.string().max(CLAUDE_CODE_TELEMETRY_TEXT_MAX).optional(),
  mcpToolName: z.string().max(CLAUDE_CODE_TELEMETRY_TEXT_MAX).optional(),
  querySource: z.string().max(CLAUDE_CODE_TELEMETRY_TEXT_MAX).optional(),
  speed: z.string().max(CLAUDE_CODE_TELEMETRY_TEXT_MAX).optional(),
  effort: z.string().max(CLAUDE_CODE_TELEMETRY_TEXT_MAX).optional(),
  costEventCount: countSchema,
  /** Summed `claude_code_cost_event.cost_usd` for this component, as a string. */
  costUsd: usdDecimalSchema.optional(),
});
export type DesktopClaudeCodeComponentTelemetryInput = z.input<
  typeof desktopClaudeCodeComponentTelemetrySchema
>;

/** Decimal digits, and nothing else. */
export const CLAUDE_CODE_BIGINT_TEXT_PATTERN = /^\d+$/;

/** The largest value a PostgreSQL `BIGINT` column holds. */
export const CLAUDE_CODE_MAX_BIGINT = 9_223_372_036_854_775_807n;

/**
 * A non-negative magnitude the target `BIGINT` column can actually hold.
 *
 * BOUNDED BY THE COLUMN, not by a digit count. A 40-digit cap accepted
 * `9223372036854775808`, which parsed cleanly, reached the upsert, and threw
 * INSIDE the ingest service — a 5xx the desktop reads as a lane-wide retry, so
 * the same payload returns to the head of an oldest-owed-first queue forever.
 * Refused here it is a session-attributable 400 that costs one session, which is
 * the same trade {@link secondsDecimalSchema} already makes for its column.
 */
const bigIntTextSchema = z
  .string()
  .max(CLAUDE_CODE_TELEMETRY_TEXT_MAX)
  .regex(CLAUDE_CODE_BIGINT_TEXT_PATTERN)
  .refine((value) => BigInt(value) <= CLAUDE_CODE_MAX_BIGINT, {
    message: "exceeds the BIGINT column range",
  });

/**
 * One `(harness, reason)` drop counter as the recording machine holds it.
 *
 * `droppedCount` is carried as a STRING because it is a SQLite `BIGINT` and a
 * machine that has been dropping for a long time can exceed the safe-integer
 * range; parsing it into a JS number at the boundary would silently round the
 * completeness figure.
 */
export const desktopClaudeCodeDropCounterSchema = z.object({
  harness: z.string().max(CLAUDE_CODE_TELEMETRY_TEXT_MAX),
  reason: z.string().max(CLAUDE_CODE_TELEMETRY_TEXT_MAX),
  droppedCount: bigIntTextSchema,
  firstObservedAt: z.string().max(CLAUDE_CODE_TELEMETRY_TEXT_MAX),
  lastObservedAt: z.string().max(CLAUDE_CODE_TELEMETRY_TEXT_MAX),
});
export type DesktopClaudeCodeDropCounterInput = z.input<
  typeof desktopClaudeCodeDropCounterSchema
>;

/**
 * A SECONDS amount the cloud stores in a `Decimal(14,3)` column.
 *
 * Shaped for the same reason as {@link usdDecimalSchema}: the string lands
 * straight in the column, and a value Prisma cannot convert throws INSIDE the
 * ingest service, which the route answers as a 5xx the desktop reads as a
 * lane-wide retry — the same payload returning to the head of an
 * oldest-owed-first queue forever. Refusing it here makes it a
 * session-attributable 400 instead.
 *
 * `claude_code_active_time.seconds` is a duration, so a negative one is part of
 * the impossible set and is refused rather than rounded away.
 */
export const CLAUDE_CODE_SECONDS_DECIMAL_PATTERN = /^\d{1,11}(?:\.\d{1,3})?$/;
/** Fractional digits `Decimal(14,3)` holds. */
export const CLAUDE_CODE_SECONDS_DECIMAL_PLACES = 3;
/** One past the largest eleven-integer-digit duration the column can hold. */
export const CLAUDE_CODE_MAX_SECONDS_EXCLUSIVE = 100_000_000_000;
const secondsDecimalSchema = z
  .string()
  .max(CLAUDE_CODE_TELEMETRY_TEXT_MAX)
  .regex(CLAUDE_CODE_SECONDS_DECIMAL_PATTERN);

/**
 * ISS-11322 — one activity type's summed seconds for a session.
 *
 * SECONDS, NOT A ROW COUNT, and the grain is per `activity_type` rather than one
 * blended total. `claude_code_active_time` separates user seconds from CLI
 * seconds, which are two different measurements of the session; summing them
 * would publish one number under a name that fits neither, and a count of
 * activity rows would be a third number wearing the word "active time".
 */
export const desktopClaudeCodeActiveTimeTelemetrySchema = z.object({
  activityType: z.string().max(CLAUDE_CODE_TELEMETRY_TEXT_MAX),
  /** Summed `claude_code_active_time.seconds` for this activity type. */
  seconds: secondsDecimalSchema,
});
export type DesktopClaudeCodeActiveTimeTelemetryInput = z.input<
  typeof desktopClaudeCodeActiveTimeTelemetrySchema
>;

/**
 * ISS-11322 — one `(model, change_type)` pair's summed line count.
 *
 * BROKEN OUT, not summed into one scalar, for the same reason the component
 * grain exists: `claude_code_lines_of_code` is keyed by `model` and
 * `change_type`, and lines ADDED by one model and lines REMOVED by another are
 * not addends of any quantity a reader asks for. One total would be the sum of
 * two opposite-signed magnitudes reported as a single positive number.
 *
 * `lineCount` is a STRING because the column is a SQLite `BIGINT` and a
 * long-lived machine can exceed the safe-integer range; parsing it into a JS
 * number at the boundary would silently round it.
 */
export const desktopClaudeCodeLinesOfCodeTelemetrySchema = z.object({
  model: z.string().max(CLAUDE_CODE_TELEMETRY_TEXT_MAX),
  changeType: z.string().max(CLAUDE_CODE_TELEMETRY_TEXT_MAX),
  lineCount: bigIntTextSchema,
});
export type DesktopClaudeCodeLinesOfCodeTelemetryInput = z.input<
  typeof desktopClaudeCodeLinesOfCodeTelemetrySchema
>;

/**
 * ISS-11322 — the DIMENSIONS `claude_code_session_identity` carries.
 *
 * NOT A COUNT, and it could never have been one: that table is `@id` on
 * `session_id`, so its count is 0 or 1 and means only "did the harness stamp an
 * identity", which no reader asks. What is worth carrying is the four dimensions
 * ISS-11322 names — the org, the app version, the entrypoint, the terminal —
 * plus `identitySource`, the provenance that makes a later disagreement
 * diagnosable rather than invisible.
 *
 * `user_account_uuid` and `user_account_id` are deliberately NOT carried. They
 * are the two columns of that table which identify a PERSON rather than describe
 * the run, ISS-11322's own enumeration of what is worth carrying excludes them,
 * and moving an end-user account identifier across this boundary is a privacy
 * decision for a human rather than a side effect of widening a telemetry rollup.
 * They stay on the machine that recorded them and remain reachable there.
 *
 * Every field is optional because every source column is nullable: the harness
 * stamps whichever dimensions it knows.
 *
 * ── THREE STATES, THE SAME AS THE TWO ARRAYS ────────────────────────────────
 * - The field is OMITTED when this machine has never recorded the identity family
 *   at all. The ingest then writes nothing and clears nothing: an omission is not
 *   a measurement, and a machine whose identity rows have aged out of the desktop
 *   retention window must not wipe dimensions the cloud already holds.
 * - It is PRESENT AND EMPTY (`{}`) when the family IS recorded here and no
 *   dimension value is known for this session.
 * - It is PRESENT WITH VALUES when the harness stamped them.
 *
 * `{}` deliberately covers two source situations — the session has no identity row,
 * and it has one whose every dimension is null — because they are the same claim
 * about the session ("the family is captured here and no dimension is known") and
 * neither is a measurement of anything a reader asks for. What `{}` must never be
 * confused with is the OMITTED case, which is a claim about the MACHINE.
 */
export const desktopClaudeCodeSessionIdentityTelemetrySchema = z.object({
  organizationId: z.string().max(CLAUDE_CODE_TELEMETRY_TEXT_MAX).optional(),
  identitySource: z.string().max(CLAUDE_CODE_TELEMETRY_TEXT_MAX).optional(),
  terminalType: z.string().max(CLAUDE_CODE_TELEMETRY_TEXT_MAX).optional(),
  appVersion: z.string().max(CLAUDE_CODE_TELEMETRY_TEXT_MAX).optional(),
  appEntrypoint: z.string().max(CLAUDE_CODE_TELEMETRY_TEXT_MAX).optional(),
});
export type DesktopClaudeCodeSessionIdentityTelemetryInput = z.input<
  typeof desktopClaudeCodeSessionIdentityTelemetrySchema
>;

/**
 * The per-session rollup.
 *
 * EVERY count is optional, and an omitted one means "this machine has never
 * recorded this signal family" — see the UNKNOWN IS NOT ZERO note above. The
 * producer omits rather than sending `0` whenever the family's local table has
 * never held a row.
 */
export const desktopClaudeCodeSessionTelemetrySchema = z.object({
  /** The desktop's own session id, joined to `session_detail`. */
  externalSessionId: z.string().min(1).max(CLAUDE_CODE_TELEMETRY_TEXT_MAX),
  /**
   * The harness that produced the session. Recorded so a cloud reader can answer
   * absent-BY-HARNESS for a Codex or Copilot session instead of reporting a
   * capture failure.
   */
  harness: z.string().max(CLAUDE_CODE_TELEMETRY_TEXT_MAX),
  costEventCount: countSchema.optional(),
  apiRequestCount: countSchema.optional(),
  errorEventCount: countSchema.optional(),
  permissionEventCount: countSchema.optional(),
  permissionModeChangeCount: countSchema.optional(),
  mcpServerConnectionCount: countSchema.optional(),
  toolResultCount: countSchema.optional(),
  /**
   * ISS-11322. For these three families a ROW COUNT IS the signal — an auth
   * event, a plugin lifecycle event and a session start are each one occurrence
   * — so they take the same shape as the eight above. The three families whose
   * signal is a VALUE (`activeTime`, `linesOfCode`, `identity`) are carried
   * below as that value and have no count field on purpose: a count of them
   * would be a different number wearing the same name.
   */
  authEventCount: countSchema.optional(),
  pluginEventCount: countSchema.optional(),
  sessionStartCount: countSchema.optional(),
  /**
   * Beta-gated (`CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`). Omitted on every
   * machine that has never enabled it, which is all of them today — NOT `0`,
   * which would assert a measured absence of LLM requests.
   */
  llmRequestCount: countSchema.optional(),
  /** Summed `claude_code_cost_event.cost_usd`, decimal string. */
  costEventUsd: usdDecimalSchema.optional(),
  /**
   * Summed `claude_code_api_request.cost_usd_micros` — the producer's own
   * exact-integer cost, in millionths of a dollar. A string for the same
   * safe-integer reason as `droppedCount`.
   */
  apiRequestCostUsdMicros: z.string().regex(/^\d+$/).max(40).optional(),
  observedFrom: z.string().max(CLAUDE_CODE_TELEMETRY_TEXT_MAX).optional(),
  observedTo: z.string().max(CLAUDE_CODE_TELEMETRY_TEXT_MAX).optional(),
  components: z
    .array(desktopClaudeCodeComponentTelemetrySchema)
    .max(DESKTOP_CLAUDE_CODE_TELEMETRY_MAX_COMPONENTS_PER_REQUEST)
    .default([]),
  /**
   * True when this session has MORE components than one request may carry, so
   * `components` is the top slice by cost rather than the whole set.
   *
   * Load-bearing on the ingest side: the component write replaces the set it is
   * given, and replacing a partial list would DELETE the tail the producer could
   * not send — turning a bounded payload into permanent cloud-side loss. The
   * flag is what lets the ingest keep what it already holds, and what lets a
   * reader say the breakdown is partial instead of reading it as complete.
   *
   * Omitted (not `false`) when the page is whole, per the omission rule above.
   */
  componentsTruncated: z.boolean().optional(),
  /**
   * ISS-11322 — summed seconds per activity type.
   *
   * NO `.default([])`, unlike `components`, and the difference is the whole
   * unknown-is-not-zero rule applied to an ARRAY. An OMITTED `activeTime` means
   * this machine has never recorded active time at all; a PRESENT `[]` means it
   * records active time and this session produced none. A default would collapse
   * the first into the second and the ingest could no longer tell "leave what
   * you hold alone" from "this session measurably has none".
   */
  activeTime: z
    .array(desktopClaudeCodeActiveTimeTelemetrySchema)
    .max(DESKTOP_CLAUDE_CODE_TELEMETRY_MAX_ACTIVE_TIME_ROWS)
    .optional(),
  /**
   * True when this session has MORE activity types than one request may carry,
   * so `activeTime` is a slice. Load-bearing on the ingest side for the same
   * reason as `componentsTruncated`: replacing a partial list would DELETE the
   * tail the producer could not send. Omitted (not `false`) when whole.
   */
  activeTimeTruncated: z.boolean().optional(),
  /** ISS-11322 — summed line counts per `(model, changeType)`. See `activeTime`. */
  linesOfCode: z
    .array(desktopClaudeCodeLinesOfCodeTelemetrySchema)
    .max(DESKTOP_CLAUDE_CODE_TELEMETRY_MAX_LINES_OF_CODE_ROWS)
    .optional(),
  /** True when `linesOfCode` is a slice rather than the whole set. */
  linesOfCodeTruncated: z.boolean().optional(),
  /**
   * ISS-11322 — the session's identity dimensions, when the harness stamped
   * them. Omitted rather than sent as an all-undefined object, so a reader can
   * tell "no identity was recorded" from "an identity row exists and every
   * dimension in it was null".
   */
  identity: desktopClaudeCodeSessionIdentityTelemetrySchema.optional(),
});
export type DesktopClaudeCodeSessionTelemetryInput = z.input<
  typeof desktopClaudeCodeSessionTelemetrySchema
>;

/**
 * The request envelope. NOT `.strict()` — see the version-skew note above.
 *
 * `protocolVersion` is DEFAULTED so a build that predates the field still
 * parses; the route validates the parsed value against the supported set
 * separately and answers a retryable `ProtocolUnsupported` for anything else.
 */
export const desktopClaudeCodeTelemetrySyncRequestSchema = z
  .object({
    protocolVersion: z
      .number()
      .int()
      .default(DESKTOP_CLAUDE_CODE_TELEMETRY_SYNC_PROTOCOL_VERSION),
    /**
     * The session rollup, when this delivery carries one.
     *
     * OPTIONAL so the machine-level drop counters below have a delivery of their
     * own. A loss that happens before any signal row is persisted — a receiver
     * eviction, a wholly unusable export, an all-rejected batch — moves a
     * counter and dirties no session, so a lane that can only send counters as a
     * passenger never sends them at all and the cloud reads that machine as
     * complete. Relaxing a REQUIREMENT is additive for every existing producer:
     * an older desktop always sends this field, so it cannot be affected, and a
     * counters-only body is only ever produced by a build that has this comment
     * in it.
     */
    session: desktopClaudeCodeSessionTelemetrySchema.optional(),
    /**
     * The machine-level completeness counters. Carried with EVERY session payload
     * rather than on its own lane, so the completeness signal travels with the
     * data it qualifies and a reader never has to join two deliveries that may
     * have arrived at different times. A counters-only delivery is the exception
     * and exists only for the case above, where there is no session to ride.
     */
    dropCounters: z
      .array(desktopClaudeCodeDropCounterSchema)
      .max(DESKTOP_CLAUDE_CODE_TELEMETRY_MAX_DROP_COUNTERS_PER_REQUEST)
      .default([]),
  })
  // An envelope naming neither a session nor a counter asks for no write at all.
  // Refused here so the route answers a session-attributable 400 rather than
  // acknowledging a delivery that stored nothing; unreachable from any producer,
  // since an older build always sends `session` and a newer one only omits it to
  // carry counters.
  .refine(
    (value) => value.session !== undefined || value.dropCounters.length > 0,
    { message: "a delivery must carry a session, a drop counter, or both" }
  );
export type DesktopClaudeCodeTelemetrySyncRequest = z.infer<
  typeof desktopClaudeCodeTelemetrySyncRequestSchema
>;

export type DesktopClaudeCodeTelemetrySyncAck = {
  accepted: boolean;
  protocolVersion: number;
  /**
   * Which session was acknowledged. OMITTED on a COUNTERS-ONLY delivery, which
   * names no session — see the `session` field on the request envelope.
   */
  externalSessionId?: string;
  componentsRecorded?: number;
  dropCountersRecorded?: number;
  reason?: DesktopClaudeCodeTelemetrySyncAckReason | string;
};

/**
 * What the server acknowledges.
 *
 * Not `.strict()`: a NEWER server may add fields and an ack must not be thrown
 * away because this build does not know one. The converse is what the
 * `satisfies` guard is for — Zod STRIPS what the schema does not name, so a
 * field added to the type and forgotten here would be silently deleted at the
 * client's parse boundary and the ack would still look perfectly valid.
 */
export const desktopClaudeCodeTelemetrySyncAckSchema = z.object({
  accepted: z.boolean(),
  protocolVersion: z.number(),
  externalSessionId: z.string().optional().catch(undefined),
  componentsRecorded: countSchema.optional().catch(undefined),
  dropCountersRecorded: countSchema.optional().catch(undefined),
  reason: z.string().optional().catch(undefined),
} satisfies Record<keyof DesktopClaudeCodeTelemetrySyncAck, z.ZodTypeAny>);

/** The `/desktop/claude-code-telemetry/sync` success body. */
export type DesktopClaudeCodeTelemetrySyncResponse =
  DesktopClaudeCodeTelemetrySyncAck;
