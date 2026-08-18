/**
 * ISS-4797 + ISS-4799 regression suite: an org population read must not depend
 * on which FACET asked for it.
 *
 * Both defects had one cause — a hard row `take` applied AFTER the request's
 * `?kinds=` predicate — and that ordering makes a STRICTER filter return MORE
 * data. The unfiltered read spends its row budget across every kind and drops
 * its older tail; a kind-filtered read starts from a far smaller set and never
 * truncates at all. Reported symptoms:
 *
 *   - ISS-4797: per-kind tab totals summed to 2,174 against an All total of
 *     2,138. The whole overage was `subagent` — All contained 210 subagent rows
 *     while `?kinds=subagent` returned 246, so narrowing the filter GREW the
 *     count. The 51 filtered-only subagents all predated All's truncation floor.
 *   - ISS-4799: `tool::_create_pull_request` reported 1/1 invocations/sessions on
 *     the All row, 15/14 on the Tools row, and 61/55 on its detail page — three
 *     populations for one component.
 *
 * The fixtures below reproduce that shape rather than assert it abstractly: an
 * org whose distinct component count sits far BELOW the cap while its raw ROW
 * count sits above it, which is exactly the real shape (rows = identities ×
 * compute targets × observed versions, and usage rows = identities × sessions).
 * Under the pre-fix reads these tests fail; under the identity-capped reads the
 * three invariants below hold.
 *
 * Every test drives the real `listForOrg` / `getDetailForOrg` production paths.
 * BOTH the count path and the row path are covered: a `total` that reconciles
 * over rows that are still truncated would be a different lie, not a fix.
 */

import { AGENT_COMPONENT_INVENTORY_CAP } from "@repo/api/src/types/agent-component";
import { encodeComponentSlug } from "@repo/api/src/types/agent-component-analytics";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  listByArtifactIds: vi.fn(),
  Prisma: { TransactionIsolationLevel: { RepeatableRead: "RepeatableRead" } },
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
  Prisma: mocks.Prisma,
}));

vi.mock("../../agent-sessions/service", () => ({
  agentSessionsService: { listByArtifactIds: mocks.listByArtifactIds },
}));

import { agentComponentsService } from "../service";
import {
  buildPopulationDb,
  type InventoryFixture,
  makeInventoryRow,
  ORG_A,
} from "./org-population-fixtures";
import { buildServiceDb } from "./service-db-double";
import {
  matchesOrphanWhere,
  type OrphanUsageShape,
  sortByRecency,
  takeRows,
} from "./usage-lane-doubles";

const ORG = "org-facet-invariants";

/** Every kind the ISS-4797 fixture org installs — the catalog's per-tab facets. */
const FIXTURE_KINDS = ["command", "subagent"] as const;

/**
 * Compute targets each `command` identity is installed on. A single component
 * installed across a fleet is one identity but many ROWS, which is precisely how
 * a real org's row count outruns its component count.
 */
const INSTALLS_PER_COMMAND = 51;

/**
 * Enough `command` identities that their rows alone exceed the raw-row cap the
 * pre-fix read applied. Derived from the cap so this fixture keeps biting if the
 * cap is ever retuned, instead of silently going vacuous.
 */
const COMMAND_IDENTITIES = Math.ceil(
  (AGENT_COMPONENT_INVENTORY_CAP + 1) / INSTALLS_PER_COMMAND
);

/**
 * The subagents ISS-4797 found only in the filtered view. One row each, and ALL
 * of them older than the commands, so a recency-ordered raw-row cap drops the
 * whole kind — the "51 filtered-only subagents below All's floor" the ticket
 * reported.
 */
const SUBAGENT_IDENTITIES = 51;

/** Recent enough to win a `lastSeenAt desc` row cap outright. */
const RECENT_SEEN_AT = new Date("2026-07-12T00:00:00.000Z");
/** The ticket's stale subagent cohort, below the All view's truncation floor. */
const STALE_SEEN_AT = new Date("2026-05-13T00:00:00.000Z");

/** `${kind}::${key}` of the ISS-4799 component with three reported populations. */
const TOOL_KIND = "tool";
const TOOL_KEY = "_create_pull_request";
/** Sessions the tool ran in, and the invocations summed across them. */
const TOOL_SESSIONS = 55;
const TOOL_INVOCATIONS = 61;

/**
 * Orphan usage rows the rest of the org generated, sized to exceed the pre-fix
 * orphan row cap on its own so an UNFILTERED read spends the whole budget here
 * and truncates the tool away — while `?kinds=tool` never truncates at all.
 */
const ORPHAN_ROW_CAP = 20_000;

describe("ISS-4797 — per-kind totals reconcile with the All total", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sums per-kind totals to exactly the All total", async () => {
    const allTotal = (await listOrg()).total;

    let perKindSum = 0;
    for (const kind of FIXTURE_KINDS) {
      perKindSum += (await listOrg([kind])).total;
    }

    // Pre-fix this read 150 vs 99: the kind-filtered reads kept components the
    // unfiltered read had already truncated away.
    expect(perKindSum).toBe(allTotal);
    expect(allTotal).toBe(COMMAND_IDENTITIES + SUBAGENT_IDENTITIES);
  });

  it("never lets a narrower filter GROW a kind's count (monotonicity)", async () => {
    const all = await listOrg();

    for (const kind of FIXTURE_KINDS) {
      const filtered = await listOrg([kind]);
      const withinAll = all.items.filter((item) => item.kind === kind).length;
      // The invariant that actually failed in production: `?kinds=subagent`
      // returned 246 where All contained 210 of the same kind. A facet can only
      // ever REMOVE components, so a filtered count can never exceed the count
      // of that kind inside the unfiltered population.
      expect(filtered.total).toBeLessThanOrEqual(withinAll);
      // Below the identity cap it is an equality, not merely a bound.
      expect(filtered.total).toBe(withinAll);
    }
  });

  it("returns the stale kind's ROWS in the All view, not just a reconciled count", async () => {
    const all = await listOrg();

    // A `total` that reconciles over a still-truncated item list is a different
    // lie, not a fix — so pin the rows too. Every stale subagent must be present
    // in the All response, under its own name.
    const subagentNames = all.items
      .filter((item) => item.kind === "subagent")
      .map((item) => item.name);
    expect(subagentNames).toHaveLength(SUBAGENT_IDENTITIES);
    expect(new Set(subagentNames)).toEqual(
      new Set(subagentKeys().map((key) => key))
    );
    expect(all.items).toHaveLength(allIdentityCount());
  });
});

describe("ISS-4799 — one usage population for the list and the detail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listByArtifactIds.mockResolvedValue([]);
  });

  it("reports the same invocations/sessions on the All row, the kind-filtered row, and the detail", async () => {
    const orphanRows = orphanUsageFixture();

    installServiceDb(orphanRows);
    const allRow = findTool(await agentComponentsService.listForOrg(ORG, LIST));

    installServiceDb(orphanRows);
    const toolRow = findTool(
      await agentComponentsService.listForOrg(ORG, {
        ...LIST,
        kinds: [TOOL_KIND],
      })
    );

    installServiceDb(orphanRows);
    const detail = await agentComponentsService.getDetailForOrg(
      ORG,
      encodeComponentSlug(TOOL_KIND, TOOL_KEY, null)
    );

    // Pre-fix these were 0/0, 61/55 and 61/55 in this fixture (1/1, 15/14 and
    // 61/55 in the reported org): the same component, read three ways, three
    // answers. The detail read was always identity-scoped and untruncated, so it
    // is the value the two list views must now agree with.
    expect(detail?.invocations).toBe(TOOL_INVOCATIONS);
    expect(detail?.sessions).toBe(TOOL_SESSIONS);
    expect(allRow?.invocations).toBe(detail?.invocations);
    expect(allRow?.sessions).toBe(detail?.sessions);
    expect(toolRow?.invocations).toBe(detail?.invocations);
    expect(toolRow?.sessions).toBe(detail?.sessions);
  });

  it("keeps the whole usage-only population visible in the All view", async () => {
    const orphanRows = orphanUsageFixture();

    installServiceDb(orphanRows);
    const all = await agentComponentsService.listForOrg(ORG, LIST);

    // The row path again: the noise components are not collateral damage of the
    // fix, and the tool is not the only survivor. Every distinct usage-only
    // identity surfaces exactly once.
    const identities = new Set(orphanRows.map((row) => row.componentKey));
    expect(all.total).toBe(identities.size);
    expect(new Set(all.items.map((item) => item.name))).toEqual(identities);
  });
});

/** The list query shape, with a page large enough to hold the whole fixture org. */
const LIST = { limit: 5000, offset: 0 };

/** Every distinct component identity the ISS-4797 fixture org installs. */
function allIdentityCount(): number {
  return COMMAND_IDENTITIES + SUBAGENT_IDENTITIES;
}

/** The stale subagent keys, in the order the fixture installs them. */
function subagentKeys(): string[] {
  return Array.from(
    { length: SUBAGENT_IDENTITIES },
    (_unused, index) => `explorer-${index}`
  );
}

/**
 * The ISS-4797 org: `COMMAND_IDENTITIES` commands each installed on
 * `INSTALLS_PER_COMMAND` compute targets (so raw rows exceed the cap while
 * distinct identities stay far below it), plus one row per stale subagent.
 */
function inventoryFixture(): InventoryFixture[] {
  const rows: InventoryFixture[] = [];
  for (let identity = 0; identity < COMMAND_IDENTITIES; identity++) {
    const key = `deploy-${identity}`;
    for (let install = 0; install < INSTALLS_PER_COMMAND; install++) {
      rows.push(
        makeInventoryRow({
          id: `c-${key}-${install}`,
          componentKind: "command",
          componentKey: key,
          name: key,
          computeTargetId: `${ORG_A}-target-${install}`,
          lastSeenAt: RECENT_SEEN_AT,
        })
      );
    }
  }
  for (const key of subagentKeys()) {
    rows.push(
      makeInventoryRow({
        id: `c-${key}`,
        componentKind: "subagent",
        componentKey: key,
        name: key,
        computeTargetId: `${ORG_A}-target-0`,
        lastSeenAt: STALE_SEEN_AT,
      })
    );
  }
  return rows;
}

/** Run `listForOrg` against a freshly installed ISS-4797 fixture org. */
function listOrg(kinds?: readonly string[]) {
  const built = buildPopulationDb({ inventory: inventoryFixture() });
  mocks.withDb.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(built.db)
  );
  mocks.withDb.tx.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(built.db)
  );
  return agentComponentsService.listForOrg(ORG_A, {
    ...LIST,
    ...(kinds ? { kinds: [...kinds] } : {}),
  });
}

/**
 * The ISS-4799 org: one heavily-used `tool` whose usage rows were never
 * FK-linked, buried under enough recent orphan usage from OTHER kinds to exhaust
 * the pre-fix orphan row cap on its own. The tool's own rows are the oldest, so
 * a recency-ordered raw-row cap drops every one of them from the unfiltered read
 * while a `?kinds=tool` read keeps them all.
 */
function orphanUsageFixture(): OrphanUsageShape[] {
  const rows: OrphanUsageShape[] = [];
  const noiseSessions = 50;
  const noiseIdentities = Math.ceil(ORPHAN_ROW_CAP / noiseSessions);
  for (let identity = 0; identity < noiseIdentities; identity++) {
    for (let session = 0; session < noiseSessions; session++) {
      rows.push({
        agentSessionId: `s-noise-${identity}-${session}`,
        componentKind: "skill",
        componentKey: `noisy-skill-${identity}`,
        invocationCount: 1,
        lastInvokedAt: RECENT_SEEN_AT,
      });
    }
  }
  // Usage that spans MORE THAN ONE DAY across many sessions, so the parity being
  // asserted is over a real multi-session fold rather than a single row.
  const extraInvocations = TOOL_INVOCATIONS - TOOL_SESSIONS;
  for (let session = 0; session < TOOL_SESSIONS; session++) {
    rows.push({
      agentSessionId: `s-tool-${session}`,
      componentKind: TOOL_KIND,
      componentKey: TOOL_KEY,
      harness: "claude",
      invocationCount: session < extraInvocations ? 2 : 1,
      firstInvokedAt: new Date("2026-02-01T00:00:00.000Z"),
      lastInvokedAt:
        session % 2 === 0
          ? new Date("2026-02-01T12:00:00.000Z")
          : new Date("2026-02-02T12:00:00.000Z"),
    });
  }
  return rows;
}

/**
 * Install the service-level double for the ISS-4799 org. The SAME orphan rows
 * back both lanes — the list's identity-capped `groupBy` and the detail's
 * per-identity row read — so the parity asserted is over one population, not two
 * fixtures that happen to agree.
 */
function installServiceDb(orphanRows: readonly OrphanUsageShape[]) {
  const db = buildServiceDb(
    {
      agentComponent: { findMany: vi.fn().mockResolvedValue([]) },
      agentComponentSessionUsage: {
        findMany: vi
          .fn()
          .mockImplementation(
            (args?: { where?: Record<string, unknown>; take?: number }) =>
              Promise.resolve(detailOrphanRead(orphanRows, args))
          ),
      },
    },
    orphanRows
  );
  mocks.withDb.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(db)
  );
  mocks.withDb.tx.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(db)
  );
}

/**
 * The DETAIL orphan read, which is still a row read: filter to the requested
 * identity, order by recency, apply the row cap. Modelling the cap here is what
 * lets the pre-fix LIST read (which shared this shape) actually truncate.
 */
function detailOrphanRead(
  rows: readonly OrphanUsageShape[],
  args?: { where?: Record<string, unknown>; take?: number }
) {
  const matching = rows.filter((row) => matchesOrphanWhere(row, args?.where));
  const ordered = sortByRecency(matching, (row) => row.lastInvokedAt ?? null);
  return takeRows(ordered, args?.take).map((row) => ({
    agentSessionId: row.agentSessionId,
    componentKind: row.componentKind,
    componentKey: row.componentKey,
    invocationCount: row.invocationCount,
    errorCount: row.errorCount ?? 0,
    harness: row.harness ?? null,
    firstInvokedAt: row.firstInvokedAt ?? null,
    lastInvokedAt: row.lastInvokedAt ?? null,
    componentVersionHash: null,
    definitionVersionId: null,
    gitBranch: "",
  }));
}

/** The ISS-4799 tool's row in a list response, if the read surfaced it at all. */
function findTool(response: { items: { name: string; kind: string }[] }) {
  return response.items.find(
    (item) => item.kind === TOOL_KIND && item.name === TOOL_KEY
  ) as
    | { name: string; kind: string; invocations: number; sessions: number }
    | undefined;
}
