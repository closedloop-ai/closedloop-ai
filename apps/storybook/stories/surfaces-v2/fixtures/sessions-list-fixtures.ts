import type {
  AgentSessionListItem,
  AgentSessionUsageSummary,
} from "@repo/api/src/types/agent-session";
import {
  AgentSessionViewerScope,
  SessionPrLifecycleStatus,
} from "@repo/api/src/types/agent-session";
import { Priority } from "@repo/api/src/types/common";
import { DocumentType } from "@repo/api/src/types/document";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import {
  createAgentSessionListItemFixture,
  createAgentSessionUsageSummaryFixture,
} from "@repo/app/agents/components/sessions/session-list-fixtures";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import { liveAppShellRoutes, sessionListResponse } from "./live-app-fixtures";

// The live Sessions list (`apps/app/.../sessions/page.tsx`) reads the session
// page (`GET /agent-sessions`) and the summary strip's usage aggregate
// (`GET /agent-sessions/usage`) over the last 7 days. These are one populated
// week of a team's runs, dated inside the default window.

const people = {
  dana: {
    avatarUrl: null,
    email: "dana@example.com",
    firstName: "Dana",
    id: "user_test",
    lastName: "Reyes",
  },
  priya: {
    avatarUrl: null,
    email: "priya@example.com",
    firstName: "Priya",
    id: "user-priya",
    lastName: "Shah",
  },
  marco: {
    avatarUrl: null,
    email: "marco@example.com",
    firstName: "Marco",
    id: "user-marco",
    lastName: "Lind",
  },
} as const;

const laptop = {
  id: "compute-target-dana",
  isOnline: true,
  lastAgentSessionSyncAt: new Date("2026-10-06T09:50:00.000Z"),
  lastSeenAt: new Date("2026-10-06T09:55:00.000Z"),
  machineName: "Dana's MacBook Pro",
};

type RowSeed = {
  id: string;
  name: string;
  user: (typeof people)[keyof typeof people];
  startedAt: string;
  minutes: number;
  status: string;
  harness: string;
  model: string;
  repo: string;
  branch: string;
  cost: number;
  autonomy: number;
  linesAdded: number;
  linesRemoved: number;
  prs?: AgentSessionListItem["prs"];
  issue?: { slug: string; name: string };
  running?: boolean;
};

const MINUTE_MS = 60_000;

const PRIORITIES = [
  Priority.High,
  Priority.Medium,
  Priority.Urgent,
  Priority.Low,
] as const;

function row(seed: RowSeed): AgentSessionListItem {
  const startedAt = new Date(seed.startedAt);
  const lastActivityAt = new Date(
    startedAt.getTime() + seed.minutes * MINUTE_MS
  );
  return createAgentSessionListItemFixture({
    autonomy: Math.round(seed.autonomy * 100),
    branch: seed.branch,
    computeTarget: laptop,
    endedAt: seed.running ? null : lastActivityAt,
    estimatedCost: seed.cost,
    externalSessionId: `external-${seed.id}`,
    filesChanged: Math.max(1, Math.round(seed.linesAdded / 40)),
    harness: seed.harness,
    id: seed.id,
    lastActivityAt,
    lastSyncedAt: lastActivityAt,
    linesAdded: seed.linesAdded,
    linesRemoved: seed.linesRemoved,
    linkedArtifacts: seed.issue
      ? [
          {
            documentType: DocumentType.Feature,
            id: `artifact-${seed.issue.slug}`,
            name: seed.issue.name,
            role: "referenced",
            slug: seed.issue.slug,
          },
        ]
      : [],
    model: seed.model,
    name: seed.name,
    priority: PRIORITIES[Number(seed.id.slice(-1)) % PRIORITIES.length],
    prs: seed.prs ?? [],
    prsMerged: (seed.prs ?? []).filter(
      (pr) => pr.status === SessionPrLifecycleStatus.Merged
    ).length,
    repositoryFullName: seed.repo,
    slug: `SES-${seed.id.replace("session-", "")}`,
    sourceArtifact: null,
    sourceArtifactId: null,
    startedAt,
    status: seed.status,
    updatedAt: lastActivityAt,
    user: seed.user,
    worktreePath: `/Users/${seed.user.firstName.toLowerCase()}/code/${seed.branch}`,
  });
}

export const sessionsListRowsFixture: AgentSessionListItem[] = [
  row({
    autonomy: 0.82,
    branch: "fea-4410-branch-trace",
    cost: 6.4,
    harness: "claude-code",
    id: "session-4182",
    issue: { name: "Branch trace timeline", slug: "FEA-4410" },
    linesAdded: 412,
    linesRemoved: 96,
    minutes: 74,
    model: "claude-opus-4.1",
    name: "Branch trace timeline: wire the session lanes",
    repo: "closedloop-ai/closedloop-ai",
    running: true,
    startedAt: "2026-10-06T08:10:00.000Z",
    status: SESSION_STATUS.ACTIVE,
    user: people.dana,
  }),
  row({
    autonomy: 0.64,
    branch: "iss-11420-retry-sync",
    cost: 3.15,
    harness: "codex",
    id: "session-4179",
    issue: { name: "Desktop sync retries on 502", slug: "ISS-11420" },
    linesAdded: 188,
    linesRemoved: 41,
    minutes: 52,
    model: "gpt-5.5",
    name: "Retry desktop sync after gateway errors",
    prs: [
      {
        num: 7012,
        status: SessionPrLifecycleStatus.Open,
        title: "Retry desktop sync after gateway errors",
      },
    ],
    repo: "closedloop-ai/desktop",
    startedAt: "2026-10-05T15:20:00.000Z",
    status: SESSION_STATUS.INACTIVE,
    user: people.priya,
  }),
  row({
    autonomy: 0.91,
    branch: "fea-4388-csv-export",
    cost: 9.8,
    harness: "claude-code",
    id: "session-4171",
    issue: { name: "Sessions CSV export", slug: "FEA-4388" },
    linesAdded: 640,
    linesRemoved: 120,
    minutes: 118,
    model: "claude-opus-4.1",
    name: "Sessions CSV export with column picker",
    prs: [
      {
        num: 6988,
        status: SessionPrLifecycleStatus.Merged,
        title: "Sessions CSV export",
      },
    ],
    repo: "closedloop-ai/closedloop-ai",
    startedAt: "2026-10-04T10:05:00.000Z",
    status: SESSION_STATUS.INACTIVE,
    user: people.dana,
  }),
  row({
    autonomy: 0.38,
    branch: "iss-11391-flaky-e2e",
    cost: 1.9,
    harness: "codex",
    id: "session-4166",
    linesAdded: 22,
    linesRemoved: 14,
    minutes: 31,
    model: "gpt-5.5",
    name: "Stabilize the branches e2e spec",
    repo: "closedloop-ai/closedloop-ai",
    startedAt: "2026-10-03T13:40:00.000Z",
    status: SESSION_STATUS.ERROR,
    user: people.marco,
  }),
  row({
    autonomy: 0.77,
    branch: "fea-4375-tag-picker",
    cost: 4.6,
    harness: "claude-code",
    id: "session-4160",
    issue: { name: "Tag picker keyboard support", slug: "FEA-4375" },
    linesAdded: 233,
    linesRemoved: 58,
    minutes: 66,
    model: "claude-sonnet-4.5",
    name: "Tag picker keyboard navigation",
    prs: [
      {
        num: 6971,
        status: SessionPrLifecycleStatus.Merged,
        title: "Tag picker keyboard navigation",
      },
    ],
    repo: "closedloop-ai/closedloop-ai",
    startedAt: "2026-10-02T09:15:00.000Z",
    status: SESSION_STATUS.INACTIVE,
    user: people.priya,
  }),
  row({
    autonomy: 0.55,
    branch: "iss-11377-loop-usage",
    cost: 2.7,
    harness: "claude-code",
    id: "session-4152",
    linesAdded: 97,
    linesRemoved: 30,
    minutes: 44,
    model: "claude-sonnet-4.5",
    name: "Loop usage chart axis labels",
    repo: "closedloop-ai/closedloop-ai",
    startedAt: "2026-10-01T16:30:00.000Z",
    status: SESSION_STATUS.INACTIVE,
    user: people.marco,
  }),
  row({
    autonomy: 0.7,
    branch: "fea-4362-compute-targets",
    cost: 5.3,
    harness: "codex",
    id: "session-4147",
    issue: { name: "Compute target health", slug: "FEA-4362" },
    linesAdded: 301,
    linesRemoved: 77,
    minutes: 83,
    model: "gpt-5.5",
    name: "Compute target health indicators",
    prs: [
      {
        num: 6950,
        status: SessionPrLifecycleStatus.Merged,
        title: "Compute target health indicators",
      },
    ],
    repo: "closedloop-ai/desktop",
    startedAt: "2026-10-01T08:45:00.000Z",
    status: SESSION_STATUS.INACTIVE,
    user: people.dana,
  }),
  row({
    autonomy: 0.6,
    branch: "iss-11360-onboarding-copy",
    cost: 1.2,
    harness: "claude-code",
    id: "session-4139",
    linesAdded: 48,
    linesRemoved: 19,
    minutes: 22,
    model: "claude-sonnet-4.5",
    name: "Guided onboarding checklist order",
    repo: "closedloop-ai/closedloop-ai",
    startedAt: "2026-09-30T14:10:00.000Z",
    status: SESSION_STATUS.INACTIVE,
    user: people.priya,
  }),
];

const totalCost = sessionsListRowsFixture.reduce(
  (sum, item) => sum + (item.estimatedCost ?? 0),
  0
);

function byUser() {
  return Object.values(people).map((person) => {
    const rows = sessionsListRowsFixture.filter(
      (item) => item.user?.id === person.id
    );
    return {
      cacheReadTokens: rows.length * 210_000,
      cacheWriteTokens: rows.length * 42_000,
      estimatedCost: rows.reduce(
        (sum, item) => sum + (item.estimatedCost ?? 0),
        0
      ),
      inputTokens: rows.length * 96_000,
      outputTokens: rows.length * 21_000,
      sessionCount: rows.length,
      userAvatarUrl: null,
      userEmail: person.email,
      userId: person.id,
      userName: `${person.firstName} ${person.lastName}`,
    };
  });
}

function countBy<T extends string>(
  key: (item: AgentSessionListItem) => T | null
) {
  const counts = new Map<T, { count: number; cost: number }>();
  for (const item of sessionsListRowsFixture) {
    const value = key(item);
    if (value === null) {
      continue;
    }
    const entry = counts.get(value) ?? { cost: 0, count: 0 };
    counts.set(value, {
      cost: entry.cost + (item.estimatedCost ?? 0),
      count: entry.count + 1,
    });
  }
  return [...counts.entries()];
}

export const sessionsUsageFixture: AgentSessionUsageSummary =
  createAgentSessionUsageSummaryFixture(AgentSessionViewerScope.Organization, {
    apiEstimatedCost: totalCost,
    byHarness: countBy((item) => item.harness).map(
      ([harness, { count, cost }]) => ({
        cacheReadTokens: count * 210_000,
        cacheWriteTokens: count * 42_000,
        estimatedCost: cost,
        harness,
        inputTokens: count * 96_000,
        outputTokens: count * 21_000,
        sessionCount: count,
      })
    ),
    byModel: countBy((item) => item.model).map(([model, { count, cost }]) => ({
      cacheReadTokens: count * 210_000,
      cacheWriteTokens: count * 42_000,
      estimatedCost: cost,
      inputTokens: count * 96_000,
      model,
      outputTokens: count * 21_000,
      sessionCount: count,
    })),
    byRepository: countBy((item) => item.repositoryFullName).map(
      ([repositoryFullName, { count, cost }]) => ({
        errorCount: 0,
        estimatedCost: cost,
        inputTokens: count * 96_000,
        outputTokens: count * 21_000,
        repositoryFullName,
        sessionCount: count,
      })
    ),
    byUser: byUser(),
    comparison: {
      deltas: {
        apiCost: 12,
        meteredCost: 12,
        prsShipped: 50,
        sessions: 33,
        tokens: 18,
        totalCost: 12,
      },
      priorEndDate: "2026-09-29T23:59:59.999Z",
      priorStartDate: "2026-09-23T00:00:00.000Z",
    },
    earliestSessionAt: "2026-09-30T14:10:00.000Z",
    lastSyncTargets: [
      {
        computeTargetId: laptop.id,
        isOnline: laptop.isOnline,
        lastAgentSessionSyncAt: laptop.lastAgentSessionSyncAt,
        lastSeenAt: laptop.lastSeenAt,
        machineName: laptop.machineName,
        owner: people.dana,
      },
    ],
    latestSessionAt: "2026-10-06T08:10:00.000Z",
    medianPrSize: 380,
    mergedLocPerDollar: 118,
    mergedPrCount: 3,
    totalCacheReadTokens: sessionsListRowsFixture.length * 210_000,
    totalCacheWriteTokens: sessionsListRowsFixture.length * 42_000,
    totalEstimatedCost: totalCost,
    totalInputTokens: sessionsListRowsFixture.length * 96_000,
    totalOutputTokens: sessionsListRowsFixture.length * 21_000,
    totalSessions: sessionsListRowsFixture.length,
  });

/** An empty week: no sessions in range, no usage. */
export const sessionsUsageEmptyFixture: AgentSessionUsageSummary =
  createAgentSessionUsageSummaryFixture(AgentSessionViewerScope.Organization, {
    totalSessions: 0,
  });

export const sessionsListApiRoutes: FixtureRoute[] = [
  ...liveAppShellRoutes,
  {
    method: "GET",
    path: "/agent-sessions/usage",
    respond: () => sessionsUsageFixture,
  },
  {
    method: "GET",
    path: "/agent-sessions",
    respond: () => ({
      ...sessionListResponse(sessionsListRowsFixture),
      viewerScope: AgentSessionViewerScope.Organization,
    }),
  },
];
