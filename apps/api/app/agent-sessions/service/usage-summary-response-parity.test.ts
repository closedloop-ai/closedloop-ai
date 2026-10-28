import { AgentSessionUsageAttribution } from "@repo/api/src/types/agent-session-usage-attribution";
import { AgentSessionComparisonMode } from "@repo/api/src/types/agent-session-usage-comparison";
import {
  SESSION_PR_PURPOSE_LABELS,
  SessionPrPurpose,
} from "@repo/api/src/types/session-artifact-link";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentSessionDbMock,
  installDb,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { usageOwnerGroupMocks } from "@/__tests__/support/agent-sessions/usage-owner-groups.test-mocks";
import { aggregateSessionAttributionLenses } from "@/lib/agent-session-attribution";
import { readSessionAttributionBranchIds } from "@/lib/agent-session-attribution-read";
import { agentSessionsService } from "../service";
import type { SessionUsageInput } from "./records";
import { usageComparisonLatencyThrottle } from "./usage-comparison";

/**
 * ISS-12284 — the usage response, byte for byte, for a fixed fixture and
 * filter set. The snapshot was captured on the code BEFORE ISS-12284 changed
 * how the summary reads its population; it must not move.
 *
 * Both attribution reads are mocked here, so this pins how the summary
 * assembles its response from them, not that they agree with each other: the
 * omit-with-Pensero row's branch ids are the mock's, which equal the LENSES
 * keys by construction. That the real branch-set read returns the lens's key
 * set is pinned against real Postgres in
 * `usage-summary-link-history.integration.test.ts`.
 */

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});
vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return telemetryModuleMock();
});
vi.mock("@/lib/agent-session-attribution", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent-session-attribution")>()),
  aggregateSessionAttributionLenses: vi.fn(),
}));
vi.mock("@/lib/agent-session-attribution-read", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/agent-session-attribution-read")
  >()),
  readSessionAttributionBranchIds: vi.fn(),
}));

const SNAPSHOT_PATH = "./__fixtures__/usage-summary-response-parity.txt";
const WINDOW_START = "2026-09-01T00:00:00.000Z";
const WINDOW_END = "2026-09-30T23:59:59.999Z";

const LENSES = {
  byBranch: [
    {
      branchArtifactId: "branch-b",
      repositoryFullName: "acme/web",
      branchName: "feature/b",
      sessionCount: 3,
      inputTokens: 300,
      outputTokens: 150,
      cacheReadTokens: 20,
      cacheWriteTokens: 10,
      estimatedCost: 2.5,
    },
    {
      branchArtifactId: "branch-a",
      repositoryFullName: "acme/api",
      branchName: "feature/a",
      sessionCount: 1,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCost: 0.75,
    },
  ],
  byPr: [
    {
      repositoryFullName: "acme/web",
      prNumber: 42,
      prTitle: "Ship b",
      branchArtifactId: "branch-b",
      purpose: SessionPrPurpose.Authored,
      purposeLabel: SESSION_PR_PURPOSE_LABELS[SessionPrPurpose.Authored],
      sessionCount: 3,
      inputTokens: 300,
      outputTokens: 150,
      cacheReadTokens: 20,
      cacheWriteTokens: 10,
      estimatedCost: 2.5,
    },
  ],
};

const SUMS = {
  inputTokens: 1200,
  outputTokens: 640,
  cacheReadTokens: 300,
  cacheWriteTokens: 90,
  estimatedCost: 6.4,
};

function groupRows(args: { by: string[] }): unknown[] {
  const key = args.by.join(",");
  if (key === "harness") {
    return [
      { harness: "claude", _count: { _all: 6 }, _sum: { ...SUMS } },
      { harness: "codex", _count: { _all: 1 }, _sum: { ...SUMS } },
    ];
  }
  if (key === "repositoryFullName") {
    return [
      {
        repositoryFullName: "acme/web",
        _count: { _all: 4 },
        _sum: {
          inputTokens: 700,
          outputTokens: 300,
          estimatedCost: 4,
          errorCount: 2,
        },
      },
    ];
  }
  if (key === "legacyLoopCostLedger,billingMode") {
    return [
      {
        legacyLoopCostLedger: null,
        billingMode: "api",
        _sum: { estimatedCost: 4.4 },
      },
      {
        legacyLoopCostLedger: null,
        billingMode: "max_5x",
        _sum: { estimatedCost: 2 },
      },
    ];
  }
  if (key === "model") {
    return [
      { model: "claude-opus", _count: { _all: 5 } },
      { model: null, _count: { _all: 2 } },
    ];
  }
  return [];
}

function installFixtureDb() {
  const headlineAggregate = vi
    .fn()
    .mockReturnValueOnce({
      _count: { _all: 7 },
      _sum: { ...SUMS },
      _min: { sessionStartedAt: new Date("2026-09-02T10:00:00.000Z") },
      _max: { sessionStartedAt: new Date("2026-09-29T18:00:00.000Z") },
    })
    .mockReturnValue({
      _count: { _all: 3 },
      _sum: { ...SUMS, inputTokens: 400, estimatedCost: 2.2 },
      _min: { sessionStartedAt: null },
      _max: { sessionStartedAt: null },
    });
  // ISS-12251: the Owner breakdown, by assignee. An unassigned group would be
  // dropped from `byUser`, so only the one resolvable Owner is listed.
  const owners = usageOwnerGroupMocks(headlineAggregate, [
    { userId: "user-1", _count: { _all: 5 }, _sum: { ...SUMS } },
  ]);
  installDb({
    sessionDetail: buildAgentSessionDbMock({
      aggregate: owners.aggregate,
      groupBy: vi.fn(groupRows),
    }),
    artifact: { groupBy: owners.artifactGroupBy },
    agentSessionTokenUsage: {
      groupBy: vi
        .fn()
        .mockResolvedValue([
          { model: "claude-opus", _count: { _all: 9 }, _sum: { ...SUMS } },
        ]),
    },
    computeTarget: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "target-1",
          name: "laptop",
          lastSyncAt: new Date("2026-09-30T12:00:00.000Z"),
        },
      ]),
    },
    user: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "user-1",
          name: "Ada",
          email: "ada@example.test",
          imageUrl: null,
        },
      ]),
    },
  });
}

type Case = {
  name: string;
  filters: SessionUsageInput["filters"];
  pensero: boolean;
};

const CASES: Case[] = [
  { name: "default", filters: {}, pensero: false },
  {
    name: "include",
    filters: { attribution: AgentSessionUsageAttribution.Include },
    pensero: false,
  },
  {
    name: "omit",
    filters: { attribution: AgentSessionUsageAttribution.Omit },
    pensero: false,
  },
  {
    name: "omit-with-pensero",
    filters: { attribution: AgentSessionUsageAttribution.Omit },
    pensero: true,
  },
  {
    name: "include-with-pensero",
    filters: {},
    pensero: true,
  },
  {
    name: "windowed-prior-omit",
    filters: {
      startDate: WINDOW_START,
      endDate: WINDOW_END,
      comparison: AgentSessionComparisonMode.Prior,
      attribution: AgentSessionUsageAttribution.Omit,
    },
    pensero: false,
  },
];

describe("usage response byte parity (ISS-12284)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usageComparisonLatencyThrottle.clear();
    vi.mocked(aggregateSessionAttributionLenses).mockResolvedValue(LENSES);
    vi.mocked(readSessionAttributionBranchIds).mockResolvedValue([
      "branch-a",
      "branch-b",
    ]);
  });

  it("returns the bytes captured before the change for every case", async () => {
    const transcript: Record<string, unknown> = {};
    for (const testCase of CASES) {
      installFixtureDb();
      const readPensero = vi.fn().mockResolvedValue(4.2);
      const summary = await agentSessionsService.getUsageSummary(
        {
          organizationId: "org-1",
          viewerId: "user-1",
          filters: testCase.filters,
        },
        testCase.pensero ? readPensero : undefined
      );
      transcript[testCase.name] = {
        body: JSON.stringify(summary),
        penseroBranchIds: testCase.pensero
          ? [...(readPensero.mock.calls[0]?.[0] ?? [])].sort()
          : null,
      };
    }
    await expect(JSON.stringify(transcript, null, 2)).toMatchFileSnapshot(
      SNAPSHOT_PATH
    );
  });
});
