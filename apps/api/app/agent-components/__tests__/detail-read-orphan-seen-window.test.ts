/**
 * ISS-5577: an orphan-only (used-only) detail must report the observation window
 * its own usage rows prove, never the moment the request was served.
 *
 * `buildOrphanOnlyDetail` stamped `new Date()` into `firstSeenAt`/`lastSeenAt`,
 * so a production fetch issued at 14:21:03Z came back claiming
 * `firstSeenAt: 14:21:04.172Z` — a fact about the response, not about the
 * component. The clock is pinned here and the seeded usage bounds sit months in
 * the past, so an assertion on the returned value cannot pass under the old
 * behaviour: "a valid date" and "not null" were both already true of the bug.
 *
 * The review pass (wongk) widened this file to the rest of that contract: the
 * LIST producer honouring the same "never the request clock" promise, the usage
 * lanes and the seen-bounds aggregate sharing ONE `RepeatableRead` snapshot, and
 * a rejected aggregate degrading to an unknown window instead of a 500.
 */
import {
  AgentComponentKind,
  ComponentResolvedState,
} from "@repo/api/src/types/agent-component";
import { encodeComponentSlug } from "@repo/api/src/types/agent-component-analytics";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildComputeTarget,
  buildInventoryRow,
  buildServiceDb,
} from "@/app/agent-components/__tests__/service-db-double";
import { MAX_ORG_ORPHAN_USAGE_ROWS } from "@/app/agent-components/plugin-child-usage";
import { DETAIL_USAGE_SNAPSHOT_TX_TIMEOUT_MS } from "@/app/agent-components/service/detail-usage-identity";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  listByArtifactIds: vi.fn(),
  logError: vi.fn(),
  // Both the inventory-present detail and (ISS-5577) the orphan-only path take
  // their usage reads under a `withDb.tx({ isolationLevel: … })` snapshot, so the
  // mocked module must expose that enum value.
  Prisma: { TransactionIsolationLevel: { RepeatableRead: "RepeatableRead" } },
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
  Prisma: mocks.Prisma,
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    error: mocks.logError,
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("../../agent-sessions/service", () => ({
  agentSessionsService: {
    listByArtifactIds: mocks.listByArtifactIds,
  },
}));

import { agentComponentsService } from "../service";

const ORGANIZATION_ID = "org-1";
const SESSION_ID = "session-orphan";
const COMPONENT_KEY = "my-skill";
const ORPHAN_SLUG = encodeComponentSlug(
  AgentComponentKind.Skill,
  COMPONENT_KEY,
  null
);

/** The instant the request is served. Nothing in the response may echo it. */
const REQUEST_NOW = new Date("2026-08-13T14:21:03.000Z");
/** The window the usage rows actually prove — months before the request. */
const FIRST_INVOKED_AT = new Date("2026-01-04T09:30:00.000Z");
const LAST_INVOKED_AT = new Date("2026-03-21T18:45:00.000Z");
/** Older still — only reachable via the uncapped aggregate, never the fold. */
const TRUNCATED_FIRST_INVOKED_AT = new Date("2025-09-02T07:15:00.000Z");
const AGGREGATE_FAILURE_MESSAGE = "statement timeout";
/** The options every `withDb.tx` in a case was opened with, in call order. */
const capturedTxOptions: TxOptions[] = [];

type SeenBounds = {
  firstInvokedAt: Date | null;
  lastInvokedAt: Date | null;
};

function orphanUsageRow(bounds: SeenBounds) {
  return {
    agentSessionId: SESSION_ID,
    invocationCount: 3,
    errorCount: 0,
    gitBranch: "",
    harness: "claude",
    componentKind: AgentComponentKind.Skill,
    componentKey: COMPONENT_KEY,
    definitionVersionId: null,
    firstInvokedAt: bounds.firstInvokedAt,
    lastInvokedAt: bounds.lastInvokedAt,
    session: {
      artifactId: SESSION_ID,
      artifact: { organizationId: ORGANIZATION_ID },
    },
  };
}

/**
 * Install an orphan-only `db` whose single usage lane returns `rows` and whose
 * uncapped aggregate — the truncated-lane fallback — would report
 * `aggregateBounds`. The two are deliberately DIFFERENT in every case so an
 * assertion on the returned window says which path produced it. The aggregate
 * delegate is returned so a test can prove it was, or was not, issued.
 */
function installOrphanOnlyDb(
  rows: readonly ReturnType<typeof orphanUsageRow>[],
  aggregateBounds: SeenBounds = { firstInvokedAt: null, lastInvokedAt: null }
) {
  const client = buildOrphanOnlyClient(rows, aggregateBounds);
  installClients(client.db);
  return client.aggregate;
}

/**
 * One orphan-only client double. Built separately from installation so a case can
 * hand the POOLED and the SNAPSHOT client materially different worlds — which is
 * how the relink hazard below is made observable.
 */
function buildOrphanOnlyClient(
  rows: readonly ReturnType<typeof orphanUsageRow>[],
  aggregateBounds: SeenBounds = { firstInvokedAt: null, lastInvokedAt: null },
  aggregateRejects = false
) {
  const aggregate = vi.fn(async (_args: AggregateArgs) => {
    await Promise.resolve();
    if (aggregateRejects) {
      throw new Error(AGGREGATE_FAILURE_MESSAGE);
    }
    return {
      _min: { firstInvokedAt: aggregateBounds.firstInvokedAt },
      _max: { lastInvokedAt: aggregateBounds.lastInvokedAt },
    };
  });
  const resolved = <T>(value: T) => vi.fn(async (): Promise<T> => value);

  const db = {
    agentComponent: { findMany: resolved([]) },
    agentComponentSessionUsage: {
      findMany: resolved(rows),
      aggregate,
    },
    artifactLink: { findMany: resolved([]) },
    sessionDetail: { findMany: resolved([]) },
    agentComponentInvocation: {
      findMany: resolved([]),
      groupBy: resolved([]),
    },
    definitionVersion: { findMany: resolved([]) },
  };
  return { aggregate, db };
}

/**
 * Route pooled (`withDb`) and snapshot (`withDb.tx`) reads at the given clients,
 * capturing the options each transaction is opened with. They default to the same
 * client; passing two is what lets a case prove WHICH one a read went to.
 */
function installClients(pooled: unknown, snapshot: unknown = pooled) {
  mocks.withDb.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(pooled)
  );
  mocks.withDb.tx.mockImplementation(
    (callback: (client: unknown) => unknown, options?: TxOptions) => {
      capturedTxOptions.push(options ?? {});
      return callback(snapshot);
    }
  );
}

describe("getDetailForOrg — orphan-only seen window (ISS-5577)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedTxOptions.length = 0;
    mocks.listByArtifactIds.mockResolvedValue([]);
    vi.useFakeTimers();
    vi.setSystemTime(REQUEST_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports the usage rows' own invocation window, not the request clock", async () => {
    const aggregate = installOrphanOnlyDb([
      orphanUsageRow({
        firstInvokedAt: FIRST_INVOKED_AT,
        lastInvokedAt: LAST_INVOKED_AT,
      }),
    ]);

    const result = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      ORPHAN_SLUG
    );

    expect(result?.firstSeenAt).toBe(FIRST_INVOKED_AT.toISOString());
    expect(result?.lastSeenAt).toBe(LAST_INVOKED_AT.toISOString());
    // The exact defect: the served-at instant must appear in neither field.
    expect(result?.firstSeenAt).not.toBe(REQUEST_NOW.toISOString());
    expect(result?.lastSeenAt).not.toBe(REQUEST_NOW.toISOString());
    // No lane hit its cap, so the fetched rows ARE the whole population and the
    // extra uncapped aggregate must not be issued at all.
    expect(aggregate).not.toHaveBeenCalled();
  });

  it("reports an empty window when no usage row recorded a timestamp", async () => {
    installOrphanOnlyDb([
      orphanUsageRow({ firstInvokedAt: null, lastInvokedAt: null }),
    ]);

    const result = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      ORPHAN_SLUG
    );

    // Honest-absent, not a plausible-looking stand-in: consumers read an
    // unparseable value as unknown, and a `now` here would be indistinguishable
    // from a component genuinely first seen this second.
    expect(result?.firstSeenAt).toBe("");
    expect(result?.lastSeenAt).toBe("");
  });

  /**
   * The truncation case is the whole reason the aggregate exists: the lane read
   * is ordered `lastInvokedAt desc` and capped, so a capped slice has dropped
   * precisely the OLDEST rows. Folding it would report a `firstSeenAt` that is
   * systematically too recent — plausible, and wrong.
   */
  it("falls back to the uncapped aggregate when a lane came back at its row cap", async () => {
    const cappedRows = Array.from({ length: MAX_ORG_ORPHAN_USAGE_ROWS }, () =>
      orphanUsageRow({
        firstInvokedAt: FIRST_INVOKED_AT,
        lastInvokedAt: LAST_INVOKED_AT,
      })
    );
    const aggregate = installOrphanOnlyDb(cappedRows, {
      firstInvokedAt: TRUNCATED_FIRST_INVOKED_AT,
      lastInvokedAt: LAST_INVOKED_AT,
    });

    const result = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      ORPHAN_SLUG
    );

    expect(aggregate).toHaveBeenCalledOnce();
    // The older instant the dropped rows carried — NOT the fold over the slice.
    expect(result?.firstSeenAt).toBe(TRUNCATED_FIRST_INVOKED_AT.toISOString());
    expect(result?.firstSeenAt).not.toBe(FIRST_INVOKED_AT.toISOString());
  });

  /**
   * wongk (ISS-5577 review): the lane reads and the capped aggregate did not
   * share a snapshot. `AgentComponentSessionUsage.agentComponentId` is rewritten
   * by concurrent usage upserts and the two lanes split on exactly that column,
   * so a relink landing BETWEEN the statements drops the row from both — and when
   * it is the only row, the detail 404s a component that demonstrably exists.
   *
   * The pooled client here IS that post-relink world (the orphan lane no longer
   * answers for the row); the snapshot client is the consistent state the
   * transaction opened at. Reading the lanes off the pool — the pre-fix behaviour
   * — therefore returns null, so this cannot pass without the shared snapshot.
   */
  it("reads the usage lanes under a snapshot, so a concurrent relink cannot 404 the only row", async () => {
    const postRelinkPool = buildOrphanOnlyClient([]);
    const snapshot = buildOrphanOnlyClient([
      orphanUsageRow({
        firstInvokedAt: FIRST_INVOKED_AT,
        lastInvokedAt: LAST_INVOKED_AT,
      }),
    ]);
    installClients(postRelinkPool.db, snapshot.db);

    const result = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      ORPHAN_SLUG
    );

    expect(result).not.toBeNull();
    expect(result?.firstSeenAt).toBe(FIRST_INVOKED_AT.toISOString());
    expect(snapshot.db.agentComponentSessionUsage.findMany).toHaveBeenCalled();
    // The same isolation and timeout the inventory-present path already uses.
    expect(capturedTxOptions[0]?.isolationLevel).toBe(
      mocks.Prisma.TransactionIsolationLevel.RepeatableRead
    );
    expect(capturedTxOptions[0]?.timeout).toBe(
      DETAIL_USAGE_SNAPSHOT_TX_TIMEOUT_MS
    );
  });

  /**
   * The aggregate is the third statement wongk named: a bounds value read outside
   * the snapshot describes a different population than the lanes it claims to
   * summarise.
   */
  it("issues the capped-lane aggregate inside that same snapshot", async () => {
    const cappedRows = Array.from({ length: MAX_ORG_ORPHAN_USAGE_ROWS }, () =>
      orphanUsageRow({
        firstInvokedAt: FIRST_INVOKED_AT,
        lastInvokedAt: LAST_INVOKED_AT,
      })
    );
    const pool = buildOrphanOnlyClient(cappedRows);
    const snapshot = buildOrphanOnlyClient(cappedRows, {
      firstInvokedAt: TRUNCATED_FIRST_INVOKED_AT,
      lastInvokedAt: LAST_INVOKED_AT,
    });
    installClients(pool.db, snapshot.db);

    const result = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      ORPHAN_SLUG
    );

    expect(snapshot.aggregate).toHaveBeenCalledOnce();
    expect(pool.aggregate).not.toHaveBeenCalled();
    expect(result?.firstSeenAt).toBe(TRUNCATED_FIRST_INVOKED_AT.toISOString());
  });

  /**
   * wongk (ISS-5577 review): `firstInvokedAt` carries no index, so this aggregate
   * is the statement that can realistically time out. It turned a window the
   * response can honestly report as UNKNOWN into a 500 for the entire detail.
   *
   * Both halves of the fix are asserted, and each can fail: the response must
   * RESOLVE (pre-fix the rejection propagated), and it must report `""` rather
   * than fold the truncated slice — whose rows carry `FIRST_INVOKED_AT`, so a
   * fallback fold would produce a plausible, systematically-too-recent answer
   * instead of declining to answer.
   */
  it("returns an unknown window, not a 500, when the seen-bounds aggregate rejects", async () => {
    const cappedRows = Array.from({ length: MAX_ORG_ORPHAN_USAGE_ROWS }, () =>
      orphanUsageRow({
        firstInvokedAt: FIRST_INVOKED_AT,
        lastInvokedAt: LAST_INVOKED_AT,
      })
    );
    const failing = buildOrphanOnlyClient(cappedRows, undefined, true);
    installClients(failing.db);

    const result = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      ORPHAN_SLUG
    );

    expect(failing.aggregate).toHaveBeenCalledOnce();
    expect(result?.id).toBe(ORPHAN_SLUG);
    expect(result?.firstSeenAt).toBe("");
    expect(result?.lastSeenAt).toBe("");
    expect(result?.firstSeenAt).not.toBe(FIRST_INVOKED_AT.toISOString());
    // Routed to the monitored server path rather than swallowed.
    expect(mocks.logError).toHaveBeenCalledWith(
      "agent_components_detail_seen_bounds_aggregate_failed",
      expect.objectContaining({
        error: AGGREGATE_FAILURE_MESSAGE,
        kind: AgentComponentKind.Skill,
        organizationId: ORGANIZATION_ID,
      })
    );
  });

  /**
   * The adjacent instance of the same defect: `AgentComponent.firstSeenAt` and
   * `lastSeenAt` are both nullable in `schema.prisma`, so the INVENTORY-present
   * branch's fallback is reachable too — and it stamped the request clock, so a
   * component whose rows never recorded an observation time reported that it was
   * first seen this second.
   */
  it("reports an empty window when the inventory rows carry no seen timestamps", async () => {
    installInventoryOnlyDb();

    const result = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      encodeComponentSlug(AgentComponentKind.Mcp, INVENTORY_KEY, null)
    );

    expect(result?.id).toBe(INVENTORY_ID);
    expect(result?.firstSeenAt).toBe("");
    expect(result?.lastSeenAt).toBe("");
  });
});

/**
 * wongk (ISS-5577 review): the contract on `AgentComponent.firstSeenAt` — "never
 * the time the response was generated" — is written on the type BOTH producers
 * emit, but only the detail path honoured it. `listForOrg` still substituted the
 * request clock for a null column, so the same identity could report an invented
 * window in the list and an honest one on its own detail page.
 *
 * `AgentComponent.firstSeenAt`/`lastSeenAt` are nullable in `schema.prisma`, so
 * this input is reachable, not hypothetical.
 */
describe("agentComponentsService.listForOrg — seen window parity (ISS-5577)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedTxOptions.length = 0;
    mocks.listByArtifactIds.mockResolvedValue([]);
    vi.useFakeTimers();
    vi.setSystemTime(REQUEST_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports an empty window when the inventory row carries no seen timestamps", async () => {
    installClients(
      buildServiceDb({
        agentComponent: {
          findMany: vi
            .fn()
            .mockResolvedValue([
              buildInventoryRow({ firstSeenAt: null, lastSeenAt: null }),
            ]),
        },
      })
    );

    const result = await agentComponentsService.listForOrg(ORGANIZATION_ID, {
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].firstSeenAt).toBe("");
    expect(result.items[0].lastSeenAt).toBe("");
    // The exact defect, and why it mattered beyond the value itself: the list's
    // "New" dot keys off `firstSeenAt`, and a request-clock stamp is ~0ms old, so
    // it sat inside the 7-day discovery window on every such row.
    expect(result.items[0].firstSeenAt).not.toBe(REQUEST_NOW.toISOString());
    expect(Number.isNaN(Date.parse(result.items[0].firstSeenAt))).toBe(true);
  });
});

const INVENTORY_ID = "canonical-uuid-1";
const INVENTORY_KEY = "my-mcp";

/**
 * An inventory-present identity whose observation timestamps are both null —
 * the one input that reaches the fallback under test.
 */
function installInventoryOnlyDb() {
  const db = buildServiceDb({
    agentComponent: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: INVENTORY_ID,
          computeTargetId: "target-1",
          componentKind: AgentComponentKind.Mcp,
          componentKey: INVENTORY_KEY,
          externalComponentId: `mcp::${INVENTORY_KEY}`,
          harness: "claude",
          name: "My MCP",
          sourceUrl: null,
          installPath: null,
          packId: null,
          scope: null,
          projectPath: null,
          description: null,
          metadata: null,
          content: null,
          contentHash: null,
          resolvedState: ComponentResolvedState.Unresolved,
          variantsTruncated: false,
          variantsTruncatedReason: null,
          firstSeenAt: null,
          lastSeenAt: null,
          computeTarget: buildComputeTarget("target-1", "user-1"),
          sessionUsages: [],
        },
      ]),
    },
  });

  installClients(db);
}

/** The shape `fetchDetailUsageSeenBounds` issues its aggregate with. */
type AggregateArgs = {
  where: { OR: unknown[] };
};

/** The options `withDb.tx` is opened with, captured per transaction. */
type TxOptions = { isolationLevel?: string; timeout?: number };
