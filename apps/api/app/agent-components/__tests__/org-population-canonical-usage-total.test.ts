/**
 * ISS-5516 regression suite: ONE canonical usage total per component, at any org
 * size.
 *
 * ISS-4797/ISS-4799 moved the org population's correctness bound off raw rows and
 * onto distinct component IDENTITY, which made the facet invariants hold — but it
 * left a SECOND bound in place: a raw-row ceiling (`MAX_ORG_POPULATION_ROWS`,
 * 32,000) applied to the same facet-scoped `where`. A row cap applied after a
 * facet predicate is facet-DEPENDENT by construction — a `?kinds=` read starts
 * from fewer identities, so it reaches the ceiling later and keeps MORE of each
 * component's rows than the unfiltered read does — so above that threshold every
 * invariant came back. The module's own header said as much; the reported org
 * proved it, because the orphan lane groups per (identity, SESSION, …) and a
 * component running in thousands of sessions reaches 32,000 groups on ordinary
 * traffic.
 *
 * Four simultaneous authenticated reads of one component returned four different
 * totals, and this suite pins the four symptoms that followed from that one
 * cause:
 *
 *   1. `tool::bash` read 433,625 invocations on the Tools tab, 469,045 through
 *      search, and 469,045 on its detail page.
 *   2. `[Jun 9 → now]` returned 912 components while `[Jun 9 → Jul 9]`, a strict
 *      SUB-range, returned 962 — a subset larger than the set containing it.
 *   3. `?kinds=subagent` totalled 535 against 312 subagent rows in the All tab.
 *   4. Five disjoint windows summed to 1,584,311 invocations where the all-time
 *      card read 674,008.
 *
 * The sibling `org-population-facet-invariants` suite covers the same invariants
 * but seeds ~5,000 rows — above the ORIGINAL raw-row cap and far below the 32,000
 * one that replaced it — so it went vacuous against the ceiling this change
 * removes. The fixture here deliberately exceeds 32,000 rows while keeping the
 * distinct identity count far below the identity cap, which is the shape of the
 * org that reported the defect.
 *
 * Every test drives the real `listForOrg` / `getDetailForOrg` production paths.
 */

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

import { buildServiceDb } from "@/__tests__/support/agent-components/service-db-double";
import {
  detailOrphanRowRead,
  type OrphanUsageShape,
  REMOVED_ROW_CEILING,
} from "@/__tests__/support/agent-components/usage-lane-doubles";
import { agentComponentsService } from "../service";

const ORG = "org-canonical-usage-total";

/**
 * The raw-row ceiling this change removes. It now lives in `usage-lane-doubles`
 * so this suite and its `org-population-orphan-seen-window` sibling police one
 * value; that module is test-owned, so importing it does NOT reintroduce the
 * "measure the code against itself" problem a production import would.
 */

/** The component the ticket read four different totals for. */
const TOOL_KIND = "tool";
const TOOL_KEY = "bash";

/**
 * The tool's usage, split across two disjoint months so the window arithmetic
 * below folds over a real multi-session population rather than one row.
 * Independently pinned literals — the assertions must not re-derive them from the
 * fixture builder they are policing.
 */
const TOOL_FEBRUARY_SESSIONS = 240;
const TOOL_MARCH_SESSIONS = 160;
const TOOL_SESSIONS = 400;
/** February sessions invoke twice, March sessions once: 240×2 + 160×1. */
const TOOL_FEBRUARY_INVOCATIONS = 480;
const TOOL_MARCH_INVOCATIONS = 160;
const TOOL_INVOCATIONS = 640;

/**
 * The RECENT noise cohort: few identities, very many sessions each, sized to
 * exhaust the removed ceiling on its own. Under a global recency-ordered row cap
 * these rows won the entire budget, so the unfiltered read saw nothing else.
 */
const NOISE_IDENTITIES = 40;
const NOISE_SESSIONS_EACH = REMOVED_ROW_CEILING / NOISE_IDENTITIES;

/**
 * The STALE cohort: many identities, one session each, older than the noise.
 *
 * Deliberately more numerous than the noise cohort. That is what reproduces
 * symptom 2 — a window narrow enough to exclude the noise retains all 500 of
 * these, so the sub-range returned MORE components than the range containing it,
 * which had truncated every one of them away.
 */
const STALE_IDENTITIES = 500;

/** July: after every windowed range this suite asks about. */
const NOISE_INVOKED_AT = new Date("2026-07-15T00:00:00.000Z");
const FEBRUARY_INVOKED_AT = new Date("2026-02-10T00:00:00.000Z");
const MARCH_INVOKED_AT = new Date("2026-03-10T00:00:00.000Z");

/**
 * Disjoint, and together covering every non-noise row in the fixture. ISO strings
 * because that is what the list query carries off the wire.
 */
const FEBRUARY_WINDOW = {
  startDate: "2026-02-01T00:00:00.000Z",
  endDate: "2026-02-28T23:59:59.000Z",
};
const MARCH_WINDOW = {
  startDate: "2026-03-01T00:00:00.000Z",
  endDate: "2026-03-31T23:59:59.000Z",
};
/** A strict SUPER-range of both windows above, and of the noise cohort too. */
const CONTAINING_WINDOW = {
  startDate: "2026-01-01T00:00:00.000Z",
  endDate: "2026-12-31T23:59:59.000Z",
};
/** A strict SUB-range of {@link CONTAINING_WINDOW}: Feb + Mar, no noise. */
const CONTAINED_WINDOW = {
  startDate: "2026-02-01T00:00:00.000Z",
  endDate: "2026-03-31T23:59:59.000Z",
};

const LIST = { limit: 5000, offset: 0 };

describe("ISS-5516 — one component, one usage total, whichever view asks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listByArtifactIds.mockResolvedValue([]);
  });

  it("reports the same invocations and sessions on the All tab, the kind tab, search, and the detail page", async () => {
    installDb();
    const allRow = findTool(await agentComponentsService.listForOrg(ORG, LIST));

    installDb();
    const kindRow = findTool(
      await agentComponentsService.listForOrg(ORG, {
        ...LIST,
        kinds: [TOOL_KIND],
      })
    );

    installDb();
    const searchRow = findTool(
      await agentComponentsService.listForOrg(ORG, {
        ...LIST,
        search: TOOL_KEY,
      })
    );

    installDb();
    const detail = await agentComponentsService.getDetailForOrg(
      ORG,
      encodeComponentSlug(TOOL_KIND, TOOL_KEY, null)
    );

    // Pinned against literals, not against each other: four reads agreeing on a
    // number that is itself truncated would satisfy a cross-comparison and still
    // be the defect. The detail read was always identity-scoped, so its value is
    // the one the three list views owed all along.
    expect(detail?.invocations).toBe(TOOL_INVOCATIONS);
    expect(detail?.sessions).toBe(TOOL_SESSIONS);
    expect(allRow?.invocations).toBe(TOOL_INVOCATIONS);
    expect(allRow?.sessions).toBe(TOOL_SESSIONS);
    expect(kindRow?.invocations).toBe(TOOL_INVOCATIONS);
    expect(kindRow?.sessions).toBe(TOOL_SESSIONS);
    expect(searchRow?.invocations).toBe(TOOL_INVOCATIONS);
    expect(searchRow?.sessions).toBe(TOOL_SESSIONS);
  });

  it("never lets a kind facet total exceed that kind's population inside the All tab", async () => {
    installDb();
    const all = await agentComponentsService.listForOrg(ORG, LIST);

    let perKindSum = 0;
    for (const kind of fixtureKinds()) {
      installDb();
      const filtered = await agentComponentsService.listForOrg(ORG, {
        ...LIST,
        kinds: [kind],
      });
      const withinAll = all.items.filter((item) => item.kind === kind).length;
      // Symptom 3: `?kinds=subagent` returned 535 against 312 in All. A facet can
      // only ever REMOVE components, so exceeding the All-tab count is not a
      // different definition — it is a count taken over a different population.
      expect(filtered.total).toBeLessThanOrEqual(withinAll);
      expect(filtered.total).toBe(withinAll);
      perKindSum += filtered.total;
    }

    // And the All tab is not itself truncated: every identity in the fixture is
    // present, so the equalities above are not two truncations agreeing.
    expect(all.total).toBe(NOISE_IDENTITIES + STALE_IDENTITIES + 1);
    expect(perKindSum).toBe(all.total);
  });

  it("never lets a narrower date window return MORE components than the window containing it", async () => {
    installDb();
    const containing = await agentComponentsService.listForOrg(ORG, {
      ...LIST,
      ...CONTAINING_WINDOW,
    });

    installDb();
    const contained = await agentComponentsService.listForOrg(ORG, {
      ...LIST,
      ...CONTAINED_WINDOW,
    });

    // Symptom 2: [Jun 9 → now] returned 912 while [Jun 9 → Jul 9] returned 962.
    // Pre-fix this fixture reads 40 vs 501 — the containing range spent its whole
    // row budget on the recent noise cohort and truncated away all 500 stale
    // components the sub-range then retained.
    expect(contained.total).toBeLessThanOrEqual(containing.total);
    expect(containing.total).toBe(NOISE_IDENTITIES + STALE_IDENTITIES + 1);
    expect(contained.total).toBe(STALE_IDENTITIES + 1);
  });

  it("sums a component's disjoint windows to its unwindowed total", async () => {
    installDb();
    const february = findTool(
      await agentComponentsService.listForOrg(ORG, {
        ...LIST,
        ...FEBRUARY_WINDOW,
      })
    );

    installDb();
    const march = findTool(
      await agentComponentsService.listForOrg(ORG, { ...LIST, ...MARCH_WINDOW })
    );

    installDb();
    const allTime = findTool(
      await agentComponentsService.listForOrg(ORG, LIST)
    );

    // Symptom 4: five disjoint windows summed to 1,584,311 against an all-time
    // card reading 674,008 — the all-time read truncated hardest because it had
    // the most rows to spend its budget on. Each side is pinned to its own
    // literal, so an arithmetic identity cannot be satisfied by two wrong numbers.
    expect(february?.invocations).toBe(TOOL_FEBRUARY_INVOCATIONS);
    expect(march?.invocations).toBe(TOOL_MARCH_INVOCATIONS);
    expect(allTime?.invocations).toBe(TOOL_INVOCATIONS);
    expect((february?.invocations ?? 0) + (march?.invocations ?? 0)).toBe(
      allTime?.invocations
    );
    expect(february?.sessions).toBe(TOOL_FEBRUARY_SESSIONS);
    expect(march?.sessions).toBe(TOOL_MARCH_SESSIONS);
  });
});

/** Every component kind the fixture org carries. */
function fixtureKinds(): string[] {
  return ["skill", "command", TOOL_KIND];
}

/**
 * An org whose orphan usage exceeds the removed row ceiling while its distinct
 * identity count stays far below the identity cap — the shape that made the
 * ceiling, not the identity cap, decide the answer.
 *
 * Three cohorts: RECENT noise (few identities, very many sessions) that used to
 * win the whole row budget; STALE single-session components that used to be
 * truncated away wholesale; and the heavily-used tool whose four totals the
 * ticket reported.
 */
function usageFixture(): OrphanUsageShape[] {
  const rows: OrphanUsageShape[] = [];
  for (let identity = 0; identity < NOISE_IDENTITIES; identity++) {
    for (let session = 0; session < NOISE_SESSIONS_EACH; session++) {
      rows.push({
        agentSessionId: `s-noise-${identity}-${session}`,
        componentKind: "skill",
        componentKey: `noisy-skill-${identity}`,
        invocationCount: 1,
        firstInvokedAt: NOISE_INVOKED_AT,
        lastInvokedAt: NOISE_INVOKED_AT,
      });
    }
  }
  for (let identity = 0; identity < STALE_IDENTITIES; identity++) {
    rows.push({
      agentSessionId: `s-stale-${identity}`,
      componentKind: "command",
      componentKey: `stale-command-${identity}`,
      invocationCount: 1,
      firstInvokedAt: FEBRUARY_INVOKED_AT,
      lastInvokedAt: FEBRUARY_INVOKED_AT,
    });
  }
  for (let session = 0; session < TOOL_FEBRUARY_SESSIONS; session++) {
    rows.push({
      agentSessionId: `s-tool-feb-${session}`,
      componentKind: TOOL_KIND,
      componentKey: TOOL_KEY,
      harness: "claude",
      invocationCount: 2,
      firstInvokedAt: FEBRUARY_INVOKED_AT,
      lastInvokedAt: FEBRUARY_INVOKED_AT,
    });
  }
  for (let session = 0; session < TOOL_MARCH_SESSIONS; session++) {
    rows.push({
      agentSessionId: `s-tool-mar-${session}`,
      componentKind: TOOL_KIND,
      componentKey: TOOL_KEY,
      harness: "claude",
      invocationCount: 1,
      firstInvokedAt: MARCH_INVOKED_AT,
      lastInvokedAt: MARCH_INVOKED_AT,
    });
  }
  return rows;
}

/**
 * Install the service double over one usage population, backing BOTH the list's
 * identity-scoped `groupBy` pair and the detail's per-identity row read. The same
 * rows serve both, so the parity these tests assert is over one population rather
 * than two fixtures that happen to agree.
 *
 * The org has no inventory rows at all: every component here is usage-only, which
 * is what routes the whole fixture through the orphan lane the ceiling bounded.
 */
function installDb() {
  const rows = usageFixture();
  const db = buildServiceDb(
    {
      agentComponent: { findMany: vi.fn().mockResolvedValue([]) },
      agentComponentSessionUsage: {
        findMany: vi
          .fn()
          .mockImplementation(
            (args?: { where?: Record<string, unknown>; take?: number }) =>
              Promise.resolve(detailOrphanRowRead(rows, args))
          ),
      },
    },
    rows
  );
  mocks.withDb.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(db)
  );
  mocks.withDb.tx.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(db)
  );
}

/** The tool's row in a list response, if the read surfaced it at all. */
function findTool(response: { items: { name: string; kind: string }[] }) {
  return response.items.find(
    (item) => item.kind === TOOL_KIND && item.name === TOOL_KEY
  ) as
    | { name: string; kind: string; invocations: number; sessions: number }
    | undefined;
}
