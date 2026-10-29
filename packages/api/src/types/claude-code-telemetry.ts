/**
 * ISS-10717 — the cloud READ contract for the synced Claude Code OTel corpus.
 *
 * Separate from `desktop-claude-code-telemetry-sync.ts` (the WRITE wire) because
 * the two answer different questions and have different compatibility rules: the
 * write contract is version-skewed across a deploy boundary, this one is served
 * by the same build that renders it.
 *
 * Two disciplines are encoded here rather than left to each caller:
 *
 * 1. **Unknown is not zero.** A signal family is reported as a
 *    {@link ClaudeCodeSignalReading}, which carries `recorded` beside `count`.
 *    `{ recorded: false, count: null }` means this machine never recorded the
 *    family — the beta-gated `claude_code_llm_request` is that case on every
 *    machine today — and `{ recorded: true, count: 0 }` is a measured zero.
 *    There is no shape that can express one as the other. ISS-11322 extends the
 *    same rule to the two value-bearing BREAKDOWNS it adds: a `null`
 *    `activeTime` is "never recorded on that machine" and an empty array is
 *    "recorded, and this session produced none".
 * 2. **Every cost names its ledger.** A session now has up to four costs from
 *    three different producers, and none is a second opinion of another. A cost
 *    is therefore never a bare number here: it is a
 *    {@link ClaudeCodeCostReading} carrying its {@link ClaudeCodeCostSource}.
 */

/** Whether this session has a Claude Code OTel corpus at all, and why not. */
export const ClaudeCodeTelemetryAvailability = {
  /** A rollup was synced for this session. */
  Recorded: "recorded",
  /**
   * The session's harness does not produce these signals. Codex, Cursor,
   * Copilot and OpenCode emit none, so nothing is missing — this is absence BY
   * HARNESS and must never render as a capture failure.
   */
  AbsentByHarness: "absent_by_harness",
  /**
   * A Claude Code session with no rollup synced: capture was off, the desktop
   * build predates the lane, or the delivery has not landed yet. Absence BY
   * FAILURE-OR-CONSENT, which is a different claim from the one above.
   */
  NotRecorded: "not_recorded",
} as const;
export type ClaudeCodeTelemetryAvailability =
  (typeof ClaudeCodeTelemetryAvailability)[keyof typeof ClaudeCodeTelemetryAvailability];

/**
 * Which ledger a cost came from. Each is a DIFFERENT producer with a different
 * pricing engine; summing or coalescing two of them blends accounting systems
 * (the ISS-4435 overlap ruling on ISS-7229).
 */
export const ClaudeCodeCostSource = {
  /** The harness's `claude_code_cost_event` counter, in USD. */
  HarnessCostEvent: "claude_code_cost_event",
  /**
   * The producer's own exact-integer cost from `claude_code_api_request`, in
   * millionths of a dollar. Reported in its native unit, not divided into a
   * float, because the integer IS the precision this ledger offers.
   */
  ProducerApiRequestMicros: "claude_code_api_request_cost_usd_micros",
  /** Our own pricing engine over collected tokens. */
  DesktopEstimate: "session_estimated_cost",
  /** Claude's own `result` envelope total. */
  HarnessResultEnvelope: "session_authoritative_cost_usd",
} as const;
export type ClaudeCodeCostSource =
  (typeof ClaudeCodeCostSource)[keyof typeof ClaudeCodeCostSource];

/** The unit a {@link ClaudeCodeCostReading} is denominated in. */
export const ClaudeCodeCostUnit = {
  Usd: "usd",
  UsdMicros: "usd_micros",
} as const;
export type ClaudeCodeCostUnit =
  (typeof ClaudeCodeCostUnit)[keyof typeof ClaudeCodeCostUnit];

/**
 * One cost, with the ledger that produced it.
 *
 * `value` is a decimal STRING so neither a `Decimal(14,6)` column nor an
 * exact-integer micros total is rounded through a JS float on the way out.
 */
export type ClaudeCodeCostReading = {
  source: ClaudeCodeCostSource;
  unit: ClaudeCodeCostUnit;
  value: string;
};

/**
 * One signal family's count, with whether it was ever recorded.
 *
 * `count` is `null` exactly when `recorded` is `false`. The pair, not the
 * number, is the value — see the note at the top of this file.
 */
export type ClaudeCodeSignalReading = {
  recorded: boolean;
  count: number | null;
};

/** The signal families the rollup counts. */
export type ClaudeCodeSignalReadings = {
  costEvents: ClaudeCodeSignalReading;
  apiRequests: ClaudeCodeSignalReading;
  errorEvents: ClaudeCodeSignalReading;
  permissionEvents: ClaudeCodeSignalReading;
  permissionModeChanges: ClaudeCodeSignalReading;
  mcpServerConnections: ClaudeCodeSignalReading;
  toolResults: ClaudeCodeSignalReading;
  llmRequests: ClaudeCodeSignalReading;
  /**
   * ISS-11322. These three are counts because for them a row count IS the
   * signal. The three families ISS-11322 also adds whose signal is a VALUE are
   * NOT here and never will be: they are {@link ClaudeCodeTelemetryResponse.activeTime},
   * {@link ClaudeCodeTelemetryResponse.linesOfCode} and
   * {@link ClaudeCodeTelemetryResponse.identity}. A count of any of the three
   * would be a different number wearing the same name, which is exactly why
   * ISS-10717 cut them rather than folding them in as counts.
   */
  authEvents: ClaudeCodeSignalReading;
  pluginEvents: ClaudeCodeSignalReading;
  sessionStarts: ClaudeCodeSignalReading;
};

/**
 * ISS-11322 — one activity type's summed seconds.
 *
 * `seconds` is a decimal STRING so a `Decimal(14,3)` column is not rounded
 * through a JS float on the way out, the same rule every cost here follows.
 */
export type ClaudeCodeActiveTimeReading = {
  activityType: string;
  seconds: string;
};

/**
 * ISS-11322 — one `(model, changeType)` pair's summed line count.
 *
 * `lineCount` is a decimal STRING because the column is a BIGINT and may exceed
 * `Number`, the same rule `droppedCount` follows.
 */
export type ClaudeCodeLinesOfCodeReading = {
  model: string;
  changeType: string;
  lineCount: string;
};

/**
 * ISS-11322 — the identity dimensions the harness stamped on the session.
 *
 * A `null` FIELD is a dimension the harness did not stamp. A `null` OBJECT is the
 * different and larger claim: the delivering machine has never recorded the
 * identity family at all. An all-null object therefore means "the family is
 * captured on that machine and no dimension is known for this session", which is a
 * measurement; the absent object is the absence of one. Collapsing the two is what
 * the stored `identityRecorded` flag exists to prevent — five NULL columns cannot
 * express the difference on their own.
 */
export type ClaudeCodeIdentityReading = {
  organizationId: string | null;
  identitySource: string | null;
  terminalType: string | null;
  appVersion: string | null;
  appEntrypoint: string | null;
};

/** One component's share of a session, as the harness attributed it. */
export type ClaudeCodeComponentReading = {
  attributionKey: string;
  attributionSource: string;
  agentName: string | null;
  skillName: string | null;
  pluginName: string | null;
  mcpServerName: string | null;
  mcpToolName: string | null;
  querySource: string | null;
  speed: string | null;
  effort: string | null;
  costEventCount: number;
  cost: ClaudeCodeCostReading | null;
};

/** One `(harness, reason)` drop counter from the recording machine. */
export type ClaudeCodeDropCounterReading = {
  harness: string;
  reason: string;
  /** A decimal string: the counter is a BIGINT and may exceed `Number`. */
  droppedCount: string;
  firstObservedAt: string;
  lastObservedAt: string;
};

/**
 * The completeness signal that travels with the corpus.
 *
 * `drops` is the machine-level counter set — the reason two of its three members
 * are machine-level rather than per-session is that the losses they count happen
 * before anything knows which session the signal belonged to.
 *
 * `complete` is TRUE only when a rollup was recorded, every counter is zero,
 * AND the component breakdown is whole (`componentsPartial` false) — three
 * conditions, because a truncated breakdown is a real shortfall even on a
 * machine that has dropped nothing. It is deliberately a conclusion the server
 * draws once, so two surfaces cannot draw it differently from the same rows.
 */
export type ClaudeCodeCompletenessReading = {
  complete: boolean;
  /**
   * The machine's drop counters FOR THIS SESSION'S HARNESS only.
   *
   * The counters are keyed by `(harness, reason)` and the table is shared, so an
   * unfiltered list would let a Codex export the receiver evicted mark every
   * Claude session on that machine incomplete — a shortfall attributed to data
   * it says nothing about.
   */
  drops: readonly ClaudeCodeDropCounterReading[];
  /**
   * True when the component breakdown is the top slice by cost rather than the
   * whole set. The rows returned are real; there are simply more of them than
   * one delivery can carry, and a reader must say so rather than present the
   * slice as the session's complete attribution.
   */
  componentsPartial: boolean;
  /**
   * ISS-11322: true when the active-time breakdown is a slice rather than the
   * whole set, for the same reason and with the same consequence as
   * `componentsPartial`. Its own flag rather than folded into that one, because a
   * reader looking at active time must not be told the shortfall is in the
   * component attribution, and vice versa.
   */
  activeTimePartial: boolean;
  /** True when the lines-of-code breakdown is a slice rather than the whole set. */
  linesOfCodePartial: boolean;
};

/** `GET /agent-sessions/[id]/claude-code-telemetry`. */
export type ClaudeCodeTelemetryResponse = {
  availability: ClaudeCodeTelemetryAvailability;
  /** The session's harness, always present — it is what AbsentByHarness means. */
  harness: string;
  /** The protocol version the delivering desktop spoke; null when not recorded. */
  protocolVersion: number | null;
  observedFrom: string | null;
  observedTo: string | null;
  signals: ClaudeCodeSignalReadings;
  /**
   * Every cost this session has, each naming its ledger. Empty for a session
   * with none; never a single unlabeled number.
   */
  costs: readonly ClaudeCodeCostReading[];
  components: readonly ClaudeCodeComponentReading[];
  /**
   * ISS-11322 — summed seconds per activity type.
   *
   * `null` means the recording machine has never recorded active time at all;
   * an EMPTY ARRAY means it records active time and this session produced none.
   * Those are different claims and no reader may collapse them — the same
   * distinction `ClaudeCodeSignalReading` draws for a count, drawn for a list.
   */
  activeTime: readonly ClaudeCodeActiveTimeReading[] | null;
  /** ISS-11322 — summed line count per `(model, changeType)`. See `activeTime`. */
  linesOfCode: readonly ClaudeCodeLinesOfCodeReading[] | null;
  /**
   * ISS-11322 — the session's identity dimensions, or `null` when the delivering
   * machine has never recorded the identity family. See
   * {@link ClaudeCodeIdentityReading} for why that is not the same as an
   * all-null object.
   */
  identity: ClaudeCodeIdentityReading | null;
  completeness: ClaudeCodeCompletenessReading;
};

/** Build a "never recorded" reading. */
export function unrecordedSignal(): ClaudeCodeSignalReading {
  return { recorded: false, count: null };
}

/**
 * Build a reading from a nullable stored count.
 *
 * `null` in the column is what the producer's OMISSION persisted, so it maps to
 * "never recorded" and not to zero.
 */
export function signalReadingOf(
  count: number | null | undefined
): ClaudeCodeSignalReading {
  if (count === null || count === undefined) {
    return unrecordedSignal();
  }
  return { recorded: true, count };
}
