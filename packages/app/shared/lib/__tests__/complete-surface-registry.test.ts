/**
 * ISS-9395 — the registry checked against sources that are not the registry.
 *
 * Every expectation below is written out by hand. Nothing is derived from
 * `COMPLETE_SURFACE_REGISTRY`, because a test that maps over the registry and
 * asserts each entry equals itself cannot fail — the duplication would BE the
 * test, which is exactly the shape ISS-8636's differ was built to avoid.
 *
 * Two sources meet here: the registry's own classification and the
 * hand-written table in this file.
 *
 * The third source, the two maps the production shells navigate by, is checked
 * in `apps/desktop/src/renderer/navigation/__tests__/complete-surface-registry-reachability.test.ts`
 * (ISS-11433). One of those maps is the desktop route table, which this package
 * may not load (`packages-never-import-apps` in scripts/lint/layer-manifest.ts),
 * while the desktop app may load both.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SURFACE_OWNED_CONCERNS } from "../complete-surface-contract";
import {
  type AcceptedHostComposition,
  COMPLETE_SURFACE_REGISTRY,
  SurfaceMastery,
} from "../complete-surface-registry";
import { ShellNavigationRouteId } from "../shell-navigation-contract";
import {
  countOfMastery,
  exportedNames,
  hostPathsOfEntry,
  ownerOfEntry,
} from "./complete-surface-test-support";

const REPO_ROOT = path.join(process.cwd(), "..", "..");

/**
 * The classification each shell route should carry, written out one by one.
 * Deliberately every one of the twenty-two: a partial table would let a route
 * added later pass by being absent from the expectation rather than by being
 * correctly classified.
 */
const EXPECTED_MASTERY = {
  [ShellNavigationRouteId.Dashboard]: SurfaceMastery.Partial,
  [ShellNavigationRouteId.Sessions]: SurfaceMastery.Mastered,
  [ShellNavigationRouteId.Branches]: SurfaceMastery.Mastered,
  [ShellNavigationRouteId.Inbox]: SurfaceMastery.SingleHost,
  [ShellNavigationRouteId.MyIssues]: SurfaceMastery.IntentionallyExcluded,
  [ShellNavigationRouteId.Insights]: SurfaceMastery.Partial,
  [ShellNavigationRouteId.Approvals]: SurfaceMastery.SingleHost,
  [ShellNavigationRouteId.Requests]: SurfaceMastery.SingleHost,
  [ShellNavigationRouteId.Documents]: SurfaceMastery.Mastered,
  [ShellNavigationRouteId.Issues]: SurfaceMastery.Mastered,
  [ShellNavigationRouteId.Agents]: SurfaceMastery.Mastered,
  [ShellNavigationRouteId.MyTasks]: SurfaceMastery.SingleHost,
  [ShellNavigationRouteId.Packs]: SurfaceMastery.Partial,
  [ShellNavigationRouteId.LostWork]: SurfaceMastery.SingleHost,
  [ShellNavigationRouteId.TokenOpsWaste]: SurfaceMastery.SingleHost,
  [ShellNavigationRouteId.Judges]: SurfaceMastery.SingleHost,
  [ShellNavigationRouteId.Plans]: SurfaceMastery.SingleHost,
  [ShellNavigationRouteId.Diagnostics]: SurfaceMastery.Mastered,
  [ShellNavigationRouteId.Settings]: SurfaceMastery.Partial,
  [ShellNavigationRouteId.Help]: SurfaceMastery.Mastered,
} as const satisfies Record<ShellNavigationRouteId, SurfaceMastery>;

/**
 * ISS-9395 AC5 — the totals the terminal validator (ISS-9415) reads. Counted by
 * hand off the table above, not summed from the registry, so a miscount in
 * either place shows up as a disagreement instead of agreeing with itself.
 */
const EXPECTED_SHELL_ROUTE_COUNT = 20;
const EXPECTED_MASTERED = 7;
const EXPECTED_PARTIAL = 4;
const EXPECTED_SINGLE_HOST = 8;
const EXPECTED_INTENTIONALLY_EXCLUDED = 1;
const EXPECTED_UNDECIDED = 0;

const EXPECTED_ACCEPTED_HOST_COMPOSITION = {
  [ShellNavigationRouteId.Sessions]: [],
  // ISS-10301: empty since the v1 Branches arm this allowance covered was
  // retired. Both hosts now compose the surface alone.
  [ShellNavigationRouteId.Branches]: [],
  [ShellNavigationRouteId.Agents]: [],
} as const;

const ISSUE_OWNER_PREFIX = "ISS-";

describe("complete-surface registry classification", () => {
  it("classifies every shell route as the hand-written table says", () => {
    for (const [routeId, expected] of Object.entries(EXPECTED_MASTERY)) {
      expect(
        COMPLETE_SURFACE_REGISTRY[routeId as ShellNavigationRouteId].mastery,
        `route "${routeId}"`
      ).toBe(expected);
    }
  });

  it("covers exactly the twenty shell route identities", () => {
    expect(Object.keys(COMPLETE_SURFACE_REGISTRY)).toHaveLength(
      EXPECTED_SHELL_ROUTE_COUNT
    );
    expect(Object.values(ShellNavigationRouteId).sort()).toEqual(
      Object.keys(COMPLETE_SURFACE_REGISTRY).sort()
    );
  });

  it("reports the classification totals ISS-9415 consumes", () => {
    expect(
      countOfMastery(
        Object.values(COMPLETE_SURFACE_REGISTRY),
        SurfaceMastery.Mastered
      )
    ).toBe(EXPECTED_MASTERED);
    expect(
      countOfMastery(
        Object.values(COMPLETE_SURFACE_REGISTRY),
        SurfaceMastery.Partial
      )
    ).toBe(EXPECTED_PARTIAL);
    expect(
      countOfMastery(
        Object.values(COMPLETE_SURFACE_REGISTRY),
        SurfaceMastery.SingleHost
      )
    ).toBe(EXPECTED_SINGLE_HOST);
    expect(
      countOfMastery(
        Object.values(COMPLETE_SURFACE_REGISTRY),
        SurfaceMastery.IntentionallyExcluded
      )
    ).toBe(EXPECTED_INTENTIONALLY_EXCLUDED);
    expect(
      countOfMastery(
        Object.values(COMPLETE_SURFACE_REGISTRY),
        SurfaceMastery.Undecided
      )
    ).toBe(EXPECTED_UNDECIDED);
  });
});

describe("mastered surface host composition exceptions", () => {
  it("records the hand-written accepted host-composed surface concerns", () => {
    for (const [routeId, expected] of Object.entries(
      EXPECTED_ACCEPTED_HOST_COMPOSITION
    )) {
      const entry =
        COMPLETE_SURFACE_REGISTRY[routeId as ShellNavigationRouteId];
      expect(entry.mastery, `route "${routeId}"`).toBe(SurfaceMastery.Mastered);
      if (entry.mastery !== SurfaceMastery.Mastered) {
        continue;
      }
      const acceptedHostComposition: readonly AcceptedHostComposition[] =
        "acceptedHostComposition" in entry
          ? ((entry.acceptedHostComposition ??
              []) as readonly AcceptedHostComposition[])
          : [];
      expect(acceptedHostComposition ?? [], routeId).toStrictEqual(expected);
    }
  });

  it("requires every accepted host-composed concern to be typed and issue-owned", () => {
    for (const entry of Object.values(COMPLETE_SURFACE_REGISTRY)) {
      if (entry.mastery !== SurfaceMastery.Mastered) {
        continue;
      }
      const acceptedHostComposition: readonly AcceptedHostComposition[] =
        "acceptedHostComposition" in entry
          ? ((entry.acceptedHostComposition ??
              []) as readonly AcceptedHostComposition[])
          : [];
      for (const row of acceptedHostComposition) {
        expect(SURFACE_OWNED_CONCERNS).toContain(row.concern);
        expect(row.module.length, row.owner).toBeGreaterThan(0);
        expect(Number.isSafeInteger(row.maxReferences), row.owner).toBe(true);
        expect(row.maxReferences, row.owner).toBeGreaterThan(0);
        expect(row.owner.startsWith(ISSUE_OWNER_PREFIX), row.owner).toBe(true);
      }
    }
  });
});

/**
 * A registry of paths is worth nothing if the paths are stale. These read the
 * filesystem, so a host that is renamed or an owner that is moved fails here
 * rather than leaving the source guard silently auditing nothing.
 */
describe("registry paths resolve on disk", () => {
  it("names an owner module that exists and exports that component", () => {
    for (const id of Object.values(ShellNavigationRouteId)) {
      const owner = ownerOfEntry(COMPLETE_SURFACE_REGISTRY[id]);
      if (owner === undefined) {
        continue;
      }
      const absolute = path.join(REPO_ROOT, owner.module);
      expect(existsSync(absolute), `${id}: ${owner.module}`).toBe(true);
      expect(exportedNames(absolute), `${id}: ${owner.module}`).toContain(
        owner.exportName
      );
    }
  });

  it("names host paths that exist", () => {
    for (const id of Object.values(ShellNavigationRouteId)) {
      for (const host of hostPathsOfEntry(COMPLETE_SURFACE_REGISTRY[id])) {
        expect(existsSync(path.join(REPO_ROOT, host)), `${id}: ${host}`).toBe(
          true
        );
      }
    }
  });
});
