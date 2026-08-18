/**
 * ISS-4944: the catalog list must actually sort by every
 * `AgentComponentSortKey` it advertises.
 *
 * The MCP `list-agent-components` tool, the docs, and the Agents table all
 * derive their `sortBy` contract from that enum, but the cloud sorter only
 * implemented name/type/harness/invocations/sessions — `metric` and `source`
 * fell through to the invocations default, so a caller asking for either got
 * invocation order back with no error. These tests pin the two previously
 * unimplemented columns (and the unknown-key fallback) against fixtures whose
 * expected order DIFFERS from invocation order, so a regression to the
 * fallthrough fails here.
 */

import {
  AgentComponentSortDir,
  AgentComponentSortKey,
} from "@repo/api/src/types/agent-component";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  Prisma: { TransactionIsolationLevel: { RepeatableRead: "RepeatableRead" } },
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
  Prisma: mocks.Prisma,
}));

// The service transitively pulls the heavy agent-sessions read service (the
// detail path's `sessionsTab`); `listForOrg` never calls it.
vi.mock("../../agent-sessions/service", () => ({
  agentSessionsService: { listByArtifactIds: vi.fn().mockResolvedValue([]) },
}));

import { agentComponentsService } from "../service";
import {
  buildPopulationDb,
  listQuery,
  makeInventoryRow,
  makeRollup,
  ORG_A,
  type PopulationFixtures,
  TARGET_1,
} from "./org-population-fixtures";

function installDb(fixtures: PopulationFixtures) {
  const built = buildPopulationDb(fixtures);
  mocks.withDb.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(built.db)
  );
  mocks.withDb.tx.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(built.db)
  );
  return built;
}

/**
 * Three subagents (the one kind with a verifiable LOC/$) whose metric, source,
 * and invocation orders are all DIFFERENT:
 *
 * | id        | source       | LOC/$        | invocations |
 * | --------- | ------------ | ------------ | ----------- |
 * | ac-alpha  | zeta-agent   | 1000         | 1           |
 * | ac-beta   | alpha-agent  | 10           | 5           |
 * | ac-gamma  | pack-mid     | null (no LOC)| 3           |
 */
function sortFixtures(): PopulationFixtures {
  return {
    inventory: [
      makeInventoryRow({
        id: "ac-alpha",
        componentKind: "subagent",
        componentKey: "zeta-agent",
        computeTargetId: TARGET_1,
      }),
      makeInventoryRow({
        id: "ac-beta",
        componentKind: "subagent",
        componentKey: "alpha-agent",
        computeTargetId: TARGET_1,
      }),
      makeInventoryRow({
        id: "ac-gamma",
        componentKind: "subagent",
        componentKey: "mid-agent",
        computeTargetId: TARGET_1,
        // FEA-4374: a pack-sourced row's displayed `source` is its pack id, so
        // this row sorts under "pack-mid", not its key.
        packId: "pack-mid",
      }),
    ],
    rollups: [
      makeRollup({
        agentComponentId: "ac-alpha",
        sessionId: "sess-high-loc",
        invocationCount: 1,
      }),
      makeRollup({
        agentComponentId: "ac-beta",
        sessionId: "sess-low-loc",
        invocationCount: 5,
      }),
      makeRollup({
        agentComponentId: "ac-gamma",
        sessionId: "sess-no-loc",
        invocationCount: 3,
      }),
    ],
    sessionLocCost: [
      // 1000 lines / $1 = 1000 LOC/$.
      {
        artifactId: "sess-high-loc",
        linesAdded: 1000,
        linesRemoved: 0,
        estimatedCost: 1,
      },
      // 10 lines / $1 = 10 LOC/$.
      {
        artifactId: "sess-low-loc",
        linesAdded: 10,
        linesRemoved: 0,
        estimatedCost: 1,
      },
      // `sess-no-loc` has no row at all — LOC/$ is null, never a fabricated 0.
    ],
  };
}

/**
 * Three commands (a kind with NO verifiable LOC/$) with equal invocations — so
 * every `metric` comparison is null-vs-null and only the row-id tiebreak orders
 * them. Ids are seeded out of order to prove the tiebreak actually ran.
 */
function unmeasuredFixtures(): PopulationFixtures {
  return {
    inventory: ["ac-c", "ac-a", "ac-b"].map((id) =>
      makeInventoryRow({
        id,
        componentKind: "command",
        componentKey: id,
        computeTargetId: TARGET_1,
      })
    ),
    rollups: ["ac-c", "ac-a", "ac-b"].map((id) =>
      makeRollup({ agentComponentId: id, invocationCount: 1 })
    ),
  };
}

function idsOf(items: { id: string }[]): string[] {
  return items.map((item) => item.id);
}

describe("agentComponentsService.listForOrg — sortBy coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sorts by metric (LOC/$) descending, with unmeasured components last", async () => {
    installDb(sortFixtures());

    const result = await agentComponentsService.listForOrg(
      ORG_A,
      listQuery({
        sortBy: AgentComponentSortKey.Metric,
        sortDir: AgentComponentSortDir.Desc,
      })
    );

    // 1000, then 10, then the null metric. Invocation order (the pre-fix
    // fallthrough) would have been [ac-beta, ac-gamma, ac-alpha].
    expect(idsOf(result.items)).toEqual(["ac-alpha", "ac-beta", "ac-gamma"]);
    expect(result.items.map((item) => item.locPerDollar)).toEqual([
      1000,
      10,
      null,
    ]);
  });

  it("sorts by metric ascending (the exact reverse)", async () => {
    installDb(sortFixtures());

    const result = await agentComponentsService.listForOrg(
      ORG_A,
      listQuery({
        sortBy: AgentComponentSortKey.Metric,
        sortDir: AgentComponentSortDir.Asc,
      })
    );

    expect(idsOf(result.items)).toEqual(["ac-gamma", "ac-beta", "ac-alpha"]);
  });

  it("sorts by the DISPLAYED source (pack-first), not the raw key or invocations", async () => {
    installDb(sortFixtures());

    const result = await agentComponentsService.listForOrg(
      ORG_A,
      listQuery({
        sortBy: AgentComponentSortKey.Source,
        sortDir: AgentComponentSortDir.Asc,
      })
    );

    // "alpha-agent" < "pack-mid" < "zeta-agent" — and `ac-gamma` sorts under its
    // pack id, the value the row displays and `?source=` filters on.
    expect(idsOf(result.items)).toEqual(["ac-beta", "ac-gamma", "ac-alpha"]);
    expect(result.items.map((item) => item.source)).toEqual([
      "alpha-agent",
      "pack-mid",
      "zeta-agent",
    ]);
  });

  it("keeps the row-id tiebreak when every row's metric is unmeasured", async () => {
    // Only `subagent` has a verifiable LOC/$, so a mixed catalog sorted by
    // `metric` is mostly null-vs-null comparisons. Those must compare EQUAL and
    // fall through to the id tiebreak — a `-Infinity` sentinel subtraction would
    // yield NaN instead, and `NaN !== 0` silently skips the tiebreak that keeps
    // offset paging from skipping or repeating a row.
    installDb(unmeasuredFixtures());

    const [page1, page2] = [
      await agentComponentsService.listForOrg(
        ORG_A,
        listQuery({
          limit: 2,
          sortBy: AgentComponentSortKey.Metric,
          sortDir: AgentComponentSortDir.Desc,
        })
      ),
      await agentComponentsService.listForOrg(
        ORG_A,
        listQuery({
          limit: 2,
          offset: 2,
          sortBy: AgentComponentSortKey.Metric,
          sortDir: AgentComponentSortDir.Desc,
        })
      ),
    ];

    // Ascending id order across the page boundary, in both directions.
    expect(idsOf(page1.items)).toEqual(["ac-a", "ac-b"]);
    expect(idsOf(page2.items)).toEqual(["ac-c"]);
  });

  it("falls back to invocation order for an unknown sort key (version-skewed caller)", async () => {
    installDb(sortFixtures());

    const result = await agentComponentsService.listForOrg(
      ORG_A,
      listQuery({
        sortBy: "not-a-column",
        sortDir: AgentComponentSortDir.Desc,
      })
    );

    expect(idsOf(result.items)).toEqual(["ac-beta", "ac-gamma", "ac-alpha"]);
  });

  it("falls back to invocation order for an inherited-key sort key, never Object.prototype", async () => {
    // The comparator table is an object literal, so a raw `comparators[sortBy]`
    // lookup would resolve "toString" through the prototype chain and call
    // `Object.prototype.toString` as the comparator — returning a string, not a
    // number, and taking out the id tiebreak with it.
    installDb(sortFixtures());

    const result = await agentComponentsService.listForOrg(
      ORG_A,
      listQuery({ sortBy: "toString", sortDir: AgentComponentSortDir.Desc })
    );

    expect(idsOf(result.items)).toEqual(["ac-beta", "ac-gamma", "ac-alpha"]);
  });
});
