import type { ActivityEvent } from "../../../../desktop/src/shared/activity-panel-contract";
import type {
  PlanRecord,
  PlanVersionRecord,
} from "../../../../desktop/src/shared/agent-db-contract";

// Preload-bridge answers for the Surfaces Desktop Only pages (Plans,
// Approvals, Requests). Each is the shape the desktop renderer reads
// from `window.desktopApi` (types from `apps/desktop/src/shared/*`).

// --- Plans: `desktopApi.db.getPlansList` / `getPlanVersions` -------------

function plan(
  index: number,
  overrides: Partial<PlanRecord> & Pick<PlanRecord, "title">
): PlanRecord {
  return {
    id: `plan-${index}`,
    status: "pending",
    source: "session",
    captureMethod: "plans-dir",
    harness: "claude-code",
    sessionId: `session-${index}`,
    filePath: `.claude/plans/plan-${index}.md`,
    sourceLogPath: `~/.claude/projects/closedloop-ai/session-${index}.jsonl`,
    needsConfirmation: true,
    confidence: 0.9,
    createdAt: "2026-10-05T14:20:00.000Z",
    updatedAt: "2026-10-05T14:42:00.000Z",
    latestContent: null,
    versionCount: 1,
    ...overrides,
  };
}

export const plansFixture: PlanRecord[] = [
  plan(1, {
    title: "Move the session list to cursor pagination",
    latestContent:
      "# Move the session list to cursor pagination\n\n1. Add a `cursor` query param to `GET /agent-sessions`.\n2. Return `nextCursor` from the list handler.\n3. Switch the Sessions table to infinite scroll.\n4. Drop the offset path once both clients ship.",
    versionCount: 3,
    confidence: 0.94,
  }),
  plan(2, {
    title: "Backfill branch PR links for archived sessions",
    harness: "codex",
    latestContent:
      "# Backfill branch PR links\n\n- Query archived sessions with a branch but no PR link.\n- Resolve each branch against GitHub in batches of 50.\n- Write links in one transaction per batch.",
    versionCount: 2,
    confidence: 0.88,
    createdAt: "2026-10-05T10:31:00.000Z",
    updatedAt: "2026-10-05T11:05:00.000Z",
  }),
  plan(3, {
    title: "Split the insights utilization query",
    status: "confirmed",
    needsConfirmation: false,
    latestContent:
      "# Split the utilization query\n\nCompute KPI totals and the per-day series in two queries so the series can be cached separately.",
    confidence: 0.97,
    createdAt: "2026-10-04T16:02:00.000Z",
    updatedAt: "2026-10-04T17:30:00.000Z",
  }),
  plan(4, {
    title: "Retire the legacy desktop sidebar",
    status: "rejected",
    needsConfirmation: false,
    harness: "cursor",
    latestContent:
      "# Retire the legacy desktop sidebar\n\nDelete `LegacyDesktopSidebar` and the `shell-sidebar-v2` read.",
    confidence: 0.71,
    createdAt: "2026-10-03T08:47:00.000Z",
    updatedAt: "2026-10-03T09:12:00.000Z",
  }),
];

export const planVersionsFixture: PlanVersionRecord[] = [
  {
    id: "plan-1-v3",
    planId: "plan-1",
    versionNumber: 3,
    contentMarkdown: plansFixture[0]?.latestContent ?? null,
    contentSha256: "9f2c4e1a",
    authorType: "agent",
    captureMethod: "tool-output",
    createdAt: "2026-10-05T14:42:00.000Z",
  },
  {
    id: "plan-1-v2",
    planId: "plan-1",
    versionNumber: 2,
    contentMarkdown:
      "# Move the session list to cursor pagination\n\n1. Add a `cursor` query param.\n2. Switch the table to infinite scroll.",
    contentSha256: "41be07d3",
    authorType: "human",
    captureMethod: "manual-edit",
    createdAt: "2026-10-05T14:31:00.000Z",
  },
  {
    id: "plan-1-v1",
    planId: "plan-1",
    versionNumber: 1,
    contentMarkdown: "# Cursor pagination for sessions",
    contentSha256: "c07a9b52",
    authorType: "agent",
    captureMethod: "plans-dir",
    createdAt: "2026-10-05T14:20:00.000Z",
  },
];

// --- Approvals: `desktopApi.getPendingApprovals` / `getSettings` ----------

export const pendingApprovalsFixture = [
  {
    id: "approval-1",
    reason: "Run `pnpm install --frozen-lockfile` in ~/code/closedloop-ai",
    request: { path: "/api/gateway/exec" },
    riskTier: "high",
    createdAt: "2026-10-06T09:41:00.000Z",
  },
  {
    id: "approval-2",
    reason: "Write 3 files under ~/code/closedloop-ai/apps/app/lib",
    request: { path: "/api/gateway/fs/write" },
    riskTier: "medium",
    createdAt: "2026-10-06T09:39:00.000Z",
  },
  {
    id: "approval-3",
    reason: "Read ~/code/closedloop-ai/package.json",
    request: { path: "/api/gateway/fs/read" },
    riskTier: "low",
    createdAt: "2026-10-06T09:38:00.000Z",
  },
];

export const alwaysAllowRulesFixture = [
  {
    id: "rule-1",
    method: "GET",
    path: "/api/gateway/fs/read",
    scopePath: "~/code/closedloop-ai",
    expiresAt: "2026-10-13T09:00:00.000Z",
  },
  {
    id: "rule-2",
    method: "POST",
    path: "/api/gateway/exec",
    scopePath: "~/code/closedloop-ai",
    expiresAt: "2026-10-07T18:00:00.000Z",
  },
];

// --- Requests: `desktopApi.getActivityEvents` --------------------------

function event(
  index: number,
  overrides: Omit<ActivityEvent, "id" | "timestamp"> & { minute: number }
): ActivityEvent {
  const { minute, ...rest } = overrides;
  return {
    id: `event-${index}`,
    type: "request",
    timestamp: `2026-10-06T09:${String(minute).padStart(2, "0")}:12.000Z`,
    ...rest,
  };
}

export const activityEventsFixture: ActivityEvent[] = [
  event(1, {
    minute: 44,
    method: "POST",
    path: "/api/gateway/exec",
    statusCode: 200,
    durationMs: 1840,
    requestSizeBytes: 412,
    responseSizeBytes: 9822,
  }),
  event(2, {
    minute: 43,
    method: "GET",
    path: "/api/gateway/fs/read",
    statusCode: 200,
    durationMs: 12,
    requestSizeBytes: 96,
    responseSizeBytes: 4310,
  }),
  event(3, {
    minute: 42,
    type: "security",
    method: "POST",
    path: "/api/gateway/fs/write",
    statusCode: 403,
    durationMs: 4,
    detail: "Path outside the sandbox allow-list: /etc/hosts",
  }),
  event(4, {
    minute: 41,
    method: "POST",
    path: "/api/gateway/git/status",
    statusCode: 200,
    durationMs: 96,
    requestSizeBytes: 64,
    responseSizeBytes: 1288,
  }),
  event(5, {
    minute: 40,
    type: "security",
    method: "POST",
    path: "/api/gateway/exec",
    statusCode: 202,
    durationMs: 7,
    detail: "Held for approval: rm -rf node_modules",
  }),
  event(6, {
    minute: 38,
    method: "GET",
    path: "/api/gateway/health",
    statusCode: 200,
    durationMs: 3,
  }),
];
