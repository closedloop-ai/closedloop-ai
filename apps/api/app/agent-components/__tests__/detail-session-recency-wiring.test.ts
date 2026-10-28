/**
 * ISS-9855 (production wiring): the recency map the sessions tab pages by is
 * built from the usage lanes' `lastInvokedAt` and actually REACHES
 * `resolveDetailSessionTabs` from every producer. `detail-sessions-tab-wiring`
 * hands that function a hand-built map, so deleting the sixth argument at the
 * `detail-read.ts` or `detail-read-orphan.ts` call site leaves that suite green
 * while the page silently degrades to artifactId ASC. These cases drive
 * `getDetailForOrg` through the inventory, orphan-only, and plugin arms and
 * assert the map that arrives.
 *
 * The helper cases pin the cross-lane fold itself: a session with rows in more
 * than one lane keeps the MAX `lastInvokedAt`, and a null row never overwrites
 * a Date already recorded.
 */
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { encodeComponentSlug } from "@repo/api/src/types/agent-component-analytics";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildInventoryRow,
  buildServiceDb,
} from "@/__tests__/support/agent-components/service-db-double";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  Prisma: { TransactionIsolationLevel: { RepeatableRead: "RepeatableRead" } },
  listByArtifactIds: vi.fn(),
  resolveDetailSessionTabs: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
  Prisma: mocks.Prisma,
}));

vi.mock("../../agent-sessions/service", () => ({
  agentSessionsService: { listByArtifactIds: mocks.listByArtifactIds },
}));

// Only the tab resolver is replaced. The recency helpers stay real: the
// invocation-count fold imports them from this module and is under test here.
vi.mock("../service/detail-session-tabs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../service/detail-session-tabs")>()),
  resolveDetailSessionTabs: mocks.resolveDetailSessionTabs,
}));

import { agentComponentsService } from "../service";
import { recordSessionLastInvoked } from "../service/detail-session-tabs";

const ORGANIZATION_ID = "org-1";
const SKILL_KEY = "my-skill";
const PLUGIN_KEY = "my-pack";
const CHILD_KIND = AgentComponentKind.Command;
const CHILD_KEY = "reviewer";
/** `sessionLastInvoked` is the sixth argument of `resolveDetailSessionTabs`. */
const SESSION_LAST_INVOKED_ARG = 5;

const SESSION_CURSOR = {
  t: "2026-03-01T00:00:00.000Z",
  id: "00000000-0000-4000-8000-000000000001",
};

const T1 = new Date("2026-03-01T00:00:00.000Z");
const T2 = new Date("2026-03-02T00:00:00.000Z");
const T3 = new Date("2026-03-03T00:00:00.000Z");

const EMPTY_TABS = {
  usageSessions: [],
  branchesTab: [],
  sessionsTab: [],
  sessionsTabTruncated: false,
  branchesTabTruncated: false,
  nextCursor: null,
};

/** A detail-lane usage row, as `agentComponentSessionUsage.findMany` returns it. */
function usageRow(
  sessionId: string,
  kind: string,
  key: string,
  lastInvokedAt: Date | null
) {
  return {
    id: `usage-${sessionId}`,
    agentSessionId: sessionId,
    agentComponentId: null,
    invocationCount: 2,
    errorCount: 0,
    gitBranch: "",
    harness: "claude",
    componentKind: kind,
    componentKey: key,
    componentVersionHash: null,
    definitionVersionId: null,
    firstInvokedAt: lastInvokedAt,
    lastInvokedAt,
    session: {
      artifactId: sessionId,
      artifact: { organizationId: ORGANIZATION_ID },
    },
  };
}

/**
 * Serves `rows` to the lane read and nothing to the per-session version
 * attribution read, which is the only usage `findMany` keyed by session ids.
 */
function laneFindMany(rows: readonly ReturnType<typeof usageRow>[]) {
  return vi.fn((args: { where: { agentSessionId?: unknown } }) =>
    Promise.resolve(args.where.agentSessionId ? [] : rows)
  );
}

/** Totals reads return nothing; no lane here reaches its `take` bound. */
const EMPTY_AGGREGATE = {
  _sum: { invocationCount: 0 },
  _min: { firstInvokedAt: null },
  _max: { lastInvokedAt: null },
};

function installClient(db: unknown) {
  mocks.withDb.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(db)
  );
  mocks.withDb.tx.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(db)
  );
}

/**
 * The recency map the production read handed to `resolveDetailSessionTabs`.
 * Returned rather than asserted so every expectation lives in its `it`.
 */
async function recencyMapFor(slug: string): Promise<unknown> {
  await agentComponentsService.getDetailForOrg(
    ORGANIZATION_ID,
    slug,
    undefined,
    { sessionCursor: SESSION_CURSOR }
  );
  return mocks.resolveDetailSessionTabs.mock.calls[0]?.[
    SESSION_LAST_INVOKED_ARG
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listByArtifactIds.mockResolvedValue([]);
  mocks.resolveDetailSessionTabs.mockResolvedValue(EMPTY_TABS);
});

describe("ISS-9855 recency map reaches the sessions tab from every producer", () => {
  it("inventory detail: FK groups' _max and the orphan lane fold into one max per session", async () => {
    // session-a: FK lane only. session-b: FK lane at T2 AND an orphan row at
    // T3, so the value that arrives must be the cross-lane max.
    installClient(
      buildServiceDb({
        agentComponent: {
          findMany: vi.fn().mockResolvedValue([
            buildInventoryRow({
              organizationId: ORGANIZATION_ID,
              sessionUsages: [
                {
                  agentSessionId: "session-a",
                  invocationCount: 1,
                  lastInvokedAt: T1,
                  session: { artifact: { organizationId: ORGANIZATION_ID } },
                },
                {
                  agentSessionId: "session-b",
                  invocationCount: 1,
                  lastInvokedAt: T2,
                  session: { artifact: { organizationId: ORGANIZATION_ID } },
                },
              ],
            }),
          ]),
        },
        agentComponentSessionUsage: {
          findMany: laneFindMany([
            usageRow("session-b", AgentComponentKind.Skill, SKILL_KEY, T3),
          ]),
          aggregate: vi.fn().mockResolvedValue(EMPTY_AGGREGATE),
        },
      })
    );

    const recency = await recencyMapFor(
      encodeComponentSlug(AgentComponentKind.Skill, SKILL_KEY, null)
    );

    expect(mocks.resolveDetailSessionTabs.mock.calls[0]?.[6]).toEqual(
      SESSION_CURSOR
    );
    expect(recency).toEqual(
      new Map([
        ["session-a", T1],
        ["session-b", T3],
      ])
    );
  });

  it("orphan-only detail: the orphan rows' lastInvokedAt arrives, null kept as unknown", async () => {
    installClient(
      buildServiceDb({
        agentComponentSessionUsage: {
          findMany: laneFindMany([
            usageRow("session-c", AgentComponentKind.Skill, SKILL_KEY, T2),
            usageRow("session-d", AgentComponentKind.Skill, SKILL_KEY, null),
          ]),
          groupBy: vi.fn().mockResolvedValue([]),
          aggregate: vi.fn().mockResolvedValue(EMPTY_AGGREGATE),
        },
      })
    );

    const recency = await recencyMapFor(
      encodeComponentSlug(AgentComponentKind.Skill, SKILL_KEY, null)
    );

    expect(mocks.resolveDetailSessionTabs.mock.calls[0]?.[6]).toEqual(
      SESSION_CURSOR
    );
    expect(recency).toEqual(
      new Map([
        ["session-c", T2],
        ["session-d", null],
      ])
    );
  });

  it("plugin detail: the child-usage fold's lastInvokedAt arrives", async () => {
    const pluginRow = buildInventoryRow({
      id: "inv-plugin",
      organizationId: ORGANIZATION_ID,
      componentKind: AgentComponentKind.Plugin,
      componentKey: PLUGIN_KEY,
      externalComponentId: `plugin::${PLUGIN_KEY}`,
      packId: PLUGIN_KEY,
    });
    const childRow = {
      id: "inv-child",
      componentKind: CHILD_KIND,
      componentKey: CHILD_KEY,
      packId: PLUGIN_KEY,
    };
    installClient(
      buildServiceDb({
        agentComponent: {
          // The child-inventory join asks by `packId`; the detail asks by identity.
          findMany: vi.fn((args: { where: { packId?: unknown } }) =>
            Promise.resolve(args.where.packId ? [childRow] : [pluginRow])
          ),
        },
        agentComponentSessionUsage: {
          findMany: laneFindMany([
            usageRow("session-e", CHILD_KIND, CHILD_KEY, T1),
            usageRow("session-f", CHILD_KIND, CHILD_KEY, T3),
          ]),
          groupBy: vi.fn().mockResolvedValue([]),
          aggregate: vi.fn().mockResolvedValue(EMPTY_AGGREGATE),
        },
      })
    );

    const recency = await recencyMapFor(
      encodeComponentSlug(AgentComponentKind.Plugin, PLUGIN_KEY, null)
    );

    expect(mocks.resolveDetailSessionTabs.mock.calls[0]?.[6]).toEqual(
      SESSION_CURSOR
    );
    expect(recency).toEqual(
      new Map([
        ["session-e", T1],
        ["session-f", T3],
      ])
    );
  });
});

describe("ISS-9855 recordSessionLastInvoked keeps the cross-lane max", () => {
  it("a later row from another lane replaces an earlier recorded Date", () => {
    const map = new Map<string, Date | null>();
    recordSessionLastInvoked(map, "s", T1);
    recordSessionLastInvoked(map, "s", T3);
    expect(map.get("s")).toBe(T3);
  });

  it("an earlier row from another lane does not replace a later recorded Date", () => {
    const map = new Map<string, Date | null>();
    recordSessionLastInvoked(map, "s", T3);
    recordSessionLastInvoked(map, "s", T1);
    expect(map.get("s")).toBe(T3);
  });

  it("a null row never overwrites a Date already recorded", () => {
    const map = new Map<string, Date | null>();
    recordSessionLastInvoked(map, "s", T2);
    recordSessionLastInvoked(map, "s", null);
    expect(map.get("s")).toBe(T2);
  });

  it("a Date replaces a first-seen null", () => {
    const map = new Map<string, Date | null>();
    recordSessionLastInvoked(map, "s", null);
    recordSessionLastInvoked(map, "s", T1);
    expect(map.get("s")).toBe(T1);
  });

  it("a session seen only through null rows records null, not a missing key", () => {
    const map = new Map<string, Date | null>();
    recordSessionLastInvoked(map, "s", null);
    recordSessionLastInvoked(map, "s", null);
    expect(map.has("s")).toBe(true);
    expect(map.get("s")).toBeNull();
  });
});
