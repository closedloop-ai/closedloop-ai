/**
 * ISS-4797 + ISS-4799: what the org-population identity cap does at its edges.
 *
 * The sibling `org-population-facet-invariants` suite pins the invariants that
 * hold BELOW the cap — per-kind totals summing to the All total, a filtered count
 * never exceeding its share of All, one usage population for the list and the
 * detail. This suite covers the two edges that only exist ABOVE it:
 *
 *  - WHICH components the cap keeps when it actually has to choose. Both lanes
 *    order their spine by an aggregate of a NULLABLE recency column, and Postgres
 *    sorts NULLs FIRST under `DESC` — so a never-stamped identity outranks every
 *    genuinely recent component unless the read demotes it. Prisma cannot express
 *    `NULLS LAST` on a `_max` order key, which is why the demotion is a code path
 *    rather than a clause, and why it needs a test.
 *  - What happens when the MEMORY ceiling (`MAX_ORG_POPULATION_ROWS`) is reached.
 *    That ceiling is facet-dependent by nature, so touching it is the one
 *    condition under which the invariants above could stop holding: it must be
 *    reported, and it must not take the request down with it.
 *
 * The doubles these tests run against model Postgres's NULLS-FIRST ordering
 * honestly (see `identitySpine` in `usage-lane-doubles`), so the first test below
 * fails against a spine that reads the cap in one pass.
 */

import { AGENT_COMPONENT_INVENTORY_CAP } from "@repo/api/src/types/agent-component";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  listByArtifactIds: vi.fn(),
  logError: vi.fn(),
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
  agentSessionsService: { listByArtifactIds: mocks.listByArtifactIds },
}));

import {
  MAX_ORG_POPULATION_ROWS,
  OrgPopulationLane,
} from "../org-population-reads";
import { agentComponentsService } from "../service";
import {
  buildPopulationDb,
  type InventoryFixture,
  makeInventoryRow,
  ORG_A,
} from "./org-population-fixtures";

/** The list query shape, at the largest page the validator admits. */
const LIST = { limit: AGENT_COMPONENT_INVENTORY_CAP, offset: 0 };

/**
 * Never-stamped identities, sized to fill the identity cap on their own. Under
 * Postgres's NULLS-FIRST `DESC` ordering these sort ahead of EVERY stamped
 * component, so a single-pass spine hands them the entire cap.
 */
const UNSTAMPED_IDENTITIES = AGENT_COMPONENT_INVENTORY_CAP;

/**
 * Recently-seen identities the org actually uses. Deliberately far fewer than
 * the unstamped cohort: the defect is not that they lose a close race, it is
 * that they lose to rows carrying no timestamp at all.
 */
const STAMPED_IDENTITIES = 40;

/** Recent enough that no stamped/unstamped comparison is ambiguous. */
const RECENT_SEEN_AT = new Date("2026-07-30T00:00:00.000Z");

describe("ISS-4797 — an above-cap org keeps its RECENT components", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listByArtifactIds.mockResolvedValue([]);
  });

  it("does not let never-stamped identities win the cap over recent ones", async () => {
    installPopulation(overCapInventory());

    const all = await agentComponentsService.listForOrg(ORG_A, LIST);

    // The assertion that fails against a one-pass spine: with NULLs sorted first
    // the cap is consumed entirely by identities the scanner never stamped, and
    // not one of the org's recent components survives.
    const surfaced = new Set(all.items.map((item) => item.name));
    for (const key of stampedKeys()) {
      expect(surfaced).toContain(key);
    }
    // The cap still binds — this is an above-cap org, so the demotion is
    // observable rather than vacuous.
    expect(all.total).toBe(AGENT_COMPONENT_INVENTORY_CAP);
  });

  it("still fills the cap from the never-stamped tail once the recent ones are in", async () => {
    installPopulation(overCapInventory());

    const all = await agentComponentsService.listForOrg(ORG_A, LIST);

    // Demoting the unstamped identities must not DISCARD them: they top the cap
    // up to its full size behind the stamped ones. A read that returned only the
    // 40 stamped components would satisfy the test above and still be wrong.
    const unstamped = all.items.filter((item) =>
      item.name?.startsWith(UNSTAMPED_PREFIX)
    );
    expect(unstamped).toHaveLength(
      AGENT_COMPONENT_INVENTORY_CAP - STAMPED_IDENTITIES
    );
  });

  it("keeps the retained component set stable across identical requests", async () => {
    installPopulation(overCapInventory());
    const first = await agentComponentsService.listForOrg(ORG_A, LIST);

    installPopulation(overCapInventory());
    const second = await agentComponentsService.listForOrg(ORG_A, LIST);

    // The deterministic `(componentKind, componentKey)` tiebreak is what makes an
    // above-cap org drop the SAME components request to request, instead of a
    // set that shifts under the caller and makes every count irreproducible.
    expect(second.items.map((item) => item.name)).toEqual(
      first.items.map((item) => item.name)
    );
  });

  it("still binds the cap when STRADDLING identities shrink the spine below it", async () => {
    installPopulation(straddlingInventory());

    const all = await agentComponentsService.listForOrg(ORG_A, LIST);

    // A straddling identity — one holding BOTH a stamped and a never-stamped row
    // — matches both narrowed passes, so the second pass spends part of its
    // budget on rows the dedupe then drops. The spine therefore comes back UNDER
    // the cap for a population that plainly exceeds it. Reading truncation off
    // that length says "not truncated", drops the identity narrowing on the row
    // read, and hands the population straight back to the facet-dependent row
    // ceiling this change exists to remove. Truncation is reported by the read
    // that hit its cap instead, so the retained set stays capped.
    expect(all.total).toBeLessThanOrEqual(AGENT_COMPONENT_INVENTORY_CAP);
    // And it is the cap doing the work, not the fixture being small: the org has
    // more identities than the cap admits.
    expect(straddlingIdentityCount()).toBeGreaterThan(
      AGENT_COMPONENT_INVENTORY_CAP
    );
  });
});

describe("ISS-4797 — the row ceiling is reported, not swallowed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listByArtifactIds.mockResolvedValue([]);
  });

  it("logs the anomaly and still answers when a lane materializes MAX_ORG_POPULATION_ROWS", async () => {
    installPopulation(ceilingRows());

    const all = await agentComponentsService.listForOrg(ORG_A, LIST);

    // Degrade, don't throw: a pathological org gets a bounded answer, not a
    // failed request. The rows all carry one identity, so they fold to one row.
    expect(all.items).toHaveLength(1);
    // And the ceiling is surfaced at error level, tagged with the lane that hit
    // it — the row ceiling is facet-DEPENDENT, so reaching it is the one
    // condition under which the ISS-4797/ISS-4799 invariants could stop holding.
    expect(mocks.logError).toHaveBeenCalledWith(
      "agent_components_org_population_row_ceiling_reached",
      expect.objectContaining({
        ceiling: MAX_ORG_POPULATION_ROWS,
        lane: OrgPopulationLane.Inventory,
        organizationId: ORG_A,
        rowCount: MAX_ORG_POPULATION_ROWS,
      })
    );
  });

  it("stays silent for a population below the ceiling", async () => {
    installPopulation(overCapInventory());

    await agentComponentsService.listForOrg(ORG_A, LIST);

    // An above-cap org is NOT an anomaly — the identity cap is the routine bound
    // and it truncates silently by design. Only the row ceiling is the alarm, so
    // a read that logged here would be crying wolf on every large org.
    expect(mocks.logError).not.toHaveBeenCalledWith(
      "agent_components_org_population_row_ceiling_reached",
      expect.anything()
    );
  });
});

/** Name prefix of the never-stamped cohort, so a response can be split by it. */
const UNSTAMPED_PREFIX = "unstamped-";

/** The recently-seen keys, in the order the fixture installs them. */
function stampedKeys(): string[] {
  return Array.from(
    { length: STAMPED_IDENTITIES },
    (_unused, index) => `recent-${index}`
  );
}

/**
 * An org above the identity cap whose components split into two cohorts: a
 * never-stamped majority (`lastSeenAt: null`) and a small recently-seen set. One
 * row per identity, so the ROW ceiling stays far away and the only bound under
 * test is the identity cap.
 */
function overCapInventory(): InventoryFixture[] {
  const rows: InventoryFixture[] = [];
  for (let index = 0; index < UNSTAMPED_IDENTITIES; index++) {
    const key = `${UNSTAMPED_PREFIX}${index}`;
    rows.push(
      makeInventoryRow({
        id: `c-${key}`,
        componentKind: "command",
        componentKey: key,
        name: key,
        computeTargetId: `${ORG_A}-target-0`,
        lastSeenAt: null,
      })
    );
  }
  for (const key of stampedKeys()) {
    rows.push(
      makeInventoryRow({
        id: `c-${key}`,
        componentKind: "command",
        componentKey: key,
        name: key,
        computeTargetId: `${ORG_A}-target-0`,
        lastSeenAt: RECENT_SEEN_AT,
      })
    );
  }
  return rows;
}

/**
 * Identities that own BOTH a stamped and a never-stamped row — the shape that
 * makes the spine's two narrowed passes overlap. Enough of them that the dedupe
 * is guaranteed to eat into the second pass's budget rather than only maybe.
 */
const STRADDLING_IDENTITIES = 200;

/** Every distinct identity {@link straddlingInventory} installs. */
function straddlingIdentityCount(): number {
  return STAMPED_IDENTITIES + STRADDLING_IDENTITIES + UNSTAMPED_IDENTITIES;
}

/**
 * An above-cap org built so the identity spine's two narrowed passes OVERLAP: a
 * straddling cohort whose members each carry one stamped row and one unstamped
 * row, so every one of them is returned by the stamped pass AND by the unstamped
 * pass, plus pure-stamped and pure-unstamped cohorts around it.
 */
function straddlingInventory(): InventoryFixture[] {
  const rows = overCapInventory();
  for (let index = 0; index < STRADDLING_IDENTITIES; index++) {
    const key = `straddler-${index}`;
    rows.push(
      makeInventoryRow({
        id: `c-${key}-stamped`,
        componentKind: "command",
        componentKey: key,
        name: key,
        computeTargetId: `${ORG_A}-target-0`,
        lastSeenAt: RECENT_SEEN_AT,
      }),
      makeInventoryRow({
        id: `c-${key}-unstamped`,
        componentKind: "command",
        componentKey: key,
        name: key,
        computeTargetId: `${ORG_A}-target-1`,
        lastSeenAt: null,
      })
    );
  }
  return rows;
}

/**
 * A single component installed on `MAX_ORG_POPULATION_ROWS` compute targets:
 * ONE identity (so the identity cap never binds and the spine reports no
 * truncation) whose raw rows reach the memory ceiling exactly.
 */
function ceilingRows(): InventoryFixture[] {
  return Array.from({ length: MAX_ORG_POPULATION_ROWS }, (_unused, index) =>
    makeInventoryRow({
      id: `c-fleet-${index}`,
      componentKind: "command",
      componentKey: "fleet-wide",
      name: "fleet-wide",
      computeTargetId: `${ORG_A}-target-${index}`,
      lastSeenAt: RECENT_SEEN_AT,
    })
  );
}

/**
 * Install a fresh population double over one inventory fixture, which backs the
 * identity spine and the row read alike — the same list the real reads see.
 */
function installPopulation(inventory: InventoryFixture[]) {
  const built = buildPopulationDb({ inventory });
  mocks.withDb.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(built.db)
  );
  mocks.withDb.tx.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(built.db)
  );
  return built;
}
