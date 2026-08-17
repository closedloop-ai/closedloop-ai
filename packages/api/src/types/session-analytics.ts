/**
 * Wire contract for the two session-analytics surfaces: Lost work (ISS-4987,
 * loss measured in wall-clock) and TokenOps waste-vs-leverage (ISS-4988, the
 * same loss measured in dollars).
 *
 * The two are specified together on purpose. They must never disagree about
 * WHICH sessions failed, so both key failure on `SpendOutcome` — the canonical
 * classifier in `@closedloop-ai/loops-api/insights`, derived from exactly one field,
 * `SessionDetail.endsWithError`. Nothing in this module re-derives that
 * mapping; a second definition of "failed" is the defect both tickets exist to
 * prevent.
 *
 * Absent values are represented deliberately and are never fabricated:
 *   - a declared-nullable field (`baselineDeltaPts`) carries `null` to mean
 *     "settled, but too little data to say", which renders as a dash;
 *   - an absent OPTIONAL field is OMITTED rather than serialized as `null` or
 *     `0` (`confidencePct` on an ungraded model), per the repo's cross-repo
 *     compatibility rule;
 *   - a real `0` is a measurement and is always sent as `0`.
 * On surfaces whose subject is failure, a fabricated `0` reads as "no problem
 * here", which is the worst possible defect here.
 */

/**
 * How a lost session's cause is attributed. The classes are deliberately NEVER
 * summed into one headline "failure" number: an org-wide usage-limit event hits
 * everyone at once, so folding it into a person's rate points the surface at
 * whoever simply worked the most that day.
 */
export const LossClass = {
  /** Coachable. No platform cause recorded; the run errored or was abandoned. */
  Actionable: "actionable",
  /** Platform-caused. Rate limit, usage limit, or provider API error. */
  Systemic: "systemic",
  /** Cause not recorded. Never guessed into either side. */
  Unattributed: "unattributed",
} as const;
export type LossClass = (typeof LossClass)[keyof typeof LossClass];

export const LOSS_CLASS_LABELS: Record<LossClass, string> = {
  [LossClass.Actionable]: "Actionable",
  [LossClass.Systemic]: "Systemic",
  [LossClass.Unattributed]: "Unattributed",
};

export const LOSS_CLASS_ORDER: readonly LossClass[] = [
  LossClass.Actionable,
  LossClass.Systemic,
  LossClass.Unattributed,
];

/**
 * Behavioral causes, read off the terminal `AgentSessionState` a session landed
 * in when no throttle source was recorded. Derived, never stored as a second
 * taxonomy.
 */
export const BehavioralCause = {
  Abandoned: "abandoned",
  DeadEnded: "dead_ended",
} as const;
export type BehavioralCause =
  (typeof BehavioralCause)[keyof typeof BehavioralCause];

export const BEHAVIORAL_CAUSE_LABELS: Record<BehavioralCause, string> = {
  [BehavioralCause.Abandoned]: "Abandoned mid-run",
  [BehavioralCause.DeadEnded]: "Ended with error, no artifact",
};

/**
 * Which rollups a response actually resolved. A widget listed here SETTLED
 * without a value (its read failed); the surface renders a quiet dash and a
 * reason for it, never a zero and never a perpetual skeleton.
 */
export const LostWorkWidget = {
  Totals: "totals",
  Trend: "trend",
  People: "people",
  SystemicCauses: "systemicCauses",
  BehavioralCauses: "behavioralCauses",
  LostSessions: "lostSessions",
} as const;
export type LostWorkWidget =
  (typeof LostWorkWidget)[keyof typeof LostWorkWidget];

export const TokenOpsWidget = {
  Outcomes: "outcomes",
  Waste: "waste",
  Models: "models",
} as const;
export type TokenOpsWidget =
  (typeof TokenOpsWidget)[keyof typeof TokenOpsWidget];

export type LostWorkTotals = {
  sessionCount: number;
  totalMinutes: number;
  /** Minutes in sessions that DID yield an artifact. */
  productiveMinutes: number;
  minutesByClass: Record<LossClass, number>;
  sessionsByClass: Record<LossClass, number>;
};

/**
 * A daily bucket of lost wall-clock, in HOURS, per class.
 *
 * Deliberately NOT pre-rounded per bucket: rounding each of 30 daily buckets to
 * a tenth of an hour let the drift accumulate to minutes, so the charted series
 * no longer summed to the headline it is split from. Display rounding belongs
 * in the chart's value formatter.
 */
export type LostWorkTrendPoint = {
  date: string;
  values: Record<LossClass, number>;
};

export type LostWorkPersonRow = {
  userId: string;
  engineer: string;
  sessionCount: number;
  totalMinutes: number;
  actionableMinutes: number;
  actionableSessions: number;
  systemicMinutes: number;
  systemicSessions: number;
  unattributedMinutes: number;
  unattributedSessions: number;
  /** Actionable lost sessions as a share of everything this person ran. */
  actionableRatePct: number;
  /**
   * Change in actionable loss rate against THIS PERSON'S own earlier baseline,
   * in percentage points — never against the team, which would just rank
   * session volume. Explicitly nullable: `null` when either half holds too few
   * sessions to support a verdict, which renders as a dash with a reason and
   * never as a `0`. The null must survive the wire intact.
   */
  baselineDeltaPts: number | null;
  /** Human label of the cause that cost this person the most time. */
  dominantCause: string | null;
  /**
   * Class of `dominantCause`. Travels WITH the label so no render site can show
   * the cause without saying whether it was theirs to prevent — an unqualified
   * "Usage limit" under a person's name reads as something they did.
   */
  dominantCauseClass: LossClass;
};

/**
 * Display labels for the throttle sources that count as a platform-caused
 * failure. Lives here rather than beside the enum in `agent-session.ts` because
 * these are analytics presentation labels — and because that module is a
 * shrink-only grandfathered file.
 *
 * `SessionTraceThrottleSourceType.TokenSnapshot` is intentionally absent: it is
 * a usage sample, never a cause of loss, and is filtered out before any rollup
 * reaches this map.
 */
export const FAILURE_THROTTLE_SOURCE_LABELS: Record<string, string> = {
  provider_rate_limit: "Provider rate limit",
  usage_limit: "Usage limit",
  api_error: "Provider API error",
};

export type LostWorkCauseRow = {
  key: string;
  label: string;
  minutes: number;
  sessions: number;
};

export type LostWorkSessionRow = {
  id: string;
  title: string;
  engineer: string;
  repo: string;
  date: string;
  minutes: number;
  lossClass: LossClass;
  cause: string;
};

export type LostWorkInsightsResponse = {
  totals: LostWorkTotals;
  trend: LostWorkTrendPoint[];
  people: LostWorkPersonRow[];
  systemicCauses: LostWorkCauseRow[];
  behavioralCauses: LostWorkCauseRow[];
  lostSessions: LostWorkSessionRow[];
  /** Rollups that settled without a value. Empty when everything resolved. */
  unavailableWidgets: LostWorkWidget[];
};

/**
 * A model's fit for the work it is being handed. Graded against the FLEET, not
 * against magic absolutes: an absolute dollar threshold goes stale the moment
 * provider pricing moves, and it cannot tell "expensive" from "expensive for
 * what it is doing".
 */
export const ModelVerdict = {
  Overpowered: "overpowered",
  RightSized: "right_sized",
  Underpowered: "underpowered",
  /** Not a verdict. The honest answer when the sample is too thin to grade. */
  Ungraded: "ungraded",
} as const;
export type ModelVerdict = (typeof ModelVerdict)[keyof typeof ModelVerdict];

export const MODEL_VERDICT_LABELS: Record<ModelVerdict, string> = {
  [ModelVerdict.Overpowered]: "Over-powered for the work",
  [ModelVerdict.RightSized]: "Right-sized",
  [ModelVerdict.Underpowered]: "Under-powered, retry-heavy",
  [ModelVerdict.Ungraded]: "Not enough data",
};

export type SpendOutcomeRow = {
  /** A `SpendOutcome` from `@closedloop-ai/loops-api/insights`. Never re-derived here. */
  outcome: string;
  usd: number;
  sessions: number;
};

/**
 * The judgment half of the TokenOps screen, kept visibly separate from the
 * measured facts above it.
 *
 * Reported as a RANGE and never as a point value: we do not know how much of a
 * failed run's spend would have been re-spent anyway, and a single number reads
 * as a measurement. `excludedUnknownUsd` is load-bearing — outcome-unknown
 * spend never enters the estimate, and the amount excluded is stated on screen.
 */
export type RecoverableWasteEstimate = {
  /** Spend on sessions that ended with a recorded error and produced nothing. */
  errorOutcomeUsd: number;
  lowUsd: number;
  highUsd: number;
  sessions: number;
  /** Spend kept OUT of the estimate because the outcome was never recorded. */
  excludedUnknownUsd: number;
  /** The recovery assumption, sent with the estimate so the render site cannot restate it wrongly. */
  lowRate: number;
  highRate: number;
};

export type ModelRightSizingRow = {
  model: string;
  usd: number;
  errorOutcomeUsd: number;
  sessions: number;
  medianTokens: number;
  usdPerSession: number;
  verdict: ModelVerdict;
  /**
   * Share of this model's spend carrying the signal behind the verdict.
   * OMITTED for an ungraded model — there is no verdict to be confident about,
   * and a `0%` there would read as "we are certain it is wrong". Absent rather
   * than `null` so the omission survives any peer that reads this contract.
   */
  confidencePct?: number;
};

export type TokenOpsWasteInsightsResponse = {
  totalSpendUsd: number;
  outcomes: SpendOutcomeRow[];
  waste: RecoverableWasteEstimate;
  models: ModelRightSizingRow[];
  /**
   * Sessions a model needs in range before it is graded at all.
   *
   * On the wire rather than restated in the render, so the table can NAME the
   * number ("Needs 12 sessions to grade") instead of saying "too few sessions"
   * and leaving the reader to guess when that row will start getting a verdict.
   * A second copy at the render site is how the screen ends up quoting a
   * threshold the server no longer uses.
   */
  minGradedSessions: number;
  /** Rollups that settled without a value. Empty when everything resolved. */
  unavailableWidgets: TokenOpsWidget[];
};

/**
 * Log-event labels for the two standalone session-analytics routes.
 *
 * Deliberately NOT members of `InsightsSection`: that union drives the Insights
 * dashboard's exhaustive section maps (`SECTION_META`, the per-section loading
 * record) and the tile catalog, and these two are standalone pages rather than
 * dashboard tile sections. Adding them there would force every one of those
 * maps to grow an entry for a section that has no tiles.
 */
export const SessionAnalyticsSection = {
  LostWork: "lost_work",
  TokenOpsWaste: "tokenops_waste",
} as const;
export type SessionAnalyticsSection =
  (typeof SessionAnalyticsSection)[keyof typeof SessionAnalyticsSection];
