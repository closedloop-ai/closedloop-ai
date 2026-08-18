import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentSessionDbMock,
  installDb,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { agentSessionsService } from "../service";

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

// FEA-4303 (thread wongk): pin the Model facet wiring through the real
// `getUsageSummary`. `modelFilterOptions` must come from the PRIMARY-model
// `sessionDetail.groupBy({ by: ["model"] })` (the value the table's Model column
// paints), and `byModel` from the per-token-usage
// `agentSessionTokenUsage.groupBy({ by: ["model"] })` (which spans
// secondary/subagent models). Feeding the two groupBys DIFFERENT model sets
// proves they map from distinct sources and cannot silently collapse into one.
describe("agentSessionsService.getUsageSummary — Model facet vs byModel (FEA-4303)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sources modelFilterOptions from the primary-model groupBy, distinct from byModel", async () => {
    installDb({
      sessionDetail: buildAgentSessionDbMock({
        aggregate: vi.fn().mockResolvedValue({
          _count: { _all: 3 },
          _sum: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            estimatedCost: 0,
          },
          _min: { sessionStartedAt: new Date("2026-03-01T10:00:00.000Z") },
          _max: { sessionStartedAt: new Date("2026-03-01T10:00:00.000Z") },
        }),
        groupBy: vi
          .fn()
          // byUser
          .mockResolvedValueOnce([])
          // byHarness
          .mockResolvedValueOnce([])
          // byRepository
          .mockResolvedValueOnce([])
          // cost split (sourceLoopId + billingMode)
          .mockResolvedValueOnce([])
          // FEA-4303: primary-model facet groupBy (by `model`). TWO primary
          // models — the ONLY values the Model column can show.
          .mockResolvedValueOnce([
            { model: "claude-opus", _count: { _all: 2 } },
            { model: "claude-sonnet", _count: { _all: 1 } },
            // A null-primary-model group is dropped (no Model value to filter to).
            { model: null, _count: { _all: 5 } },
          ]),
      }),
      // byModel spans a DIFFERENT set: it includes a subagent model
      // ("claude-haiku") that is NEVER a primary model, and omits one primary
      // ("claude-sonnet"). If the two fields shared a source they could not differ.
      agentSessionTokenUsage: {
        groupBy: vi.fn().mockResolvedValue([
          {
            model: "claude-opus",
            _count: { _all: 2 },
            _sum: {
              inputTokens: 100,
              outputTokens: 50,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              estimatedCost: 1,
            },
          },
          {
            model: "claude-haiku",
            _count: { _all: 3 },
            _sum: {
              inputTokens: 30,
              outputTokens: 10,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              estimatedCost: 0.2,
            },
          },
        ]),
      },
      computeTarget: { findMany: vi.fn().mockResolvedValue([]) },
      user: { findMany: vi.fn().mockResolvedValue([]) },
      loop: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const summary = await agentSessionsService.getUsageSummary({
      organizationId: "org-1",
      filters: {},
    });

    // modelFilterOptions: only the two primary models, null dropped, count desc.
    expect(summary.modelFilterOptions).toEqual([
      { model: "claude-opus", sessionCount: 2 },
      { model: "claude-sonnet", sessionCount: 1 },
    ]);

    // byModel: the token-usage set, which carries the subagent-only model.
    expect(summary.byModel.map((entry) => entry.model)).toEqual([
      "claude-opus",
      "claude-haiku",
    ]);

    // The load-bearing invariant: the two vocabularies are distinct. A model that
    // is only a subagent model appears in byModel but NEVER as a facet option.
    const facetModels = summary.modelFilterOptions?.map((o) => o.model) ?? [];
    expect(facetModels).not.toContain("claude-haiku");
    const byModelModels = summary.byModel.map((entry) => entry.model);
    expect(byModelModels).toContain("claude-haiku");
    expect(byModelModels).not.toContain("claude-sonnet");
  });
});
