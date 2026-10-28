import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript6";
import { describe, expect, it } from "vitest";
import {
  ALL_SESSION_COUNT_SITES,
  reconcileSessionCountSites,
  SESSION_COUNT_RECONCILIATION,
  SESSION_COUNT_SITE,
  SESSION_COUNT_SITE_POPULATION,
  type SessionCountSite,
} from "../session-count-population-reconciliation";
import { SESSION_COUNT_SITE_DECLARING_MODULES } from "../session-count-render-site";

/**
 * ISS-10585: the contract is only worth what it is attached to.
 *
 * `SESSION_COUNT_SITE` enumerated fourteen render sites and twelve of them were
 * referenced nowhere outside the registry and its own tests — a contract that
 * could not fail for the thing it exists to police. Three "Sessions" counts
 * landed on three different windows with the reconciliation suite green
 * throughout.
 *
 * WHERE AC-1 IS SATISFIED, stated plainly so no reader has to infer it: at the
 * HOST, not inside the component that draws the digits. `SessionsListSurfaceV2`
 * carries only `scopeUserId` and the dashboard's `OverviewKpiCard` renders
 * whatever value it is handed; NEITHER SHARED COMPONENT KNOWS ITS OWN SCOPE, so
 * neither can tell the org spelling of a count from the this-device one. The
 * host that feeds the data is the only place that distinguishes them, so that is
 * where the identifier lives (operator ruling, 2026-09-18). The narrower claim
 * is deliberate: threading a `site` prop through a shared component that never
 * consumes it would be a prop that exists to look wired.
 *
 * THE EXPECTATIONS BELOW ARE INDEPENDENT LITERALS, traced from what each
 * component actually renders and then ASSERTED against
 * `SESSION_COUNT_SITE_POPULATION` rather than read out of it. The duplication is
 * the test: a fixture that derives its answer from the map it guards goes on
 * passing when a row is repointed, which is the precise unfalsifiability this
 * ticket exists to remove.
 */
const EXPECTED_WIRING = [
  {
    site: "sessionsListFooterOrg",
    population: "sessionsInWindowOrg",
    why: "The v2 Sessions surface's footer sentence, fed by the web host's cloud read.",
  },
  {
    site: "sessionsListFooterThisDevice",
    population: "sessionsInWindowThisDevice",
    why: "The same shared footer, fed by the desktop view's local store query.",
  },
  {
    site: "dashboardKpiTileOrg",
    population: "sessionsInWindowOrg",
    why: "The dashboard Sessions tile over the cloud, at the org aggregation scope the registry models (SESSION_COUNT_MODELED_READ, ISS-10888) and no claim about a Me- or Team-scoped mount on either route (dashboard and insights both default to Me). ISS-10541 repointed it: `fetchSessionRollup` windows on `s.last_activity_at` unconditionally, so the tile renders the same population the list footer does and the two numbers are one number.",
  },
  {
    site: "dashboardKpiTileThisDevice",
    population: "sessionsInWindowThisDevice",
    why: "The same tile read from this machine's store, repointed with it — `computeUtilization` takes its column from a range that no longer carries a choice, so desktop cannot answer differently from the cloud half above.",
  },
] as const;

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../../..");

/**
 * ISS-10660: the render guard each declaring host carries, keyed by the host
 * module exactly as `SESSION_COUNT_SITE_DECLARING_MODULES` spells it.
 *
 * Per host rather than one shared harness because `apps/app` and `apps/desktop`
 * do not depend on each other, so no single suite can mount both shells. Each
 * guard mounts its host with stub data and asserts the count it draws; this
 * roster is what stops a NEW declaring module shipping with none, and stops a
 * guard being deleted while its host is still declared.
 */
const SESSION_COUNT_SITE_RENDER_GUARDS: Readonly<Record<string, string>> = {
  "apps/app/components/agent-sessions/sessions-list-v2-host.tsx":
    "apps/app/components/agent-sessions/__tests__/sessions-list-v2-host-session-count-render.test.tsx",
  "apps/desktop/src/renderer/components/sessions/sessions-v2-view.tsx":
    "apps/desktop/src/renderer/components/sessions/__tests__/sessions-v2-view-session-count-render.test.tsx",
  "packages/app/insights/components/insights-data-source-provider.tsx":
    "packages/app/insights/components/__tests__/insights-data-source-provider-session-count-render.test.tsx",
  "apps/desktop/src/renderer/components/insights/desktop-insights-provider.tsx":
    "apps/desktop/src/renderer/components/insights/__tests__/desktop-insights-provider-session-count-render.test.tsx",
};

const expectedPopulationOf = (site: string): string => {
  const row = EXPECTED_WIRING.find((entry) => entry.site === site);
  if (row === undefined) {
    throw new Error(`no independently-written expectation for site "${site}"`);
  }
  return row.population;
};

describe("ISS-10585: every render site is wired to the contract", () => {
  it("covers every member, so a new site cannot ship unwired", () => {
    const expected = EXPECTED_WIRING.map((row) => row.site).sort();
    expect([...ALL_SESSION_COUNT_SITES].sort()).toStrictEqual(expected);
  });

  it("says why each site renders what it does, so a row cannot be copied blind", () => {
    for (const row of EXPECTED_WIRING) {
      expect(row.why.length, row.site).toBeGreaterThan(40);
    }
  });

  /**
   * One case per site, carrying BOTH mechanisms on purpose.
   *
   * The binding assertion is first and is the load-bearing one: the traced
   * population above is compared directly to what the registry claims, so
   * repointing ANY site reddens here — including the case the pair matrix below
   * cannot see, where a site moves to a population no other site renders and the
   * equivalence classes are therefore unchanged.
   *
   * The AST walk is the SECOND mechanism (operator ruling, 2026-09-18). It
   * closes a hole the behavioural half cannot see — that the module a binding
   * names really does reference the member — and it lives in this same case so
   * that it cannot survive alone: delete the binding assertion and you are
   * editing the very test the AST walk reports through.
   *
   * WHAT NEITHER MECHANISM PROVES on its own: that the reference sits on the
   * render path. Nothing in THIS file opens a host module looking for the count
   * it draws — asserting a particular JSX element per site is
   * source-shape-as-proof, which AC-3 pushes away from and which reddens on
   * innocent renames (operator ruling, 2026-09-18). That half is held by the
   * per-host RENDER guards instead (ISS-10660), rostered in
   * `SESSION_COUNT_SITE_RENDER_GUARDS` below: each one mounts its declaring host
   * with stub data and observes the count on screen, so deleting a host's
   * count expression while leaving its `export const` in place reddens there.
   *
   * The walk also matches `SESSION_COUNT_SITE.Member` property access
   * specifically, so a destructure or an index signature would read as absent.
   */
  it.each(EXPECTED_WIRING)(
    "$site is bound to its traced population and named by its own modules",
    ({ site, population }) => {
      expect(SESSION_COUNT_SITE_POPULATION[site as SessionCountSite]).toBe(
        population
      );
      const modules =
        SESSION_COUNT_SITE_DECLARING_MODULES[site as SessionCountSite];
      // At least one, never exactly one: a member maps to N modules by
      // construction. Asserted here as well as being the
      // roster's business, because an empty list would otherwise make the walk
      // below iterate zero times and pass silently.
      expect(modules.length).toBeGreaterThanOrEqual(1);
      expect(new Set(modules).size).toBe(modules.length);
      for (const relative of modules) {
        const absolute = path.join(REPO_ROOT, relative);
        const source = ts.createSourceFile(
          absolute,
          readFileSync(absolute, "utf8"),
          ts.ScriptTarget.Latest,
          true
        );
        const referenced = new Set<string>();
        const visit = (node: ts.Node): void => {
          if (
            ts.isPropertyAccessExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === "SESSION_COUNT_SITE"
          ) {
            referenced.add(node.name.text);
          }
          ts.forEachChild(node, visit);
        };
        visit(source);
        expect(
          referenced.size,
          `${relative} references no site member`
        ).toBeGreaterThan(0);
        const referencedSites = [...referenced].map(
          (name) => SESSION_COUNT_SITE[name as keyof typeof SESSION_COUNT_SITE]
        );
        expect(referencedSites, `${relative} does not name ${site}`).toContain(
          site
        );
      }
    }
  );

  it("gives every declaring host a render guard that names it (ISS-10660)", () => {
    const declared = new Set(
      Object.values(SESSION_COUNT_SITE_DECLARING_MODULES).flat()
    );
    expect(Object.keys(SESSION_COUNT_SITE_RENDER_GUARDS).sort()).toStrictEqual(
      [...declared].sort()
    );
    for (const [host, guard] of Object.entries(
      SESSION_COUNT_SITE_RENDER_GUARDS
    )) {
      const absolute = path.join(REPO_ROOT, guard);
      expect(existsSync(absolute), `${guard} is missing`).toBe(true);
      // The guard asserts the registry row for its own host, by path, so a
      // guard cannot be pointed at a host it does not mount without its own
      // first case going red.
      expect(readFileSync(absolute, "utf8"), guard).toContain(`"${host}"`);
    }
  });

  /**
   * THE DECISION, EXECUTED. Every ordered pair runs through the production
   * `reconcileSessionCountSites` and is checked against the verdict the traced
   * populations imply.
   *
   * WHAT THIS IS NOT (review, 2026-09-18): it is not a repoint detector, of any
   * kind. The per-site case above asserts
   * `SESSION_COUNT_SITE_POPULATION[site] === population` for EVERY member, so a
   * repoint reddens there first and no repoint — class-merging, class-splitting
   * or partition-preserving — ever reaches this case. An earlier version of this
   * docblock claimed the merge/split half; it was unreachable when written.
   *
   * WHAT IT DOES PIN, which is why it stays: `reconcileSessionCountSites`
   * itself. The verdict is asserted to be DERIVED from population identity
   * rather than hand-declared per pair, and — because every ordered pair runs,
   * not just the upper triangle — to be symmetric. Both are properties of the
   * production function, and neither is observable from the binding assertion.
   */
  it("answers every site pair the way the traced populations say it must", () => {
    let reconciles = 0;
    let differs = 0;
    for (const left of ALL_SESSION_COUNT_SITES) {
      for (const right of ALL_SESSION_COUNT_SITES) {
        const samePopulation =
          expectedPopulationOf(left) === expectedPopulationOf(right);
        const expectedVerdict = samePopulation
          ? SESSION_COUNT_RECONCILIATION.Reconciles
          : SESSION_COUNT_RECONCILIATION.IntentionallyDiffers;
        expect(
          reconcileSessionCountSites(left, right),
          `${left} vs ${right}`
        ).toBe(expectedVerdict);
        if (samePopulation) {
          reconciles += 1;
        } else {
          differs += 1;
        }
      }
    }
    // Both directions really occur, so neither a constant yes nor a constant no
    // would satisfy this. Stated as exact literals rather than
    // `ALL_SESSION_COUNT_SITES.length` and `> 0`: that pair encoded "every site
    // has a population to itself", which was true only while the tile had its
    // own. ISS-10541 pointed the two tile sites at the two list populations, so
    // four sites now cover two populations — 16 ordered pairs split 8/8, the
    // four self-pairs plus each tile against the footer it sits above, in both
    // directions. A literal is what makes a future repoint that changes the
    // partition red here instead of silently satisfying a derived bound.
    expect(reconciles).toBe(8);
    expect(differs).toBe(8);
  });
});
