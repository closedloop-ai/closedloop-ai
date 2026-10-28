/**
 * ISS-8554 — does the usage ROUTE, and since Phase 3 the LIST route, resolve
 * the TypedSQL shadow flag and actually run the comparison behind it?
 *
 * `service/usage-summary-sql*.test.ts` drive the candidate composer and the
 * differ directly, so they prove the SQL path builds and diffs. None of them
 * reaches the route. Before this file, deleting `resolveUsageTypedSqlShadow`
 * from the route's `Promise.all` and the `shadowUsageSummary` call below it left
 * every suite in the PR green and the shadow permanently dark — which is the
 * same hole `loc-per-dollar-basis-route-gate.integration.test.ts` was written
 * to close for its own gate (marisolashgrove on #6281).
 *
 * THE LIST ROUTE REOPENED THAT HOLE and the second describe closes it: Phase 3
 * added `resolveSqlNativeSingleSortRequest` + `shadowSessionListSort` to the
 * list GET with nothing reaching either, so deleting the `waitUntil` or
 * breaking the resolver kept CI green (tamsinb on #8670). The list cases live
 * here rather than in their own file because they pin the SAME gate through a
 * second caller.
 *
 * The gate runs for real; only PostHog's answer is stubbed, so the fail-closed
 * branch is on the path under test. `@repo/analytics/feature-flags` is mocked
 * rather than the `analytics` client for the reason the sibling documents: the
 * client is reached through a DYNAMIC import and the route resolves three gates
 * concurrently, so mocking the module the gate imports STATICALLY is the only
 * deterministic seam.
 *
 * The shadow module itself is mocked. This file is about whether the route
 * REACHES it, and running the real one would need the whole TypedSQL path and a
 * database.
 */
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../../__tests__/utils/auth-helpers";

let mockAuthContext: AuthContext;

/**
 * A request principal belonging to THIS FILE.
 *
 * Feature-flag decisions are published to a Postgres record keyed on the
 * viewer's distinct ids, and `apps/api` suites run concurrently against ONE
 * database — so on the shared default principal a write from here would be
 * inherited by another file's fail-closed assertion. Since #6885 no gate on
 * this route is store-backed, so there is no such write to contain today;
 * these ids stay as standing containment. See the describe's tier note.
 */
const VIEWER_USER_ID = "iss8554-shadow-gate-user";
const VIEWER_CLERK_ID = "clerk_iss8554_shadow_gate";

const mocks = vi.hoisted(() => {
  /** Every promise handed to `waitUntil`, so a case can await it. */
  const waitUntilPromises: Promise<unknown>[] = [];
  return {
    existsInOrganization: vi.fn(),
    isMember: vi.fn(),
    getOrgAdminStatus: vi.fn(),
    shadowUsageSummary: vi.fn(),
    shadowSessionListSort: vi.fn(),
    shadowSessionListCompoundSort: vi.fn(),
    waitUntilPromises,
    waitUntil: vi.fn((promise: Promise<unknown>) => {
      // The OBSERVED promise is what gets stored, so a case can await it and a
      // rejected diagnostic can never orphan. The mock still RECEIVES the
      // original, which is what the identity assertion checks.
      //
      // Unmocked, the real `waitUntil` outside a Vercel request context is
      // `getContext().waitUntil?.(promise)` -- an optional call on an empty
      // object, i.e. a no-op that drops the promise. This file then could not
      // tell `waitUntil(p)` from the floated `p` it replaced (review on #6281).
      waitUntilPromises.push(promise.catch(() => undefined));
    }),
  };
});

vi.mock("@vercel/functions", () => ({ waitUntil: mocks.waitUntil }));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<unknown>) =>
    async (request: unknown, context: { params?: unknown }): Promise<unknown> =>
      handler(mockAuthContext, request, context?.params ?? Promise.resolve({})),
}));

vi.mock("@/app/teams/service", () => ({
  teamsService: {
    existsInOrganization: mocks.existsInOrganization,
    isMember: mocks.isMember,
  },
}));

vi.mock("@/lib/auth/org-admin", () => ({
  getOrgAdminStatus: mocks.getOrgAdminStatus,
}));

vi.mock("./service", () => ({
  agentSessionsService: {
    getUsageSummary: vi.fn(),
    findSessions: vi.fn(),
  },
}));

vi.mock("./service/usage-summary-shadow", () => ({
  shadowUsageSummary: mocks.shadowUsageSummary,
}));

// Mocked for the reason the usage shadow above is: this file asks whether the
// route REACHES the comparison. `resolveSqlNativeSingleSortRequest` and
// `resolveSqlNativeCompoundSortRequest` are NOT mocked — the list cases below
// drive them for real off the request's query string, so a broken resolver
// reds them.
vi.mock("./service/session-list-sort-shadow", () => ({
  shadowSessionListSort: mocks.shadowSessionListSort,
  shadowSessionListCompoundSort: mocks.shadowSessionListCompoundSort,
}));

// `null` is the "PostHog did not answer" state — the only way evaluation
// reports UNAVAILABLE without throwing, which is what the fail-closed case needs.
const flagMocks = vi.hoisted(() => ({
  isFeatureFlagEnabledForDistinctId: vi.fn(),
}));

vi.mock("@repo/analytics/feature-flags", () => ({
  isFeatureFlagEnabledForDistinctId:
    flagMocks.isFeatureFlagEnabledForDistinctId,
  // ISS-12048: the gate asks for a pinned snapshot first; none is pinned here.
  readPinnedFeatureFlags: () => Promise.resolve(null),
}));

import { AgentSessionListCapability } from "@repo/api/src/types/agent-session-list-contract";
import { ORG_ADMIN_STATUS_NOT_ADMIN } from "@/__tests__/support/auth/org-admin-gate.test-fixtures";
import { GET as getSessions } from "./route";
import { clearUsageTypedSqlShadowDecisions } from "./route-helpers";
import { agentSessionsService } from "./service";
import { SESSIONS_USAGE_TYPED_SQL_SHADOW_FLAG_KEY } from "./service/usage-summary-sql";
import { GET as getUsage } from "./usage/route";

/**
 * ISS-8962 tier: this suite is a UNIT test and needs no database.
 *
 * It had exactly one line of DB access — a `purgeFeatureFlagDecisions` in
 * `beforeEach`, the only call on this path that PROPAGATES instead of
 * swallowing — so its throw on missing IAM credentials failed all four cases
 * before a single assertion ran. Removing it is the whole fix.
 *
 * IT WAS NEVER A SAFEGUARD. The purge deleted rows under
 * `sessions-usage-typed-sql-shadow`, and the shadow gate under test has no
 * `sharedDecisionStore`, so nothing has ever published under that key. What
 * once made this suite write at all was the LOC/$ cost-basis sibling resolved
 * in the same `Promise.all`, which the per-key stubs below answer with a
 * non-null `false` rather than an unavailable. #6885 deleted that flag, its
 * gate and its store wiring. ISS-11073 made the guided required-phases gate
 * store-backed again, but under its own flag key, so nothing it publishes is
 * readable here either.
 *
 * MEASURED against a reachable Postgres, table emptied first: the suite passes
 * and `feature_flag_decisions` holds 0 rows. It passes with the database
 * unreachable too, because `read` and `publish` each catch and log
 * `feature_flag_decision_store_unavailable` by design — only the purge ever
 * propagated, and it protected nothing this suite could write.
 */
describe("Sessions TypedSQL shadow route gate (ISS-8554)", () => {
  beforeEach(() => {
    primeSharedRouteMocks();
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

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the shadow comparison when the flag is ENABLED", async () => {
    // Answers for THIS key only, so a route that hard-coded `true` — or read
    // some other flag — cannot reach the shadow. ISS-10742 removed the sibling
    // parity gate this case also used to assert stayed closed; the per-key
    // implementation below is what carries the key-specificity now.
    flagMocks.isFeatureFlagEnabledForDistinctId.mockImplementation(
      (flagKey: string) =>
        Promise.resolve(flagKey === SESSIONS_USAGE_TYPED_SQL_SHADOW_FLAG_KEY)
    );
    const shadowReturn = Promise.resolve();
    mocks.shadowUsageSummary.mockReturnValue(shadowReturn);

    const response = await getUsage(usageRequest(), createMockRouteContext({}));

    expect(response.status).toBe(200);
    expect(mocks.shadowUsageSummary).toHaveBeenCalledTimes(1);
    // THE ROUTE HANDS THE PROMISE TO waitUntil. Asserted on identity, not on
    // shape: floating the call would leave `waitUntil` uncalled, and this is the
    // only assertion in the file that separates the two.
    expect(mocks.waitUntil).toHaveBeenCalledTimes(1);
    expect(mocks.waitUntil).toHaveBeenCalledWith(shadowReturn);
    // The LIVE summary is handed in rather than re-read, so the diff describes
    // the response this request actually returned.
    expect(mocks.shadowUsageSummary).toHaveBeenCalledWith(
      expect.objectContaining({ viewerId: VIEWER_USER_ID }),
      expect.objectContaining({ totalSessions: 0 })
    );
  });

  it("does NOT run the shadow when the flag is off", async () => {
    flagMocks.isFeatureFlagEnabledForDistinctId.mockResolvedValue(false);

    const response = await getUsage(usageRequest(), createMockRouteContext({}));

    expect(response.status).toBe(200);
    expect(mocks.shadowUsageSummary).not.toHaveBeenCalled();
  });

  it("fails CLOSED when the flag cannot be evaluated", async () => {
    // `null` is UNAVAILABLE — no analytics client, or a flag the project does
    // not define yet. A closed shadow gate costs one missing diagnostic; an open
    // one costs a duplicate read of the whole summary, so closed is the correct
    // default and this pins it.
    flagMocks.isFeatureFlagEnabledForDistinctId.mockResolvedValue(null);

    const response = await getUsage(usageRequest(), createMockRouteContext({}));

    expect(response.status).toBe(200);
    expect(mocks.shadowUsageSummary).not.toHaveBeenCalled();
  });

  it("still answers the reader when the shadow rejects", async () => {
    // The shadow is handed to `waitUntil`, so a rejection must not reach the
    // response. Its own `.catch()` normally makes this unreachable; this pins
    // that the ROUTE does not await it into the response path either.
    flagMocks.isFeatureFlagEnabledForDistinctId.mockImplementation(
      (flagKey: string) =>
        Promise.resolve(flagKey === SESSIONS_USAGE_TYPED_SQL_SHADOW_FLAG_KEY)
    );
    mocks.shadowUsageSummary.mockRejectedValue(new Error("shadow exploded"));

    const response = await getUsage(usageRequest(), createMockRouteContext({}));

    expect(response.status).toBe(200);
    expect(mocks.shadowUsageSummary).toHaveBeenCalledTimes(1);
    expect(mocks.waitUntil).toHaveBeenCalledTimes(1);
    // Settled here rather than left to the worker: an orphaned rejection is a
    // cross-file flake, and awaiting it is what proves the route never joined
    // it to the response path.
    await expect(
      Promise.allSettled(mocks.waitUntilPromises)
    ).resolves.toHaveLength(1);
  });
});

function usageRequest() {
  return createMockRequest({
    url: "http://localhost:3002/agent-sessions/usage",
  });
}

/**
 * ISS-8554 Phase 3 (tamsinb on #8670) — the LIST route's half of the same
 * gate, which nothing reached before this describe.
 *
 * Each case drives the real `resolveSqlNativeSingleSortRequest` off the request
 * URL, so the three shapes that decide the branch are the ones production
 * decides on: a single `updated` rule, the gate's answer, and a compound chain.
 */
describe("Sessions list TypedSQL sort shadow route gate (ISS-8554 Phase 3)", () => {
  beforeEach(() => {
    primeSharedRouteMocks();
    pageResolved = false;
    vi.mocked(agentSessionsService.findSessions).mockResolvedValue(
      listResponse()
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the list-sort shadow for a single `updated` rule when the flag is ENABLED", async () => {
    flagMocks.isFeatureFlagEnabledForDistinctId.mockImplementation(
      (flagKey: string) =>
        Promise.resolve(flagKey === SESSIONS_USAGE_TYPED_SQL_SHADOW_FLAG_KEY)
    );
    const shadowReturn = Promise.resolve();
    mocks.shadowSessionListSort.mockReturnValue(shadowReturn);

    const response = await getSessions(
      listRequest("sortBy=updated&sortDir=desc"),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    expect(mocks.shadowSessionListSort).toHaveBeenCalledTimes(1);
    // Identity, as in the usage case: floating the call would leave `waitUntil`
    // uncalled, and this is the only assertion that separates the two.
    expect(mocks.waitUntil).toHaveBeenCalledTimes(1);
    expect(mocks.waitUntil).toHaveBeenCalledWith(shadowReturn);
    // The RESOLVED request, the page actually served, and the live page's own
    // `updated` keys — the three arguments the comparison cannot be trusted
    // without.
    expect(mocks.shadowSessionListSort).toHaveBeenCalledWith(
      expect.objectContaining({ viewerId: VIEWER_USER_ID }),
      { column: "updated", dir: "desc" },
      SERVED_PAGE_OFFSET,
      SERVED_PAGE_LIMIT,
      [
        {
          id: LISTED_SESSION_ID,
          recordUpdatedAtMs: RECORD_UPDATED_AT.getTime(),
        },
      ]
    );
  });

  it(
    "asks the gate WHILE the page read is still outstanding, never after it",
    async () => {
      // The page cannot settle until this test releases it, so the ordering
      // below is decided by the route's structure rather than by a clock.
      let releasePage = (): void => undefined;
      const pageReleased = new Promise<void>((resolve) => {
        releasePage = () => resolve();
      });
      vi.mocked(agentSessionsService.findSessions).mockImplementation(() =>
        pageReleased.then(() => {
          pageResolved = true;
          return listResponse();
        })
      );
      let markGateAsked = (): void => undefined;
      const gateWasAsked = new Promise<void>((resolve) => {
        markGateAsked = () => resolve();
      });
      flagMocks.isFeatureFlagEnabledForDistinctId.mockImplementation(
        (flagKey: string) => {
          markGateAsked();
          return Promise.resolve(
            flagKey === SESSIONS_USAGE_TYPED_SQL_SHADOW_FLAG_KEY
          );
        }
      );

      const pending = getSessions(
        listRequest("sortBy=updated&sortDir=desc"),
        createMockRouteContext({})
      );

      // Settles only because the two start together in one `Promise.all`.
      // Awaiting the gate AFTER `findSessions` — the serial shape this replaced,
      // which charges the reader a possible PostHog round trip to decide a
      // diagnostic (tamsinb on #8670) — never reaches the gate at all while the
      // page is held, and the case fails on its timeout.
      await gateWasAsked;
      expect(pageResolved).toBe(false);

      releasePage();
      const response = await pending;
      expect(response.status).toBe(200);
    },
    GATE_ORDERING_TIMEOUT_MS
  );

  it("does NOT run the list-sort shadow when the flag is off", async () => {
    flagMocks.isFeatureFlagEnabledForDistinctId.mockResolvedValue(false);

    const response = await getSessions(
      listRequest("sortBy=updated&sortDir=desc"),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    expect(mocks.shadowSessionListSort).not.toHaveBeenCalled();
  });

  it("fails CLOSED for the list route when the flag cannot be evaluated", async () => {
    flagMocks.isFeatureFlagEnabledForDistinctId.mockResolvedValue(null);

    const response = await getSessions(
      listRequest("sortBy=updated&sortDir=desc"),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    expect(mocks.shadowSessionListSort).not.toHaveBeenCalled();
  });

  it("runs the list-sort shadow for a COMPOUND chain (2-4 rules) when the flag is ENABLED", async () => {
    flagMocks.isFeatureFlagEnabledForDistinctId.mockImplementation(
      (flagKey: string) =>
        Promise.resolve(flagKey === SESSIONS_USAGE_TYPED_SQL_SHADOW_FLAG_KEY)
    );
    const shadowReturn = Promise.resolve();
    mocks.shadowSessionListCompoundSort.mockReturnValue(shadowReturn);

    const response = await getSessions(
      listRequest("sorts=updated%3Adesc&sorts=repo%3Aasc"),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    expect(mocks.shadowSessionListSort).not.toHaveBeenCalled();
    expect(mocks.shadowSessionListCompoundSort).toHaveBeenCalledTimes(1);
    expect(mocks.waitUntil).toHaveBeenCalledTimes(1);
    expect(mocks.waitUntil).toHaveBeenCalledWith(shadowReturn);
    expect(mocks.shadowSessionListCompoundSort).toHaveBeenCalledWith(
      expect.objectContaining({ viewerId: VIEWER_USER_ID }),
      [
        { column: "updated", dir: "desc" },
        { column: "repo", dir: "asc" },
      ],
      SERVED_PAGE_OFFSET,
      SERVED_PAGE_LIMIT,
      [
        {
          id: LISTED_SESSION_ID,
          recordUpdatedAtMs: RECORD_UPDATED_AT.getTime(),
        },
      ]
    );
  });

  it("leaves a chain beyond the four-rule cap untouched, and does not read the gate for it", async () => {
    flagMocks.isFeatureFlagEnabledForDistinctId.mockImplementation(
      (flagKey: string) =>
        Promise.resolve(flagKey === SESSIONS_USAGE_TYPED_SQL_SHADOW_FLAG_KEY)
    );

    const response = await getSessions(
      listRequest(
        "sorts=updated%3Adesc&sorts=repo%3Aasc&sorts=harness%3Aasc&sorts=model%3Adesc&sorts=cost%3Aasc"
      ),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    expect(mocks.shadowSessionListSort).not.toHaveBeenCalled();
    expect(mocks.shadowSessionListCompoundSort).not.toHaveBeenCalled();
    // D15's cap keeps the in-memory path for a chain beyond four rules, so the
    // flag is not worth a round trip — the gate resolves to a literal `false`
    // instead of being read. Asserted on the KEYS read rather than on call
    // arity, so another gate on this route can neither satisfy nor break it.
    const flagKeysRead =
      flagMocks.isFeatureFlagEnabledForDistinctId.mock.calls.map(
        (call: unknown[]) => call[0]
      );
    expect(flagKeysRead).not.toContain(
      SESSIONS_USAGE_TYPED_SQL_SHADOW_FLAG_KEY
    );
  });
});

function listRequest(query: string) {
  return createMockRequest({
    url: `http://localhost:3002/agent-sessions?${query}`,
  });
}

/**
 * Everything both describes need: the request principal, the team-scope
 * answers, the fail-closed flag default, and a cleared gate memo.
 */
function primeSharedRouteMocks(): void {
  vi.clearAllMocks();
  mocks.waitUntilPromises.length = 0;
  mockAuthContext = createTestAuthContext({
    user: {
      ...createTestAuthContext().user,
      id: VIEWER_USER_ID,
      clerkId: VIEWER_CLERK_ID,
    },
    clerkUserId: VIEWER_CLERK_ID,
  });
  mocks.existsInOrganization.mockResolvedValue(true);
  mocks.isMember.mockResolvedValue(true);
  mocks.getOrgAdminStatus.mockResolvedValue(ORG_ADMIN_STATUS_NOT_ADMIN);
  // Resolves, because the routes hand these to `waitUntil` — a rejected or
  // non-thenable return would surface there rather than being swallowed.
  mocks.shadowUsageSummary.mockResolvedValue(undefined);
  mocks.shadowSessionListSort.mockResolvedValue(undefined);
  mocks.shadowSessionListCompoundSort.mockResolvedValue(undefined);
  // `mockReset`, not `clearAllMocks`: the latter keeps the implementation, so
  // a stub from an earlier case would survive and make the UNAVAILABLE default
  // unreachable.
  flagMocks.isFeatureFlagEnabledForDistinctId.mockReset();
  flagMocks.isFeatureFlagEnabledForDistinctId.mockResolvedValue(null);
  // The gate memoizes per viewer, and every case here drives the same
  // principal, so each test needs a clear to reach its named branch.
  clearUsageTypedSqlShadowDecisions();
}

/** Whether the held page read has settled, for the gate-ordering case. */
let pageResolved = false;

/**
 * Explicit, because the gate-ordering case's failure mode IS a hang: under the
 * serial shape it replaced, the gate is never reached while the page is held.
 */
const GATE_ORDERING_TIMEOUT_MS = 5000;

const LISTED_SESSION_ID = "11111111-1111-4111-8111-111111111111";
const RECORD_UPDATED_AT = new Date("2026-10-09T12:00:00.000Z");
const SERVED_PAGE_OFFSET = 20;
const SERVED_PAGE_LIMIT = 25;

/**
 * A one-row page whose `pageInfo` differs from the list's defaults, so the
 * assertion above pins the offset/limit the response REPORTS rather than ones a
 * route could have re-derived from the request.
 */
function listResponse() {
  return {
    items: [
      {
        id: LISTED_SESSION_ID,
        recordUpdatedAt: RECORD_UPDATED_AT,
      },
    ],
    total: 1,
    pageInfo: {
      capability: AgentSessionListCapability.ServerPaginationV1,
      limit: SERVED_PAGE_LIMIT,
      offset: SERVED_PAGE_OFFSET,
    },
  } as never;
}
