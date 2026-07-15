import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentSessionsService } from "../service";
import { installDb, SESSION_STARTED_AT } from "../service.test-harness";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import("../service.test-mocks");
  return databaseModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import("../service.test-mocks");
  return telemetryModuleMock();
});

describe("agentSessionsService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exports zero-usage sessions with a fallback model row", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          {
            sessionStartedAt: SESSION_STARTED_AT,
            harness: "claude",
            model: "claude-sonnet-4",
            user: {
              id: "user-1",
              email: "ada@example.com",
              firstName: "Ada",
              lastName: "Lovelace",
              avatarUrl: null,
              teamMemberships: [
                {
                  team: {
                    name: "Platform",
                  },
                },
              ],
            },
            artifact: {
              project: {
                name: "Agent Platform",
              },
            },
            tokenUsageByModel: [],
          },
        ]),
      },
      organization: {
        findUnique: vi.fn().mockResolvedValue({ slug: "closedloop" }),
      },
    });

    await expect(
      agentSessionsService.findExportRows({
        organizationId: "org-1",
        filters: {},
      })
    ).resolves.toEqual({
      orgSlug: "closedloop",
      rows: [
        {
          date: "2026-05-20",
          user: "Ada Lovelace",
          team: "Platform",
          project: "Agent Platform",
          harnessType: "claude",
          model: "claude-sonnet-4",
          sessionCount: 1,
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          estimatedCost: 0,
        },
      ],
    });
  });
  it("keyset-paginates the export and aggregates across batches", async () => {
    const makeExportSession = (artifactId: string) => ({
      artifactId,
      sessionStartedAt: SESSION_STARTED_AT,
      harness: "claude",
      model: "claude-sonnet-4",
      user: {
        id: "user-1",
        email: "ada@example.com",
        firstName: "Ada",
        lastName: "Lovelace",
        avatarUrl: null,
        teamMemberships: [{ team: { name: "Platform" } }],
      },
      artifact: { project: { name: "Agent Platform" } },
      tokenUsageByModel: [],
    });

    // First page is exactly full (EXPORT_BATCH_SIZE = 1000) so the loop fetches a
    // second page; both pages share one aggregation key.
    const firstPage = Array.from({ length: 1000 }, (_unused, index) =>
      makeExportSession(`s-${index}`)
    );
    const secondPage = [makeExportSession("s-1000")];
    const findMany = vi
      .fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage);

    installDb({
      sessionDetail: { findMany },
      organization: {
        findUnique: vi.fn().mockResolvedValue({ slug: "closedloop" }),
      },
    });

    const result = await agentSessionsService.findExportRows({
      organizationId: "org-1",
      filters: {},
    });

    // 1000 + 1 sessions collapse into a single aggregated row.
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.sessionCount).toBe(1001);

    // Two queries: the second is cursored on the last artifactId of page one.
    expect(findMany).toHaveBeenCalledTimes(2);
    const secondCallArg = findMany.mock.calls[1]?.[0] as {
      take: number;
      skip: number;
      cursor: { artifactId: string };
    };
    expect(secondCallArg.take).toBe(1000);
    expect(secondCallArg.skip).toBe(1);
    expect(secondCallArg.cursor).toEqual({ artifactId: "s-999" });
  });
});
