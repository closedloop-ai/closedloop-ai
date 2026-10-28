import { ARTIFACT_STATUS_ROOT_ORDER_FLAG_KEY } from "@repo/api/src/types/artifact-status-root-order-flag";
import { ListQueryExecution } from "@repo/api/src/types/list-query-observability";
import { sessionStatusRootRankOrNull } from "@repo/api/src/types/session-status-root-order";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { displaySortCandidate } from "@/__tests__/support/agent-sessions/display-sort-candidate.test-fixtures";
import { installDb } from "@/__tests__/support/agent-sessions/service.test-harness";
import {
  getRequestListQueryLogFields,
  runWithRequestSpanAttribution,
} from "@/lib/observability/request-span-attribution";
import { agentSessionsService } from "../service";
import { buildDisplaySortComparator } from "./session-sort-comparators";

const mocks = vi.hoisted(() => ({ flag: vi.fn() }));
vi.mock("@/lib/feature-flag-identity", () => ({
  isFeatureFlagEnabledForAnyIdentity: mocks.flag,
}));
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

describe("D5 Sessions status root ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
    });
  });

  it.each([
    { flag: false, expected: ListQueryExecution.DatabasePage },
    { flag: true, expected: ListQueryExecution.DisplayValueFallback },
  ])(
    "DT-19: production service selects $expected when root flag is $flag",
    async ({ flag, expected }) => {
      mocks.flag.mockResolvedValue(flag);
      let execution: unknown;
      await runWithRequestSpanAttribution(async () => {
        await agentSessionsService.findSessions({
          organizationId: "org-1",
          viewerId: "viewer-1",
          clerkUserId: "clerk-1",
          filters: { sortBy: "status", sortDir: "asc", quality: "all" },
        });
        execution = getRequestListQueryLogFields().list_query_execution;
      });
      expect(execution).toBe(expected);
      expect(mocks.flag).toHaveBeenCalledTimes(1);
      expect(mocks.flag.mock.calls[0]?.[0]).toEqual({
        kind: "grant",
        key: ARTIFACT_STATUS_ROOT_ORDER_FLAG_KEY,
      });
      expect(mocks.flag.mock.calls[0]?.[1]).toEqual({
        userId: "viewer-1",
        clerkUserId: "clerk-1",
      });
    }
  );

  it("DT-24: target identity precedes external id and artifact id for Status ties", () => {
    const rows = [
      displaySortCandidate("z-artifact", {
        computeTargetId: "target-a",
        externalSessionId: "z-session",
      }),
      displaySortCandidate("a-artifact", {
        computeTargetId: "target-z",
        externalSessionId: "a-session",
      }),
    ];
    for (const [statusRootRank, expected] of [
      [undefined, ["z-artifact", "a-artifact"]],
      [sessionStatusRootRankOrNull, ["a-artifact", "z-artifact"]],
    ] as const) {
      expect(
        [...rows]
          .sort(
            buildDisplaySortComparator(
              [{ column: "status", dir: "asc" }],
              statusRootRank
            )
          )
          .map((row) => row.artifactId)
      ).toEqual(expected);
    }
  });

  it.each([
    {
      dir: "asc" as const,
      expected: ["z-active", "a-active", "m-inactive", "x-error", "q-unknown"],
    },
    {
      dir: "desc" as const,
      expected: ["x-error", "m-inactive", "z-active", "a-active", "q-unknown"],
    },
  ])(
    "DT-19: root order $dir keeps unknown last and ties by ID descending",
    ({ dir, expected }) => {
      const rows = [
        ["a-active", "active"],
        ["q-unknown", "waiting"],
        ["x-error", "error"],
        ["m-inactive", "inactive"],
        ["z-active", "active"],
      ].map(([id, status]) =>
        displaySortCandidate(id, {
          artifact: {
            status,
            priority: null,
            updatedAt: new Date("2026-06-12T00:00:00.000Z"),
            assignee: null,
          },
        })
      );
      const rule = [{ column: "status" as const, dir }];
      expect(
        [...rows]
          .sort(buildDisplaySortComparator(rule, sessionStatusRootRankOrNull))
          .map((row) => row.artifactId)
      ).toEqual(expected);
      expect(
        [...rows]
          .sort(buildDisplaySortComparator(rule))
          .map((row) => row.artifactId)
      ).toEqual(
        dir === "asc"
          ? ["z-active", "a-active", "x-error", "m-inactive", "q-unknown"]
          : ["q-unknown", "m-inactive", "x-error", "z-active", "a-active"]
      );
    }
  );
});
