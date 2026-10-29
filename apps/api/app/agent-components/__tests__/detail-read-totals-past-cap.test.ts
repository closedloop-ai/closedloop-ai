/**
 * ISS-9852 (PRD-666, cap family TC-2): a component detail whose usage
 * population exceeds `MAX_ORG_ORPHAN_USAGE_ROWS` must state the Invocations and
 * Sessions cards over the WHOLE population, not over the retained prefix.
 *
 * Every case seeds a population ONE ROW PAST the cap. The row read returns the
 * capped prefix (its `take` bound bites), while the aggregate and the session
 * `groupBy` answer for the full population. The two therefore disagree by
 * exactly one session and its invocations, and the assertions pin the
 * aggregate's answer: with the totals read reverted, each card shows the floor
 * (`* 20,000` rather than `* 20,001`).
 *
 * Three producers reach the same two cards and each is driven end to end:
 * the orphan-only detail, the inventory-present detail (whose orphan lane is
 * the same capped read), and the plugin detail (whose child-usage slices are).
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
} from "@/__tests__/support/agent-components/service-db-double";
import {
  DetailUsageAggregateFailedEvent,
  detailUsageAggregateFailureThrottle,
} from "@/app/agent-components/detail-usage-failure-telemetry";
import { MAX_ORG_ORPHAN_USAGE_ROWS } from "@/app/agent-components/plugin-child-usage";
import { DETAIL_USAGE_SNAPSHOT_TX_TIMEOUT_MS } from "@/app/agent-components/service/detail-usage-identity";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  listByArtifactIds: vi.fn(),
  logError: vi.fn(),
  Prisma: { TransactionIsolationLevel: { RepeatableRead: "RepeatableRead" } },
}));

/** The options every `withDb.tx` in a case was opened with, in call order. */
const capturedTxOptions: { isolationLevel?: string; timeout?: number }[] = [];

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
  Prisma: mocks.Prisma,
}));

vi.mock("@repo/observability/log", () => ({
  log: { error: mocks.logError, info: vi.fn(), warn: vi.fn() },
}));

vi.mock("../../agent-sessions/service", () => ({
  agentSessionsService: { listByArtifactIds: mocks.listByArtifactIds },
}));

import { agentComponentsService } from "../service";

const ORGANIZATION_ID = "org-iss-9852";
const SKILL_KEY = "hot-skill";
const PLUGIN_KEY = "hot-pack";
const CHILD_KIND = AgentComponentKind.Command;
const CHILD_KEY = "reviewer";
/**
 * A spelling of `CHILD_KEY` the SQL prefilter admits and the JS re-match
 * rejects — the ISS-6756 residual. glibc's `lower()` folds U+0130 to `i`, so
 * the trigger stores `reviewer`; `toLowerCase()` folds it to `i` + U+0307.
 */
const RESIDUAL_KEY = "REVİEWER";
const RESIDUAL_SESSION_ID = "session-residual";
const RESIDUAL_INVOCATIONS = 11;
const INVOCATIONS_PER_ROW = 3;
/** The whole population: one row past the cap, one session per row. */
const POPULATION = MAX_ORG_ORPHAN_USAGE_ROWS + 1;
const POPULATION_INVOCATIONS = POPULATION * INVOCATIONS_PER_ROW;
/** What a fold over the retained prefix would report — the floor. */
const FLOOR_SESSIONS = MAX_ORG_ORPHAN_USAGE_ROWS;
const FLOOR_INVOCATIONS = FLOOR_SESSIONS * INVOCATIONS_PER_ROW;
const AGGREGATE_FAILURE_MESSAGE = "statement timeout";
/** One FK-linked session no orphan row carries — outside the orphan population. */
const FK_SESSION_ID = "session-fk";
const FK_INVOCATIONS = 7;
const INVOKED_AT = new Date("2026-03-21T18:45:00.000Z");
/** The pinned clock for the case that crosses the failure throttle's window. */
const REQUEST_NOW = new Date("2026-09-11T12:00:00.000Z");

type UsageWhere = {
  componentKind?: string | { in: string[] };
  agentSessionId?: { in: string[] };
};
type GroupByArgs = {
  by: string[];
  where: UsageWhere;
  _sum?: { invocationCount: true };
};
type AggregateArgs = {
  where: UsageWhere;
  _sum?: { invocationCount: true };
  _min?: { firstInvokedAt: true };
};

function usageRow(index: number, kind: string, key: string) {
  return {
    id: `usage-${index}`,
    agentSessionId: `session-${index}`,
    agentComponentId: null,
    invocationCount: INVOCATIONS_PER_ROW,
    errorCount: 0,
    gitBranch: "",
    harness: "claude",
    componentKind: kind,
    componentKey: key,
    componentVersionHash: null,
    definitionVersionId: null,
    firstInvokedAt: INVOKED_AT,
    lastInvokedAt: INVOKED_AT,
    session: {
      artifactId: `session-${index}`,
      artifact: { organizationId: ORGANIZATION_ID },
    },
  };
}

/** The per-session distinct read every totals statement issues. */
function isSessionGroupBy(args: GroupByArgs): boolean {
  return args.by.length === 1 && args.by[0] === "agentSessionId";
}

/** The per-spelling invocation sum the plugin totals issue instead of `_sum`. */
function isIdentitySumGroupBy(args: GroupByArgs): boolean {
  return (
    args.by.length === 2 &&
    args.by[0] === "componentKind" &&
    args.by[1] === "componentKey"
  );
}

/** The per-session-per-spelling read, issued only when a spelling was rejected. */
function isSessionIdentityGroupBy(args: GroupByArgs): boolean {
  return (
    args.by.length === 3 &&
    args.by[0] === "agentSessionId" &&
    args.by[1] === "componentKind" &&
    args.by[2] === "componentKey"
  );
}

/**
 * The usage delegate for a population one row past the cap. `findMany` serves
 * the capped prefix the `take` bound leaves (only for the lane read — the
 * per-session version attribution read, keyed by session ids, gets nothing);
 * `aggregate` and `groupBy` answer for the whole population. With `residual`,
 * the population the SQL admits also holds one `RESIDUAL_KEY` session.
 */
function buildUsageDelegate(
  kind: string,
  key: string,
  options: {
    totalsReject?: boolean;
    rows?: number;
    fkSessions?: boolean;
    residual?: boolean;
  } = {}
) {
  const prefix = Array.from(
    { length: options.rows ?? MAX_ORG_ORPHAN_USAGE_ROWS },
    (_u, i) => usageRow(i, kind, key)
  );
  const populationSessions = Array.from(
    { length: POPULATION },
    (_u, i) => `session-${i}`
  );
  const findMany = vi.fn(async (args: { where: UsageWhere }) => {
    await Promise.resolve();
    return args.where.agentSessionId ? [] : prefix;
  });
  const aggregate = vi.fn(async (args: AggregateArgs) => {
    await Promise.resolve();
    if (options.totalsReject) {
      throw new Error(AGGREGATE_FAILURE_MESSAGE);
    }
    if (args._sum) {
      return {
        _sum: {
          invocationCount:
            POPULATION_INVOCATIONS +
            (options.residual ? RESIDUAL_INVOCATIONS : 0),
        },
      };
    }
    return {
      _min: { firstInvokedAt: INVOKED_AT },
      _max: { lastInvokedAt: INVOKED_AT },
    };
  });
  const groupBy = vi.fn(async (args: GroupByArgs) => {
    await Promise.resolve();
    const totalsShaped =
      isSessionGroupBy(args) ||
      isIdentitySumGroupBy(args) ||
      isSessionIdentityGroupBy(args);
    if (options.totalsReject && totalsShaped) {
      throw new Error(AGGREGATE_FAILURE_MESSAGE);
    }
    if (isSessionGroupBy(args)) {
      const sessions = options.residual
        ? [...populationSessions, RESIDUAL_SESSION_ID]
        : populationSessions;
      return sessions.map((agentSessionId) => ({ agentSessionId }));
    }
    if (isIdentitySumGroupBy(args)) {
      const groups = [
        {
          componentKind: kind,
          componentKey: key,
          _sum: { invocationCount: POPULATION_INVOCATIONS },
        },
      ];
      if (options.residual) {
        groups.push({
          componentKind: kind,
          componentKey: RESIDUAL_KEY,
          _sum: { invocationCount: RESIDUAL_INVOCATIONS },
        });
      }
      return groups;
    }
    if (isSessionIdentityGroupBy(args)) {
      const groups = populationSessions.map((agentSessionId) => ({
        agentSessionId,
        componentKind: kind,
        componentKey: key,
      }));
      if (options.residual) {
        groups.push({
          agentSessionId: RESIDUAL_SESSION_ID,
          componentKind: kind,
          componentKey: RESIDUAL_KEY,
        });
      }
      return groups;
    }
    // The FK lanes' grouped reads. One FK-linked session outside the orphan
    // population (only when the case asked for it), so the Sessions card must
    // UNION the two populations rather than count either alone.
    return options.fkSessions
      ? [
          {
            agentComponentId: "inv-skill",
            componentKind: kind,
            componentKey: key,
            agentSessionId: FK_SESSION_ID,
            gitBranch: "",
            harness: "claude",
            _sum: { invocationCount: FK_INVOCATIONS, errorCount: 0 },
            _max: { lastInvokedAt: INVOKED_AT },
          },
        ]
      : [];
  });
  return { findMany, aggregate, groupBy };
}

/** The plugin child-usage slice reads: keyed by child kinds, not session ids. */
function childUsageReads(
  findMany: ReturnType<typeof buildUsageDelegate>["findMany"]
) {
  return findMany.mock.calls.filter(
    ([args]) =>
      typeof args.where.componentKind === "object" &&
      args.where.componentKind !== null &&
      "in" in args.where.componentKind
  );
}

/**
 * The invocation-sum reads a usage delegate served — `_sum` aggregates, then
 * the per-spelling sum `groupBy`s the plugin totals issue — as their `where`s,
 * plus the session `groupBy`s.
 */
function totalsReads(usage: ReturnType<typeof buildUsageDelegate>) {
  return {
    sumWheres: [
      ...usage.aggregate.mock.calls
        .filter(([args]) => args._sum)
        .map(([args]) => args.where),
      ...usage.groupBy.mock.calls
        .filter(([args]) => isIdentitySumGroupBy(args))
        .map(([args]) => args.where),
    ],
    sessionGroups: usage.groupBy.mock.calls.filter(([args]) =>
      isSessionGroupBy(args)
    ),
  };
}

/** The child-inventory join asks by `packId`; the detail asks by identity. */
function pluginInventoryFindMany() {
  return vi.fn(async (args: { where: { packId?: unknown } }) => {
    await Promise.resolve();
    if (args.where.packId) {
      return [
        {
          id: "inv-child",
          componentKind: CHILD_KIND,
          componentKey: CHILD_KEY,
          packId: PLUGIN_KEY,
        },
      ];
    }
    return [inventoryRow(AgentComponentKind.Plugin, PLUGIN_KEY, "inv-plugin")];
  });
}

function installClients(db: unknown, snapshot: unknown = db) {
  mocks.withDb.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(db)
  );
  mocks.withDb.tx.mockImplementation(
    (
      callback: (client: unknown) => unknown,
      options?: { isolationLevel?: string; timeout?: number }
    ) => {
      capturedTxOptions.push(options ?? {});
      return callback(snapshot);
    }
  );
}

function inventoryRow(kind: string, key: string, id: string) {
  return buildInventoryRow({
    id,
    componentKind: kind,
    componentKey: key,
    externalComponentId: `${kind}::${key}`,
    name: key,
    resolvedState: ComponentResolvedState.Unresolved,
    variantsTruncated: false,
    variantsTruncatedReason: null,
    computeTarget: buildComputeTarget("target-1", "user-1"),
  });
}

describe("component detail totals past the usage-row cap (ISS-9852)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedTxOptions.length = 0;
    mocks.listByArtifactIds.mockResolvedValue([]);
    detailUsageAggregateFailureThrottle.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("orphan-only: states the whole population, not the retained prefix", async () => {
    const usage = buildUsageDelegate(AgentComponentKind.Skill, SKILL_KEY);
    installClients(buildServiceDb({ agentComponentSessionUsage: usage }));

    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      encodeComponentSlug(AgentComponentKind.Skill, SKILL_KEY, null)
    );

    expect(detail?.invocations).toBe(POPULATION_INVOCATIONS);
    expect(detail?.sessions).toBe(POPULATION);
    expect(detail?.invocations).not.toBe(FLOOR_INVOCATIONS);
    expect(detail?.sessions).not.toBe(FLOOR_SESSIONS);
    // The totals read is the `_sum` over the lane predicates, issued once.
    const sums = usage.aggregate.mock.calls.filter(([args]) => args._sum);
    expect(sums).toHaveLength(1);
    expect(sums[0][0].where).toHaveProperty("OR");
  });

  it("orphan-only: keeps the folded floor, not a 500, when the totals read rejects", async () => {
    const usage = buildUsageDelegate(AgentComponentKind.Skill, SKILL_KEY, {
      totalsReject: true,
    });
    installClients(buildServiceDb({ agentComponentSessionUsage: usage }));

    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      encodeComponentSlug(AgentComponentKind.Skill, SKILL_KEY, null)
    );

    expect(detail).not.toBeNull();
    expect(detail?.invocations).toBe(FLOOR_INVOCATIONS);
    expect(detail?.sessions).toBe(FLOOR_SESSIONS);
    expect(mocks.logError).toHaveBeenCalledWith(
      DetailUsageAggregateFailedEvent.Totals,
      expect.objectContaining({
        error: AGGREGATE_FAILURE_MESSAGE,
        kind: AgentComponentKind.Skill,
        organizationId: ORGANIZATION_ID,
      })
    );
  });

  /**
   * whitlockk (#7051 review): on a pathological org every refresh times the totals
   * read out, and any org member can refresh. The production path bounds the
   * event per org, so a second failing request in the same window emits no
   * second event.
   */
  it("orphan-only: emits one totals failure event per org and window, not one per request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(REQUEST_NOW);
    const usage = buildUsageDelegate(AgentComponentKind.Skill, SKILL_KEY, {
      totalsReject: true,
    });
    installClients(buildServiceDb({ agentComponentSessionUsage: usage }));
    const slug = encodeComponentSlug(AgentComponentKind.Skill, SKILL_KEY, null);

    await agentComponentsService.getDetailForOrg(ORGANIZATION_ID, slug);
    const repeat = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      slug
    );

    expect(repeat?.invocations).toBe(FLOOR_INVOCATIONS);
    expect(
      mocks.logError.mock.calls.filter(
        ([event]) => event === DetailUsageAggregateFailedEvent.Totals
      )
    ).toHaveLength(1);
  });

  it("inventory-present: folds the orphan lane's whole population into the FK totals", async () => {
    const usage = buildUsageDelegate(AgentComponentKind.Skill, SKILL_KEY, {
      fkSessions: true,
    });
    installClients(
      buildServiceDb({
        agentComponent: {
          findMany: vi
            .fn()
            .mockResolvedValue([
              inventoryRow(AgentComponentKind.Skill, SKILL_KEY, "inv-skill"),
            ]),
        },
        agentComponentSessionUsage: usage,
      })
    );

    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      encodeComponentSlug(AgentComponentKind.Skill, SKILL_KEY, null)
    );

    expect(detail?.id).toBe("inv-skill");
    // Invocations ADD across the FK lane and the orphan population; sessions
    // UNION them, so the FK-only session counts once on top of the population.
    expect(detail?.invocations).toBe(POPULATION_INVOCATIONS + FK_INVOCATIONS);
    expect(detail?.sessions).toBe(POPULATION + 1);
  });

  it("plugin: states its children's whole population, not the retained prefix", async () => {
    const usage = buildUsageDelegate(CHILD_KIND, CHILD_KEY);
    installClients(
      buildServiceDb({
        agentComponent: { findMany: pluginInventoryFindMany() },
        agentComponentSessionUsage: usage,
      })
    );

    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      encodeComponentSlug(AgentComponentKind.Plugin, PLUGIN_KEY, null)
    );

    expect(detail?.id).toBe("inv-plugin");
    expect(detail?.invocations).toBe(POPULATION_INVOCATIONS);
    expect(detail?.sessions).toBe(POPULATION);
    // The totals read iterates the same child-usage slices the row read did.
    const childReads = usage.findMany.mock.calls.filter(
      ([args]) => !args.where.agentSessionId
    );
    expect(totalsReads(usage).sumWheres).toEqual(
      childReads.map(([args]) => args.where)
    );
    // Every spelling was kept, so sessions took the plain per-session read.
    expect(
      usage.groupBy.mock.calls.filter(([args]) =>
        isSessionIdentityGroupBy(args)
      )
    ).toHaveLength(0);
  });

  /**
   * chatgpt-codex-connector on #7051: the SQL prefilter admits on the
   * trigger's `lower(btrim())` fold, `belongsToPlugin` keeps on
   * `normalizeComponentKey`, and the two differ on the ISS-6756 residual. The
   * sample drops a spelling the re-match rejects, so the cards must drop it
   * too, or they state usage the sample and the list omit.
   */
  it("plugin: drops a spelling the identity re-match rejects from the totals", async () => {
    const usage = buildUsageDelegate(CHILD_KIND, CHILD_KEY, { residual: true });
    installClients(
      buildServiceDb({
        agentComponent: { findMany: pluginInventoryFindMany() },
        agentComponentSessionUsage: usage,
      })
    );

    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      encodeComponentSlug(AgentComponentKind.Plugin, PLUGIN_KEY, null)
    );

    expect(detail?.invocations).toBe(POPULATION_INVOCATIONS);
    expect(detail?.sessions).toBe(POPULATION);
    expect(
      usage.groupBy.mock.calls.filter(([args]) =>
        isSessionIdentityGroupBy(args)
      )
    ).toHaveLength(1);
  });

  /**
   * The performance argument behind every re-dispositioned allowlist entry:
   * the aggregate is FREE unless a lane's `take` bound bit. A below-cap
   * population must issue no `_sum` and no session `groupBy` at all.
   */
  it("issues no totals read when no lane hit its cap", async () => {
    const usage = buildUsageDelegate(AgentComponentKind.Skill, SKILL_KEY, {
      rows: 3,
    });
    installClients(buildServiceDb({ agentComponentSessionUsage: usage }));

    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      encodeComponentSlug(AgentComponentKind.Skill, SKILL_KEY, null)
    );

    expect(detail?.invocations).toBe(3 * INVOCATIONS_PER_ROW);
    expect(detail?.sessions).toBe(3);
    const { sumWheres, sessionGroups } = totalsReads(usage);
    expect(sumWheres).toHaveLength(0);
    expect(sessionGroups).toHaveLength(0);
  });

  /**
   * ISS-9853: the cohort read walks every id it is handed, so it cannot see
   * that the ids themselves were bounded. The lane's OWN `take` is what the
   * response's `mergedPrsTruncated` is now derived from — NOT the totals
   * aggregate, which resolves `null` both when nothing was bounded and when the
   * bounded lane's totals read rejected. The rejection cases below are the pair
   * that distinguishes those two derivations.
   */
  it("declares a sampled cohort when the orphan lane hit its cap", async () => {
    const usage = buildUsageDelegate(AgentComponentKind.Skill, SKILL_KEY);
    installClients(buildServiceDb({ agentComponentSessionUsage: usage }));

    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      encodeComponentSlug(AgentComponentKind.Skill, SKILL_KEY, null)
    );

    expect(detail?.mergedPrsTruncated).toBe(true);
  });

  it("still declares a sampled cohort when the totals read rejects", async () => {
    const usage = buildUsageDelegate(AgentComponentKind.Skill, SKILL_KEY, {
      totalsReject: true,
    });
    installClients(buildServiceDb({ agentComponentSessionUsage: usage }));

    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      encodeComponentSlug(AgentComponentKind.Skill, SKILL_KEY, null)
    );

    // The cards fall back to the folded floor here (pinned above). What must
    // NOT fall back is the disclosure: deriving it from the null `totals` would
    // claim whole-cohort coverage exactly when the lane was bounded AND its
    // population read failed.
    expect(detail?.invocations).toBe(FLOOR_INVOCATIONS);
    expect(detail?.mergedPrsTruncated).toBe(true);
  });

  it("declares a sampled cohort on the inventory-present arm too", async () => {
    // A THIRD producer: `detail-read.ts` (the FK-lane arm), distinct from the
    // orphan-only arm above and the plugin arm below. Its FK lanes are uncapped
    // `groupBy` reads, so the orphan lane's `take` is the only thing that can
    // sample its session set.
    installClients(
      buildServiceDb({
        agentComponent: {
          findMany: vi
            .fn()
            .mockResolvedValue([
              inventoryRow(AgentComponentKind.Skill, SKILL_KEY, "inv-skill"),
            ]),
        },
        agentComponentSessionUsage: buildUsageDelegate(
          AgentComponentKind.Skill,
          SKILL_KEY,
          { fkSessions: true }
        ),
      })
    );

    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      encodeComponentSlug(AgentComponentKind.Skill, SKILL_KEY, null)
    );

    expect(detail?.id).toBe("inv-skill");
    expect(detail?.mergedPrsTruncated).toBe(true);
  });

  it("declares a sampled cohort when the plugin's child lane hit its cap", async () => {
    installClients(
      buildServiceDb({
        agentComponent: { findMany: pluginInventoryFindMany() },
        agentComponentSessionUsage: buildUsageDelegate(CHILD_KIND, CHILD_KEY),
      })
    );

    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      encodeComponentSlug(AgentComponentKind.Plugin, PLUGIN_KEY, null)
    );

    expect(detail?.mergedPrsTruncated).toBe(true);
  });

  it("still declares a sampled cohort when the plugin totals read rejects", async () => {
    installClients(
      buildServiceDb({
        agentComponent: { findMany: pluginInventoryFindMany() },
        agentComponentSessionUsage: buildUsageDelegate(CHILD_KIND, CHILD_KEY, {
          totalsReject: true,
        }),
      })
    );

    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      encodeComponentSlug(AgentComponentKind.Plugin, PLUGIN_KEY, null)
    );

    expect(detail?.invocations).toBe(FLOOR_INVOCATIONS);
    expect(detail?.mergedPrsTruncated).toBe(true);
  });

  it("declares no sample when no lane hit its cap", async () => {
    const usage = buildUsageDelegate(AgentComponentKind.Skill, SKILL_KEY, {
      rows: 3,
    });
    installClients(buildServiceDb({ agentComponentSessionUsage: usage }));

    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      encodeComponentSlug(AgentComponentKind.Skill, SKILL_KEY, null)
    );

    // The control: without it, a producer hardcoding `true` would satisfy every
    // case above and look correct.
    expect(detail?.mergedPrsTruncated).toBe(false);
  });

  /**
   * Plan challenge (Opus): the population's session set must never become the
   * fan-out input of the LOC/cost read, whose chunk count follows its size —
   * only the two cards read the population; every session-keyed derivation
   * stays on the bounded sample.
   */
  it("keeps the LOC/cost fan-out on the sample when the cards read the population", async () => {
    const usage = buildUsageDelegate(AgentComponentKind.Skill, SKILL_KEY);
    const sessionDetailFindMany = vi.fn(
      async (_args: { where: { artifactId?: { in?: string[] } } }) => {
        await Promise.resolve();
        return [];
      }
    );
    installClients(
      buildServiceDb({
        agentComponent: {
          findMany: vi
            .fn()
            .mockResolvedValue([
              inventoryRow(AgentComponentKind.Skill, SKILL_KEY, "inv-skill"),
            ]),
        },
        agentComponentSessionUsage: usage,
        sessionDetail: { findMany: sessionDetailFindMany },
      })
    );

    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      encodeComponentSlug(AgentComponentKind.Skill, SKILL_KEY, null)
    );

    expect(detail?.sessions).toBe(POPULATION);
    const asked = new Set(
      sessionDetailFindMany.mock.calls.flatMap(
        ([args]) => args.where.artifactId?.in ?? []
      )
    );
    expect(asked.size).toBeLessThanOrEqual(MAX_ORG_ORPHAN_USAGE_ROWS);
    expect(asked.has(`session-${MAX_ORG_ORPHAN_USAGE_ROWS}`)).toBe(false);
  });

  it("plugin: keeps the folded floor and logs when the totals read rejects", async () => {
    const usage = buildUsageDelegate(CHILD_KIND, CHILD_KEY, {
      totalsReject: true,
    });
    installClients(
      buildServiceDb({
        agentComponent: { findMany: pluginInventoryFindMany() },
        agentComponentSessionUsage: usage,
      })
    );

    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      encodeComponentSlug(AgentComponentKind.Plugin, PLUGIN_KEY, null)
    );

    expect(detail?.invocations).toBe(FLOOR_INVOCATIONS);
    expect(detail?.sessions).toBe(FLOOR_SESSIONS);
    expect(mocks.logError).toHaveBeenCalledWith(
      DetailUsageAggregateFailedEvent.Totals,
      expect.objectContaining({
        kind: AgentComponentKind.Plugin,
        organizationId: ORGANIZATION_ID,
      })
    );
  });
  /**
   * Plan challenge (Opus, round 2): the plugin lane's child-inventory bound,
   * row sample and totals must share ONE snapshot. The pooled client here is a
   * world with no child usage at all; only the snapshot client holds the
   * population. A plugin read issued on the pool — the pre-fix shape — reports
   * zero, so this cannot pass unless every statement went to the transaction.
   */
  it("plugin: reads the child sample and the totals under one snapshot", async () => {
    const pooled = buildUsageDelegate(CHILD_KIND, CHILD_KEY, { rows: 0 });
    const snapshot = buildUsageDelegate(CHILD_KIND, CHILD_KEY);
    installClients(
      buildServiceDb({
        agentComponent: { findMany: pluginInventoryFindMany() },
        agentComponentSessionUsage: pooled,
      }),
      buildServiceDb({
        agentComponent: { findMany: pluginInventoryFindMany() },
        agentComponentSessionUsage: snapshot,
      })
    );

    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      encodeComponentSlug(AgentComponentKind.Plugin, PLUGIN_KEY, null)
    );

    expect(detail?.invocations).toBe(POPULATION_INVOCATIONS);
    expect(detail?.sessions).toBe(POPULATION);
    // The child-usage slice reads and their sums went to the snapshot only.
    // (The snapshot also serves the inventory-present orphan lane and its own
    // totals read, so the count there is "at least the plugin slice".)
    expect(childUsageReads(pooled.findMany)).toHaveLength(0);
    expect(totalsReads(pooled).sumWheres).toHaveLength(0);
    expect(childUsageReads(snapshot.findMany)).toHaveLength(1);
    expect(totalsReads(snapshot).sumWheres).toContainEqual(
      childUsageReads(snapshot.findMany)[0][0].where
    );
    // Every snapshot this read opened is the same isolation + timeout the
    // inventory-present and orphan-only paths already use.
    expect(capturedTxOptions.length).toBeGreaterThanOrEqual(2);
    for (const options of capturedTxOptions) {
      expect(options).toEqual({
        isolationLevel: mocks.Prisma.TransactionIsolationLevel.RepeatableRead,
        timeout: DETAIL_USAGE_SNAPSHOT_TX_TIMEOUT_MS,
      });
    }
  });
});
