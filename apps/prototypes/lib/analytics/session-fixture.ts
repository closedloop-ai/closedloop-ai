/**
 * ONE mock session population, shared by the two analytics prototypes
 * (`lost-work` and `tokenops-waste`).
 *
 * The point of sharing it: ISS-4935 measures loss in wall-clock and ISS-4977
 * measures it in dollars, and the two must never disagree about WHICH sessions
 * failed. Deriving both screens from this single fixture makes that structural
 * rather than a promise, and the prototypes' tests assert it.
 *
 * Field names and vocabulary mirror the real signals so the production build is
 * a straight port:
 *   - `endsWithError` -> `AgentSession.endsWithError` (Boolean?, nullable)
 *   - `state`         -> `AgentSessionState` (FEA-4287 split Error/Abandoned
 *                        out of Blocked so terminal failure is distinguishable)
 *   - `throttleSource`-> `SessionTraceThrottleSourceType`
 * The prototype sandbox cannot import `@repo/api` (dependency boundary), so the
 * const objects below are mirrors, not a second source of truth. The production
 * build imports the real ones from `packages/api/src/types/agent-session.ts`.
 */

/** Mirror of `SessionTraceThrottleSourceType` (agent-session.ts:1366). */
export const ThrottleSource = {
  ProviderRateLimit: "provider_rate_limit",
  UsageLimit: "usage_limit",
  ApiError: "api_error",
} as const;
export type ThrottleSource =
  (typeof ThrottleSource)[keyof typeof ThrottleSource];

/** Mirror of the terminal members of `AgentSessionState` (agent-session.ts:366). */
export const SessionState = {
  Completed: "COMPLETED",
  Error: "ERROR",
  Abandoned: "ABANDONED",
} as const;
export type SessionState = (typeof SessionState)[keyof typeof SessionState];

/**
 * Mirror of `SpendOutcome` (`@closedloop-ai/loops-api/insights`) and its labels, the
 * vocabulary PR #4282 / ISS-4463 landed. Both prototypes key failure off this
 * and nothing else, so neither invents a second definition of "failed".
 *
 * `Unknown` is a distinct fact from `Clean`: `endsWithError` is nullable and a
 * null genuinely means no outcome was ever recorded. Folding it into `Clean`
 * would overstate healthy work; folding it into `Errored` would invent loss
 * that was never observed.
 */
export const SpendOutcome = {
  Clean: "clean",
  Errored: "errored",
  Unknown: "unknown",
} as const;
export type SpendOutcome = (typeof SpendOutcome)[keyof typeof SpendOutcome];

export const SPEND_OUTCOME_LABELS: Record<SpendOutcome, string> = {
  [SpendOutcome.Clean]: "Ended clean",
  [SpendOutcome.Errored]: "Ended with error",
  [SpendOutcome.Unknown]: "Outcome unknown",
};

export const SPEND_OUTCOME_ORDER: readonly SpendOutcome[] = [
  SpendOutcome.Clean,
  SpendOutcome.Errored,
  SpendOutcome.Unknown,
];

/**
 * How a lost session's cause is attributed. The classes are deliberately NEVER
 * summed into one headline "failure" number: an org-wide usage-limit event hits
 * everyone, so folding it into a person's rate points the dashboard at whoever
 * simply worked the most that day.
 */
export const LossClass = {
  /** Coachable. No platform cause; the session was abandoned or dead-ended. */
  Actionable: "actionable",
  /** Platform-caused. Rate limit, usage limit, provider/API error. */
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

export const THROTTLE_SOURCE_LABELS: Record<ThrottleSource, string> = {
  [ThrottleSource.ProviderRateLimit]: "Provider rate limit",
  [ThrottleSource.UsageLimit]: "Usage limit",
  [ThrottleSource.ApiError]: "Provider API error",
};

/**
 * Behavioral causes. Not a new taxonomy over the wire: these are read off the
 * terminal `AgentSessionState` a session landed in when no throttle source was
 * recorded, so the production build derives them rather than storing them.
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

export type MockSession = {
  id: string;
  title: string;
  engineer: string;
  repo: string;
  project: string;
  /** Bucket date, YYYY-MM-DD. */
  date: string;
  /** Wall-clock the session consumed. */
  wallClockMinutes: number;
  /** `AgentSession.endsWithError` — nullable, so null is "never recorded". */
  endsWithError: boolean | null;
  state: SessionState;
  /** A session that yielded a PR, commit, or document. */
  producedArtifact: boolean;
  throttleSource: ThrottleSource | null;
  model: string;
  costUsd: number;
  /** Total tokens billed for the session. */
  tokens: number;
};

export const ENGINEERS: readonly string[] = [
  "Dana Whitaker",
  "Marcus Iyer",
  "Priya Raman",
  "Tom Ferreira",
  "Alexis Chen",
  "Sam Okonkwo",
];

export const REPOS: readonly string[] = [
  "symphony-alpha",
  "relay-host",
  "closedloop-docs",
  "harness-cli",
];

export const PROJECTS: readonly string[] = [
  "Sessions & Branches",
  "Desktop gateway",
  "Docs refresh",
  "Cost engine",
];

export const MODELS: readonly string[] = [
  "claude-opus-4.6",
  "claude-sonnet-4.6",
  "gpt-5.4",
  "claude-haiku-4.2",
];

/** Last bucket in the fixture window. Fixed so the data never shifts under a screenshot. */
export const RANGE_END = "2026-08-01";
export const RANGE_DAY_COUNT = 30;

/**
 * The day an org-wide usage limit was hit. Every engineer loses time on this
 * date, which is the whole reason systemic loss has to render beside a person's
 * number instead of inside it.
 */
export const ORG_USAGE_LIMIT_DATE = "2026-07-22";

const MINUTES_PER_HOUR = 60;
const PERCENT = 100;
const SEED = 1_600_057_239;
// Park-Miller / MINSTD constants. `state * MULTIPLIER` peaks around 3.6e13,
// comfortably inside the safe-integer range, so every step is exact integer
// arithmetic on any engine. No bitwise operators, which the lint preset bans.
const LEHMER_MODULUS = 2_147_483_647;
const LEHMER_MULTIPLIER = 16_807;
const SESSION_COUNT = 148;
const MS_PER_DAY = 86_400_000;

/**
 * Deterministic PRNG so the fixture is byte-identical on every render and in
 * both a light and a dark screenshot. A `Math.random()` fixture would make the
 * reconciliation tests flaky and every screenshot a different dataset.
 */
function lehmer(seed: number): () => number {
  let state = seed % LEHMER_MODULUS;
  return () => {
    state = (state * LEHMER_MULTIPLIER) % LEHMER_MODULUS;
    return state / LEHMER_MODULUS;
  };
}

function bucketDates(): string[] {
  const end = Date.parse(`${RANGE_END}T00:00:00Z`);
  const dates: string[] = [];
  for (let offset = RANGE_DAY_COUNT - 1; offset >= 0; offset--) {
    dates.push(new Date(end - offset * MS_PER_DAY).toISOString().slice(0, 10));
  }
  return dates;
}

function pick<T>(values: readonly T[], random: () => number): T {
  return values[Math.floor(random() * values.length)] as T;
}

function buildSessions(): MockSession[] {
  const random = lehmer(SEED);
  const dates = bucketDates();
  const sessions: MockSession[] = [];
  for (let index = 0; index < SESSION_COUNT; index++) {
    const session = buildSession(index, dates, random);
    sessions.push(
      session.engineer === CLEAN_ENGINEER ? toCleanSession(session) : session
    );
  }
  // Every engineer loses a run to the same org-wide usage limit. This is the
  // case the layout has to survive: it must not read as six people failing.
  for (const [index, engineer] of ENGINEERS.entries()) {
    sessions.push(buildOrgLimitSession(index, engineer, random));
  }
  for (let index = 0; index < TRIAL_MODEL_SESSION_COUNT; index++) {
    sessions.push(buildTrialModelSession(index, dates, random));
  }
  return sessions.sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * A model that has only just been switched on. It carries too few sessions to
 * grade, and every one of them ended clean, so its error-outcome spend is a
 * REAL zero. That single row is what keeps the TokenOps table honest: a genuine
 * `$0` and an ungradeable verdict have to render differently from each other
 * and from a value that is still loading.
 */
export const TRIAL_MODEL = "gpt-5.4-mini";
const TRIAL_MODEL_SESSION_COUNT = 4;

function buildTrialModelSession(
  index: number,
  dates: readonly string[],
  random: () => number
): MockSession {
  const wallClockMinutes = Math.round(22 + random() * 40);
  return {
    id: `ses_trial_${(index + 1).toString().padStart(2, "0")}`,
    title: pick(SESSION_TITLES, random),
    engineer: pick(ENGINEERS, random),
    repo: pick(REPOS, random),
    project: pick(PROJECTS, random),
    date: pick(dates, random),
    wallClockMinutes,
    endsWithError: false,
    state: SessionState.Completed,
    producedArtifact: true,
    throttleSource: null,
    model: TRIAL_MODEL,
    costUsd: estimateCost(TRIAL_MODEL, wallClockMinutes, random),
    tokens: Math.round(wallClockMinutes * (700 + random() * 900)),
  };
}

/**
 * One engineer in the fixture has no coachable loss at all, but still loses a
 * run to the org-wide usage limit. That row is the whole argument of this
 * screen in one line: a real `0` in the actionable column sitting beside real
 * systemic hours, so the two can be told apart at a glance and a genuine zero
 * is never mistaken for missing data.
 */
const CLEAN_ENGINEER = "Sam Okonkwo";

function toCleanSession(session: MockSession): MockSession {
  return {
    ...session,
    endsWithError: false,
    producedArtifact: true,
    state: SessionState.Completed,
    throttleSource: null,
  };
}

function buildSession(
  index: number,
  dates: readonly string[],
  random: () => number
): MockSession {
  const model = pick(MODELS, random);
  // The model is drawn BEFORE the outcome so the outcome can be biased by it.
  // A cheap model put on work it cannot finish really does fail more often, and
  // the right-sizing table is only worth building if the fixture has that
  // variance in it. A table whose verdict column says "Right-sized" on every
  // row proves nothing about the design.
  const roll = random();
  const outcome = resolveOutcome(roll, model);
  const throttleSource = resolveThrottleSource(outcome, random);
  const wallClockMinutes = Math.round(18 + random() * 172);
  return {
    id: `ses_${(index + 1).toString().padStart(4, "0")}`,
    title: pick(SESSION_TITLES, random),
    engineer: pick(ENGINEERS, random),
    repo: pick(REPOS, random),
    project: pick(PROJECTS, random),
    date: pick(dates, random),
    wallClockMinutes,
    endsWithError: outcome.endsWithError,
    state: outcome.state,
    producedArtifact: outcome.producedArtifact,
    throttleSource,
    model,
    costUsd: estimateCost(model, wallClockMinutes, random),
    tokens: Math.round(
      wallClockMinutes * (900 + random() * 2600) * tokenScale(model)
    ),
  };
}

/**
 * Tokens actually delivered per minute, relative to the fleet. Opus is being
 * reached for on small jobs, so it delivers fewer tokens per minute at a
 * premium rate. That combination is the "over-powered for the work" case the
 * right-sizing table exists to catch, and the fixture has to contain it or the
 * verdict is never exercised.
 */
function tokenScale(model: string): number {
  return MODEL_TOKEN_SCALE[model] ?? 1;
}

const MODEL_TOKEN_SCALE: Record<string, number> = {
  "claude-opus-4.6": 0.42,
};

function buildOrgLimitSession(
  index: number,
  engineer: string,
  random: () => number
): MockSession {
  const wallClockMinutes = Math.round(52 + random() * 74);
  const model = pick(MODELS, random);
  return {
    id: `ses_lim_${(index + 1).toString().padStart(2, "0")}`,
    title: "Org usage limit reached mid-run",
    engineer,
    repo: pick(REPOS, random),
    project: pick(PROJECTS, random),
    date: ORG_USAGE_LIMIT_DATE,
    wallClockMinutes,
    endsWithError: true,
    state: SessionState.Error,
    producedArtifact: false,
    throttleSource: ThrottleSource.UsageLimit,
    model,
    costUsd: estimateCost(model, wallClockMinutes, random),
    tokens: Math.round(wallClockMinutes * (1400 + random() * 1800)),
  };
}

type ResolvedOutcome = {
  endsWithError: boolean | null;
  state: SessionState;
  producedArtifact: boolean;
};

const CLEAN_SHARE = 0.66;
const ERRORED_SHARE = 0.9;
const ABANDONED_SPLIT = 0.45;
const THROTTLED_SHARE = 0.52;
const PROVIDER_LIMIT_SPLIT = 0.4;
const USAGE_LIMIT_SPLIT = 0.75;

function resolveOutcome(roll: number, model: string): ResolvedOutcome {
  const cleanShare = CLEAN_SHARE * (MODEL_CLEAN_SHARE_SCALE[model] ?? 1);
  if (roll < cleanShare) {
    return {
      endsWithError: false,
      state: SessionState.Completed,
      producedArtifact: true,
    };
  }
  if (roll < ERRORED_SHARE) {
    const abandoned =
      roll < cleanShare + ABANDONED_SPLIT * (ERRORED_SHARE - cleanShare);
    return {
      endsWithError: true,
      state: abandoned ? SessionState.Abandoned : SessionState.Error,
      producedArtifact: false,
    };
  }
  // `endsWithError` was never recorded. Not a success, not a failure.
  return {
    endsWithError: null,
    state: SessionState.Completed,
    producedArtifact: false,
  };
}

function resolveThrottleSource(
  outcome: ResolvedOutcome,
  random: () => number
): ThrottleSource | null {
  if (outcome.endsWithError !== true) {
    return null;
  }
  const roll = random();
  if (roll > THROTTLED_SHARE) {
    return null;
  }
  if (roll < PROVIDER_LIMIT_SPLIT * THROTTLED_SHARE) {
    return ThrottleSource.ProviderRateLimit;
  }
  if (roll < USAGE_LIMIT_SPLIT * THROTTLED_SHARE) {
    return ThrottleSource.UsageLimit;
  }
  return ThrottleSource.ApiError;
}

/**
 * Scales a model's clean-outcome threshold. Below 1 means this model finishes
 * cleanly less often, so more of its runs land in the ERRORED band. It leaves
 * the outcome-unknown band alone: not recording an outcome is a telemetry gap,
 * not something a model does more of.
 *
 * Haiku is the cheap model being handed work it keeps dropping, which is the
 * "under-powered, retry-heavy" case the right-sizing table exists to catch. The
 * fixture has to contain that case or the verdict is never exercised.
 */
const MODEL_CLEAN_SHARE_SCALE: Record<string, number> = {
  "claude-haiku-4.2": 0.55,
};

const MODEL_RATE_PER_MINUTE: Record<string, number> = {
  "claude-opus-4.6": 0.42,
  "claude-sonnet-4.6": 0.11,
  "gpt-5.4": 0.19,
  "claude-haiku-4.2": 0.03,
  "gpt-5.4-mini": 0.02,
};
const COST_JITTER = 0.35;
const CENTS = 100;

function estimateCost(
  model: string,
  wallClockMinutes: number,
  random: () => number
): number {
  const rate = MODEL_RATE_PER_MINUTE[model] ?? 0.1;
  const raw =
    rate * wallClockMinutes * (1 - COST_JITTER / 2 + random() * COST_JITTER);
  return Math.round(raw * CENTS) / CENTS;
}

const SESSION_TITLES: readonly string[] = [
  "Wire branch summary to the rollup endpoint",
  "Fix flaky gateway auth test",
  "Port pagination cursor to the sessions table",
  "Backfill token usage for July",
  "Split the collector parent-scan cache",
  "Add Labs toggle for spend-by-outcome",
  "Repair migration prefix contiguity",
  "Trim the desktop preload bundle",
  "Reconcile PR attribution by commit hash",
  "Draft the relay retry budget",
  "Investigate 08006 in the nightly run",
  "Add skeleton geometry to the branches cards",
];

/**
 * The shared population. Frozen at module load so both prototypes and every
 * test read the same 154 sessions.
 */
export const MOCK_SESSIONS: readonly MockSession[] = buildSessions();

/**
 * The one definition of failure both prototypes use: `endsWithError === true`.
 * Same key ISS-4463 / PR #4282 shipped "Spend by session outcome" on.
 */
export function outcomeOf(session: MockSession): SpendOutcome {
  if (session.endsWithError === true) {
    return SpendOutcome.Errored;
  }
  if (session.endsWithError === false) {
    return SpendOutcome.Clean;
  }
  return SpendOutcome.Unknown;
}

/** A session that consumed wall-clock and yielded no artifact. */
export function isLostSession(session: MockSession): boolean {
  return !session.producedArtifact && session.wallClockMinutes > 0;
}

/**
 * Attribution for a lost session. Driven entirely by recorded signal:
 * a throttle source means the platform caused it; a recorded terminal failure
 * with no throttle source is coachable; an unrecorded outcome is neither, and
 * says so rather than defaulting to one side.
 */
export function lossClassOf(session: MockSession): LossClass | null {
  if (!isLostSession(session)) {
    return null;
  }
  if (session.throttleSource !== null) {
    return LossClass.Systemic;
  }
  if (session.endsWithError === true) {
    return LossClass.Actionable;
  }
  return LossClass.Unattributed;
}

export function behavioralCauseOf(
  session: MockSession
): BehavioralCause | null {
  if (lossClassOf(session) !== LossClass.Actionable) {
    return null;
  }
  return session.state === SessionState.Abandoned
    ? BehavioralCause.Abandoned
    : BehavioralCause.DeadEnded;
}

export function minutesToHours(minutes: number): number {
  return minutes / MINUTES_PER_HOUR;
}

export function toPercent(part: number, whole: number): number {
  return whole > 0 ? (part / whole) * PERCENT : 0;
}
