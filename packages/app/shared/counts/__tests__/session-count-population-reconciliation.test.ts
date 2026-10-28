import { InsightsScope } from "@repo/api/src/types/insights";
import { describe, expect, it } from "vitest";
import { SESSION_COUNT_POPULATION_SCOPE } from "../session-count-population";
import {
  ALL_SESSION_COUNT_SITES,
  differingScopeAxes,
  reconcileSessionCountSites,
  SESSION_COUNT_MODELED_READ,
  SESSION_COUNT_RECONCILIATION,
  SESSION_COUNT_SCOPE_AXES,
  SESSION_COUNT_SCOPE_AXIS_COVERAGE,
  SESSION_COUNT_SITE,
  SESSION_COUNT_SITE_POPULATION,
  type SessionCountSite,
} from "../session-count-population-reconciliation";

/**
 * Independent expectations for surviving count sites. Operator-directed #7531
 * retires the splash, checklist and scan-status sites; their reconciliation rows
 * retire with them. Each remaining site has its own population, so self-pairs
 * exercise agreement while distinct sites exercise scope differences.
 */
const RECONCILIATION_FIXTURE = [
  {
    left: "sessionsListFooterOrg",
    right: "sessionsListFooterOrg",
    verdict: "reconciles",
    why: "An org list footer compared with itself reads the same scoped population.",
  },
  {
    left: "sessionsListFooterThisDevice",
    right: "sessionsListFooterThisDevice",
    verdict: "reconciles",
    why: "A device list footer compared with itself reads the same local population.",
  },
  {
    left: "dashboardKpiTileThisDevice",
    right: "sessionsListFooterThisDevice",
    verdict: "reconciles",
    why: "ISS-10541 closed this. The tile counted sessions STARTED in the window and the list counted sessions ACTIVE in it, so a reader met 1,290 on the list and 1,399 on the tile above it; the tile now windows on lastActivityAt like the list, both sites render sessionsInWindowThisDevice, and the verdict follows from that identity rather than from a claim written beside the pair. The golden corpus this was blocked on turned out not to move at all: no dossier straddles any window boundary, so windows.*.sessions is the same on either basis.",
  },
  {
    left: "sessionsListFooterOrg",
    right: "sessionsListFooterThisDevice",
    verdict: "intentionallyDiffers",
    why: "One sentence, two populations: the org over the cloud, or this machine's local store, decided by the desktop read mode with nothing on screen naming which.",
  },
  {
    left: "dashboardKpiTileOrg",
    right: "dashboardKpiTileThisDevice",
    verdict: "intentionallyDiffers",
    why: "The same org-versus-device split one level up, and the difference ISS-10541 did NOT close: one shared tile renders the cloud org read in Cloud mode and this machine's SQLite store in Local mode, over two axes (whole org becomes just you, all synced devices becomes this Mac). Stated because collapsing the tile onto the list's population left the date basis identical everywhere, and a fixture whose every row now reconciles would pass just as well with a verdict function that answered yes unconditionally.",
  },
  {
    left: "sessionsListFooterOrg",
    right: "dashboardKpiTileOrg",
    verdict: "reconciles",
    why: "The cloud half of the pair ISS-10541 closed: one population, sessionsInWindowOrg, read by the footer and by the tile above it over the same lastActivityAt window. UNQUALIFIED only with the Sessions toolbar at its empty selection, which is the state the tile — having no facet control of its own — always renders. Pick a Status or harness facet on the Sessions list and the footer counts the filtered rows while the tile keeps counting the whole window, so the two numbers disagree by design while this verdict still says reconciles. SessionCountPopulationScope has no facet axis, so differingScopeAxes cannot attribute that difference and the retired dashboardWindowed* member was the only way the registry could have said it (#7678 review, tamsinb). The registry states that boundary itself now (SESSION_COUNT_MODELED_READ, ISS-10888): every site is modeled at the empty facet selection, and the org tile at the org aggregation scope, so this verdict is no claim about a facet-filtered footer or a Me- or Team-scoped mount of the tile on either route (both default to Me).",
  },
  {
    left: "dashboardKpiTileThisDevice",
    right: "sessionsListFooterThisDevice",
    verdict: "reconciles",
    why: "ISS-10604's pair, stated a second time because it was the ticket that named the date-basis axis. It differed on that one axis while the alignment shipped default-off behind sessions-analytics-activity-window; ISS-10541 retired that cohort, so the two scope records are now identical AND the two sites render one population, which is what the derived verdict requires.",
  },
  {
    left: "dashboardKpiTileOrg",
    right: "sessionsListFooterOrg",
    verdict: "reconciles",
    why: "The same cloud pair with the sides swapped, kept so the symmetry case has an ordered pair to disagree about. It carried the SESSIONS_ANALYTICS_DATE_FIELD against SESSIONS_SURFACE_DATE_FIELD split; the insights reads no longer reach the analytics field at all, and the one PostHog key that used to gate both halves is gone, so web and desktop cannot answer differently about which column bounds a dashboard window.",
  },
] as const;

/**
 * ISS-10604's pairs, and the column they NOW render one date range against.
 *
 * The ticket was filed because the list read "active in this window" and the
 * dashboard read "started in this window", which put 10 on the Sessions page and
 * 7 on the Dashboard. The operator ruled ALIGN onto the list's basis
 * (2026-09-17); ISS-10604 shipped that behind `sessions-analytics-activity-window`
 * DEFAULT-OFF, so these rows correctly pinned the SPLIT rather than the target
 * while no viewer had the alignment (#7549 review, whitlockk). ISS-10541 retired the
 * cohort, so last activity is what both sides SHIP on and the same rule that
 * pinned `started` then pins `lastActivity` now.
 *
 * The expected column is the literal, never `SESSION_COUNT_DATE_BASIS`: a
 * fixture reading its answer from the enum it polices would follow a wrong
 * assignment wherever it went.
 */
const ALIGNED_DATE_BASIS_PAIRS = [
  { left: "dashboardKpiTileThisDevice", right: "sessionsListFooterThisDevice" },
  { left: "dashboardKpiTileOrg", right: "sessionsListFooterOrg" },
] as const;

describe("ISS-8474 AC-3: cross-surface count reconciliation", () => {
  it.each(RECONCILIATION_FIXTURE)(
    "$left vs $right → $verdict",
    ({ left, right, verdict }) => {
      expect(
        reconcileSessionCountSites(
          left as SessionCountSite,
          right as SessionCountSite
        )
      ).toBe(verdict);
    }
  );

  it("is symmetric — which count you read first cannot change the answer", () => {
    for (const { left, right, verdict } of RECONCILIATION_FIXTURE) {
      expect(
        reconcileSessionCountSites(
          right as SessionCountSite,
          left as SessionCountSite
        )
      ).toBe(verdict);
    }
  });

  it("states both directions, so neither a constant yes nor a constant no would pass", () => {
    const verdicts = RECONCILIATION_FIXTURE.map((row) => row.verdict);
    expect(
      verdicts.filter((v) => v === SESSION_COUNT_RECONCILIATION.Reconciles)
        .length
    ).toBeGreaterThanOrEqual(2);
    expect(
      verdicts.filter(
        (v) => v === SESSION_COUNT_RECONCILIATION.IntentionallyDiffers
      ).length
    ).toBeGreaterThanOrEqual(2);
  });

  it("gives a reason for every documented pair", () => {
    for (const row of RECONCILIATION_FIXTURE) {
      expect(row.why.length).toBeGreaterThan(40);
    }
  });

  it("names the scope axes behind every pair it says differs", () => {
    for (const { left, right, verdict } of RECONCILIATION_FIXTURE) {
      if (verdict !== SESSION_COUNT_RECONCILIATION.IntentionallyDiffers) {
        continue;
      }
      const leftPopulation =
        SESSION_COUNT_SITE_POPULATION[left as SessionCountSite];
      const rightPopulation =
        SESSION_COUNT_SITE_POPULATION[right as SessionCountSite];
      expect(leftPopulation).not.toBe(rightPopulation);
      // Assert the CONTENT, not merely that an array came back: every axis it
      // names must be one the two scope records genuinely disagree on. NOTE
      // since ISS-10541 no row here resolves to an EMPTY axis list — the rows
      // that used to (tile versus footer, byte-identical scopes over different
      // populations) are `reconciles` now and skipped above, so the empty case
      // this loop once exercised is exercised by nothing.
      const axes = differingScopeAxes(leftPopulation, rightPopulation);
      for (const axis of axes) {
        expect(SESSION_COUNT_POPULATION_SCOPE[leftPopulation][axis]).not.toBe(
          SESSION_COUNT_POPULATION_SCOPE[rightPopulation][axis]
        );
      }
      expect(axes.length).toBe(new Set(axes).size);
    }
  });

  it.each(ALIGNED_DATE_BASIS_PAIRS)(
    "$left and $right resolve to ONE population, on the list's column",
    ({ left, right }) => {
      const dashboardPopulation =
        SESSION_COUNT_SITE_POPULATION[left as SessionCountSite];
      const listPopulation =
        SESSION_COUNT_SITE_POPULATION[right as SessionCountSite];
      // The substantive claim, and the one that carries the ticket: the two
      // SITES now map to the same population. Asserting each side's `dateBasis`
      // separately would be comparing one record with itself now that they
      // resolve to one key — two lines that cannot disagree.
      expect(dashboardPopulation).toBe(listPopulation);
      // And that population is on the list's column, stated as the literal so a
      // drift of BOTH sites onto `started` still reddens.
      expect(
        SESSION_COUNT_POPULATION_SCOPE[dashboardPopulation].dateBasis
      ).toBe("lastActivity");
    }
  );

  it.each(ALIGNED_DATE_BASIS_PAIRS)(
    "$left and $right are derived as agreeing on a number",
    ({ left, right }) => {
      // ISS-10541's headline, stated over the pair the ticket named. This is
      // the case that inverts: while the tile had its own population the
      // contract answered `intentionallyDiffers` and recorded the divergence as
      // a known defect it could only report. Repointing either tile site back
      // to a `dashboardWindowed*` population turns this red.
      expect(
        reconcileSessionCountSites(
          left as SessionCountSite,
          right as SessionCountSite
        )
      ).toBe("reconciles");
    }
  );

  it("compares every axis a scope record carries", () => {
    // `SESSION_COUNT_SCOPE_AXES` is a side inventory of the scope record's keys,
    // and an axis on the record but missing from it is silently never compared.
    // The coverage map is the compile-time half; this is the runtime half, and
    // it reads the axis names as literals so deleting one from both the array
    // and the map still reddens.
    expect([...SESSION_COUNT_SCOPE_AXES].sort()).toEqual([
      "dateBasis",
      "device",
      "owner",
      "time",
      "unit",
      "workspace",
    ]);
    expect(Object.keys(SESSION_COUNT_SCOPE_AXIS_COVERAGE).sort()).toEqual(
      [...SESSION_COUNT_SCOPE_AXES].sort()
    );
  });

  it("covers every site, so a new count cannot ship undocumented", () => {
    const documented = new Set<string>();
    for (const { left, right } of RECONCILIATION_FIXTURE) {
      documented.add(left);
      documented.add(right);
    }
    for (const site of ALL_SESSION_COUNT_SITES) {
      expect(
        documented.has(site),
        `site "${site}" renders a count with no reconciliation row`
      ).toBe(true);
    }
  });
});

/**
 * ISS-10888: the boundary is RECORDED, not modeled — so it is pinned here, where
 * a change to it has to be made on purpose.
 *
 * `SESSION_COUNT_MODELED_READ` is asserted against independent values rather
 * than read back from the module (its org scope is also the scope the web org
 * tile's render guard mounts at), and the org tile's population is checked against the
 * scope the statement claims for it: repointing the tile at a population that
 * is not org-owned would make the statement false, and reddens here.
 */
describe("ISS-10888: the registry states which read it models", () => {
  it("models the unfiltered read, and the org aggregation scope for org sites", () => {
    expect(SESSION_COUNT_MODELED_READ).toStrictEqual({
      facetSelection: "empty",
      orgAggregationScope: InsightsScope.Org,
    });
  });

  it("keeps the org tile on an org-owned population, as the statement claims", () => {
    expect(
      SESSION_COUNT_POPULATION_SCOPE[
        SESSION_COUNT_SITE_POPULATION[SESSION_COUNT_SITE.DashboardKpiTileOrg]
      ].owner
    ).toBe("organization");
  });

  it("cites the statement from the fixture row that would otherwise overclaim", () => {
    const row = RECONCILIATION_FIXTURE.find(
      (entry) =>
        entry.left === "sessionsListFooterOrg" &&
        entry.right === "dashboardKpiTileOrg"
    );
    expect(row?.why).toContain("SESSION_COUNT_MODELED_READ");
  });
});
