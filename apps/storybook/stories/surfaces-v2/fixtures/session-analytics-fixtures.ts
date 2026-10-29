import {
  BEHAVIORAL_CAUSE_LABELS,
  BehavioralCause,
  FAILURE_THROTTLE_SOURCE_LABELS,
  LossClass,
  type LostWorkInsightsResponse,
  type LostWorkPersonRow,
  ModelVerdict,
  type TokenOpsWasteInsightsResponse,
} from "@repo/api/src/types/session-analytics";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import { SpendOutcome } from "@repo/loops-api/insights";
import { liveAppShellRoutes } from "./live-app-fixtures";

// The live Lost work and TokenOps waste pages
// (`apps/app/.../insights/lost-work/page-client.tsx` and
// `.../tokenops-waste/page-client.tsx`) each read one session-analytics
// rollup: `GET /insights/lost-work` and `GET /insights/tokenops-waste`. These
// are those rollups for a 30-day window of a busy workspace.

const TREND_DAYS = Array.from({ length: 30 }, (_unused, index) => {
  const day = new Date(Date.UTC(2026, 8, 7 + index));
  return day.toISOString().slice(0, 10);
});

function person(
  userId: string,
  engineer: string,
  minutes: [number, number, number],
  sessions: [number, number, number],
  dominantCause: string,
  dominantCauseClass: LostWorkPersonRow["dominantCauseClass"],
  baselineDeltaPts: number | null
): LostWorkPersonRow {
  const [actionableMinutes, systemicMinutes, unattributedMinutes] = minutes;
  const [actionableSessions, systemicSessions, unattributedSessions] = sessions;
  const sessionCount =
    actionableSessions + systemicSessions + unattributedSessions + 60;
  return {
    actionableMinutes,
    actionableRatePct: Math.round((actionableSessions / sessionCount) * 100),
    actionableSessions,
    baselineDeltaPts,
    dominantCause,
    dominantCauseClass,
    engineer,
    sessionCount,
    systemicMinutes,
    systemicSessions,
    totalMinutes: sessionCount * 38,
    unattributedMinutes,
    unattributedSessions,
    userId,
  };
}

export const lostWorkFixture: LostWorkInsightsResponse = {
  behavioralCauses: [
    {
      key: BehavioralCause.Abandoned,
      label: BEHAVIORAL_CAUSE_LABELS[BehavioralCause.Abandoned],
      minutes: 1260,
      sessions: 41,
    },
    {
      key: BehavioralCause.DeadEnded,
      label: BEHAVIORAL_CAUSE_LABELS[BehavioralCause.DeadEnded],
      minutes: 790,
      sessions: 23,
    },
  ],
  lostSessions: [
    {
      cause: BEHAVIORAL_CAUSE_LABELS[BehavioralCause.Abandoned],
      date: "2026-10-05",
      engineer: "Dana Reyes",
      id: "ses_lost_1",
      lossClass: LossClass.Actionable,
      minutes: 74,
      repo: "closedloop-ai/closedloop-ai",
      title: "Migrate insights tiles to the shared grid",
    },
    {
      cause: FAILURE_THROTTLE_SOURCE_LABELS.provider_rate_limit ?? "",
      date: "2026-10-04",
      engineer: "Marcus Webb",
      id: "ses_lost_2",
      lossClass: LossClass.Systemic,
      minutes: 52,
      repo: "closedloop-ai/desktop",
      title: "Retry desktop sync after a token refresh",
    },
    {
      cause: BEHAVIORAL_CAUSE_LABELS[BehavioralCause.DeadEnded],
      date: "2026-10-03",
      engineer: "Priya Nair",
      id: "ses_lost_3",
      lossClass: LossClass.Actionable,
      minutes: 47,
      repo: "closedloop-ai/closedloop-ai",
      title: "Storybook: members table empty state",
    },
    {
      cause: FAILURE_THROTTLE_SOURCE_LABELS.usage_limit ?? "",
      date: "2026-10-02",
      engineer: "Emma Chen",
      id: "ses_lost_4",
      lossClass: LossClass.Systemic,
      minutes: 38,
      repo: "closedloop-ai/loops-api",
      title: "Backfill token usage for archived sessions",
    },
    {
      cause: "No signal",
      date: "2026-10-01",
      engineer: "Dana Reyes",
      id: "ses_lost_5",
      lossClass: LossClass.Unattributed,
      minutes: 29,
      repo: "closedloop-ai/docs",
      title: "Draft release notes for 2.4",
    },
  ],
  people: [
    person(
      "user_test",
      "Dana Reyes",
      [640, 210, 120],
      [22, 7, 5],
      BEHAVIORAL_CAUSE_LABELS[BehavioralCause.Abandoned],
      LossClass.Actionable,
      3
    ),
    person(
      "user_marcus",
      "Marcus Webb",
      [310, 480, 90],
      [11, 15, 3],
      FAILURE_THROTTLE_SOURCE_LABELS.provider_rate_limit ?? "",
      LossClass.Systemic,
      -2
    ),
    person(
      "user_priya",
      "Priya Nair",
      [420, 150, 60],
      [14, 5, 2],
      BEHAVIORAL_CAUSE_LABELS[BehavioralCause.DeadEnded],
      LossClass.Actionable,
      1
    ),
    person(
      "user_emma",
      "Emma Chen",
      [180, 260, 40],
      [6, 9, 1],
      FAILURE_THROTTLE_SOURCE_LABELS.usage_limit ?? "",
      LossClass.Systemic,
      null
    ),
  ],
  systemicCauses: [
    {
      key: "provider_rate_limit",
      label: FAILURE_THROTTLE_SOURCE_LABELS.provider_rate_limit ?? "",
      minutes: 610,
      sessions: 19,
    },
    {
      key: "usage_limit",
      label: FAILURE_THROTTLE_SOURCE_LABELS.usage_limit ?? "",
      minutes: 340,
      sessions: 11,
    },
    {
      key: "api_error",
      label: FAILURE_THROTTLE_SOURCE_LABELS.api_error ?? "",
      minutes: 150,
      sessions: 6,
    },
  ],
  totals: {
    minutesByClass: {
      [LossClass.Actionable]: 2050,
      [LossClass.Systemic]: 1100,
      [LossClass.Unattributed]: 310,
    },
    productiveMinutes: 38_640,
    sessionCount: 1284,
    sessionsByClass: {
      [LossClass.Actionable]: 64,
      [LossClass.Systemic]: 36,
      [LossClass.Unattributed]: 11,
    },
    totalMinutes: 42_100,
  },
  // Hours per day, by loss class.
  trend: TREND_DAYS.map((date, index) => {
    const wave = 1 + 0.5 * Math.sin(index / 3);
    return {
      date,
      values: {
        [LossClass.Actionable]: Number((1.1 * wave).toFixed(2)),
        [LossClass.Systemic]: Number(
          (index % 7 === 3 ? 2.4 : 0.45 * wave).toFixed(2)
        ),
        [LossClass.Unattributed]: Number((0.17 * wave).toFixed(2)),
      },
    };
  }),
  unavailableWidgets: [],
};

export const tokenOpsWasteFixture: TokenOpsWasteInsightsResponse = {
  minGradedSessions: 20,
  models: [
    {
      confidencePct: 14,
      errorOutcomeUsd: 312.4,
      medianTokens: 412_000,
      medianWorkTokens: 96_000,
      model: "claude-opus-4-5",
      sessions: 402,
      usd: 2271.2,
      usdPerSession: 5.65,
      verdict: ModelVerdict.Overpowered,
    },
    {
      confidencePct: 11,
      errorOutcomeUsd: 141.9,
      medianTokens: 288_000,
      medianWorkTokens: 121_000,
      model: "claude-sonnet-4-5",
      sessions: 711,
      usd: 1303.9,
      usdPerSession: 1.83,
      verdict: ModelVerdict.RightSized,
    },
    {
      confidencePct: 19,
      errorOutcomeUsd: 118.3,
      medianTokens: 196_000,
      medianWorkTokens: 140_000,
      model: "gpt-5-codex",
      sessions: 159,
      usd: 630.9,
      usdPerSession: 3.97,
      verdict: ModelVerdict.Underpowered,
    },
    {
      errorOutcomeUsd: 4.1,
      medianTokens: 64_000,
      model: "claude-haiku-4-5",
      sessions: 12,
      usd: 18.6,
      usdPerSession: 1.55,
      verdict: ModelVerdict.Ungraded,
    },
  ],
  outcomes: [
    { outcome: SpendOutcome.Clean, sessions: 1072, usd: 3388.1 },
    { outcome: SpendOutcome.Errored, sessions: 131, usd: 576.7 },
    { outcome: SpendOutcome.Running, sessions: 18, usd: 104.2 },
    { outcome: SpendOutcome.Unknown, sessions: 63, usd: 155.6 },
  ],
  totalSpendUsd: 4224.6,
  unavailableWidgets: [],
  waste: {
    errorOutcomeUsd: 576.7,
    excludedUnknownUsd: 155.6,
    highRate: 0.6,
    highUsd: 346,
    lowRate: 0.35,
    lowUsd: 201.8,
    sessions: 131,
  },
};

export const lostWorkApiRoutes: FixtureRoute[] = [
  ...liveAppShellRoutes,
  {
    method: "GET",
    path: "/insights/lost-work",
    respond: () => lostWorkFixture,
  },
];

export const tokenOpsWasteApiRoutes: FixtureRoute[] = [
  ...liveAppShellRoutes,
  {
    method: "GET",
    path: "/insights/tokenops-waste",
    respond: () => tokenOpsWasteFixture,
  },
];
