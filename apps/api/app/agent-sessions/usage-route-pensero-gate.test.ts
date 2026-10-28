import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../../__tests__/utils/auth-helpers";

let mockAuthContext: AuthContext;

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: unknown, context?: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, context?.params ?? Promise.resolve({})),
}));

vi.mock("./service", () => ({
  agentSessionsService: { getUsageSummary: vi.fn() },
}));

vi.mock("@/app/branches/branch-pensero-numerator", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/app/branches/branch-pensero-numerator")
  >()),
  isPenseroPointsPerDollarEnabled: vi.fn(),
}));

import { isPenseroPointsPerDollarEnabled } from "@/app/branches/branch-pensero-numerator";
import { agentSessionsService } from "./service";
import { GET as getUsage } from "./usage/route";

/**
 * ISS-11117, PR #7863 — BOTH arms of the Pensero reader gate on the Sessions
 * usage route.
 *
 * The route hands its service a points reader only when the request's two
 * terms describe one population.
 *
 * The DATE axis is reconciled rather than refused: the reader carries the
 * request's window down to the delivery fold, so a 7/30/90-day view — which is
 * every view the listing opens on — gets a numerator over the same period its
 * cost divisor covers (tamsinb, chatgpt-codex-connector, PR #7863).
 *
 * Every OTHER narrowing facet still withholds: the numerator is branch-keyed
 * and the divisor session-keyed, so a facet that splits one branch's sessions
 * has no counterpart in the points total
 * (chatgpt-codex-connector / pensero-population-alignment.ts).
 *
 * The positive arms are what make the negative ones mean anything: without them
 * a gate that returned `undefined` unconditionally — which is what deleting the
 * feature looks like — would pass every withholding case below.
 */
describe("sessions usage route: the Pensero reader gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
    vi.mocked(isPenseroPointsPerDollarEnabled).mockResolvedValue(true);
    vi.mocked(agentSessionsService.getUsageSummary).mockResolvedValue({
      apiEstimatedCost: 0,
      byHarness: [],
      byModel: [],
      byRepository: [],
      byUser: [],
      earliestSessionAt: null,
      latestSessionAt: null,
      lastSyncTargets: [],
      subscriptionEstimatedCost: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      totalEstimatedCost: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalSessions: 0,
      viewerScope: AgentSessionViewerScope.Organization,
    });
  });

  it.each([
    ["an all-time, unfiltered request", ""],
    // The listing's own default view. This is the case the shipped gate failed:
    // `DEFAULT_DATE_RANGE` is `Last7Days`, so a reader inside the rollout saw
    // LOC/$ on the page as it loads and Pts / $ only after switching to All
    // time.
    ["a bounded window", "?startDate=2026-09-01&endDate=2026-09-24"],
    ["a half-open window", "?startDate=2026-09-01"],
    // The listing also sends `attribution=omit` (ISS-11204). The reader must
    // still be handed over — `usage-summary.ts` reads the branch set for it.
    ["a lens-omitting request", "?attribution=omit"],
  ])("PASSES a reader for %s", async (_name, search) => {
    await call(search);

    expect(readerArgument()).toEqual(expect.any(Function));
  });

  it.each([
    ["a model facet", "?models=claude-opus"],
    ["a repository facet", "?repositories=closedloop-ai%2Fclosedloop-ai"],
    ["a quality segment", "?quality=substantive"],
  ])("WITHHOLDS the reader for %s", async (_name, search) => {
    await call(search);

    expect(readerArgument()).toBeUndefined();
  });

  // ISS-11895: a reader's presence makes the summary read the branch set,
  // so outside the rollout — where it could only answer `null` — none is built.
  it("WITHHOLDS the reader outside the Pensero rollout", async () => {
    vi.mocked(isPenseroPointsPerDollarEnabled).mockResolvedValue(false);

    await call("?attribution=omit");

    expect(isPenseroPointsPerDollarEnabled).toHaveBeenCalledExactlyOnceWith({
      userId: mockAuthContext.user.id,
      clerkUserId: mockAuthContext.clerkUserId,
    });
    expect(readerArgument()).toBeUndefined();
  });
});

function call(search: string) {
  return getUsage(
    createMockRequest({
      url: `http://localhost:3002/api/agent-sessions/usage${search}`,
    }),
    createMockRouteContext({})
  );
}

function readerArgument(): unknown {
  const call_ = vi.mocked(agentSessionsService.getUsageSummary).mock.calls[0];
  return call_?.[1];
}
