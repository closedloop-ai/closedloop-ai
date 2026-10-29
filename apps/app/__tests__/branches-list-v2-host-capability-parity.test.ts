/**
 * ISS-7053 — Branches Grid Table v2 host capability parity.
 *
 * Sessions lost live affordances during its v2 mount because optional props in
 * the new host diverged from the old surface. Branches has only two production
 * v2 hosts, web and desktop; this ledger classifies every optional prop the v2
 * surface declares so a newly declared capability cannot disappear silently.
 *
 * ISS-9218 — what each prop IS comes from
 * {@link BRANCHES_LIST_SURFACE_V2_CAPABILITY_KINDS}, beside the surface's own
 * props, so a `presentation` prop cannot be `notSupported`-ed away here and a
 * new optional prop fails `tsc` until someone decides which it is.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { BRANCHES_LIST_SURFACE_V2_CAPABILITY_KINDS } from "@repo/app/branches/components/branches-list-surface-v2-capability-kinds";
import { describe, expect, it } from "vitest";
import { propsPassedToImported } from "./support/jsx-mount-props";
import {
  capabilityDrift,
  declaredOptionalProps,
  type HostCapabilityLedger,
  productionMountsOf,
  SUPPLIED,
  unledgeredMounts,
} from "./support/surface-capability-parity";

const REPO_ROOT = path.join(process.cwd(), "..", "..");
const SEARCH_ROOTS = ["apps", "packages"];
const REPO_WALK_TIMEOUT_MS = 60_000;

const ROUTE_LINKS =
  "This host uses getBranchHref, so a custom renderBranchLink seam would duplicate the link path.";
/**
 * ISS-9218 re-audit: the reason was an approval record, which states who signed
 * it off but not what the host lacks. Both shells lack the same thing.
 */
const NO_SCROLL_RESTORE =
  "Neither Branches shell restores a list scroll position — there is no history-scroll observer behind this table on either — so the ref would be handed to nothing. PLN-1883/Daveth approved shipping ISS-7053 without one.";

const WEB_NO_GITHUB_CONNECT =
  "The summary strip's Connect-to-GitHub ask is Desktop-only by operator ruling on ISS-12638; the web page passes no githubConnect target.";

const WEB_LEDGER: HostCapabilityLedger = {
  componentModule: "@repo/app/branches/components/branches-list-surface-v2",
  componentName: "BranchesListSurfaceV2",
  componentPath:
    "packages/app/branches/components/branches-list-surface-v2.tsx",
  hostPath: "apps/app/app/(authenticated)/[orgSlug]/branches/page.tsx",
  kinds: BRANCHES_LIST_SURFACE_V2_CAPABILITY_KINDS,
  capabilities: {
    bulkActions: SUPPLIED,
    className: SUPPLIED,
    collapsedGroups: SUPPLIED,
    columnOrder: SUPPLIED,
    columnWidths: SUPPLIED,
    // ISS-12663: the host's custom-field controller.
    customFields: SUPPLIED,
    getBranchHref: SUPPLIED,
    getSessionHref: SUPPLIED,
    getSessionsHref: SUPPLIED,
    grouping: SUPPLIED,
    hasCompletePopulation: SUPPLIED,
    historyListTestId: SUPPLIED,
    includePriorityColumn: SUPPLIED,
    // ISS-12456: web's source is always the HTTP one, which always serves project.
    includeProjectColumn: SUPPLIED,
    // ISS-12456: web's source is always the HTTP one, which always serves tags.
    includeTagsColumn: SUPPLIED,
    // ISS-12638: the GitHub connect ask on the summary strip is a Desktop-only operator ruling.
    githubConnect: { notSupported: WEB_NO_GITHUB_CONNECT },
    githubConnectOutcome: { notSupported: WEB_NO_GITHUB_CONNECT },
    githubReturnStatus: SUPPLIED,
    onColumnOrderChange: SUPPLIED,
    onColumnWidthChange: SUPPLIED,
    onCollapsedGroupsChange: SUPPLIED,
    onGroupingChange: SUPPLIED,
    renderBranchLink: { notSupported: ROUTE_LINKS },
    renderBranchStatus: { inertUnder: "getBranchHref" },
    stallCta: SUPPLIED,
    stallPhase: SUPPLIED,
    tableScrollAttributes: SUPPLIED,
    tableScrollRef: { notSupported: NO_SCROLL_RESTORE },
    tableScrollTestId: SUPPLIED,
    tagsReadOnly: {
      notSupported:
        "Web tag editability is resolved from row permissions, not from the desktop offline state.",
    },
    // ISS-10544: the graduated constant, since web draws the mark with no key.
    trendSparkline: SUPPLIED,
  },
};

const DESKTOP_LEDGER: HostCapabilityLedger = {
  componentModule: "@repo/app/branches/components/branches-list-surface-v2",
  componentName: "BranchesListSurfaceV2",
  componentPath:
    "packages/app/branches/components/branches-list-surface-v2.tsx",
  hostPath: "apps/desktop/src/renderer/components/branches/branches-view.tsx",
  kinds: BRANCHES_LIST_SURFACE_V2_CAPABILITY_KINDS,
  capabilities: {
    bulkActions: SUPPLIED,
    className: SUPPLIED,
    collapsedGroups: SUPPLIED,
    columnOrder: SUPPLIED,
    columnWidths: SUPPLIED,
    // ISS-12663: the host's custom-field controller.
    customFields: SUPPLIED,
    getBranchHref: SUPPLIED,
    getSessionHref: SUPPLIED,
    getSessionsHref: SUPPLIED,
    grouping: SUPPLIED,
    hasCompletePopulation: SUPPLIED,
    historyListTestId: SUPPLIED,
    // ISS-10332: supplied as the source's `updatePriority` presence.
    includePriorityColumn: SUPPLIED,
    // ISS-12456: supplied as the source's `supportsProject` presence.
    includeProjectColumn: SUPPLIED,
    // ISS-12456: supplied as the source's `supportsTags` presence.
    includeTagsColumn: SUPPLIED,
    githubConnect: SUPPLIED,
    githubConnectOutcome: SUPPLIED,
    githubReturnStatus: {
      notSupported:
        "Desktop's connect handoff is an IPC leg with no browser OAuth return, so there is no query status to report. Desktop's asks — the stalled-load slot's (ISS-10645) and the summary strip's (ISS-12638) — report their outcome through `DesktopConnectStatus` in this renderer rather than a return query.",
    },
    onColumnOrderChange: SUPPLIED,
    onColumnWidthChange: SUPPLIED,
    onCollapsedGroupsChange: SUPPLIED,
    onGroupingChange: SUPPLIED,
    renderBranchLink: { notSupported: ROUTE_LINKS },
    renderBranchStatus: { inertUnder: "getBranchHref" },
    stallCta: SUPPLIED,
    stallPhase: SUPPLIED,
    tableScrollAttributes: SUPPLIED,
    tableScrollRef: { notSupported: NO_SCROLL_RESTORE },
    tableScrollTestId: SUPPLIED,
    tagsReadOnly: SUPPLIED,
    // ISS-10544: this shell's own flag read, which still gates the mark here.
    trendSparkline: SUPPLIED,
  },
};

const LEDGERS = [WEB_LEDGER, DESKTOP_LEDGER];

describe.each(LEDGERS)(
  "$hostPath BranchesListSurfaceV2 capabilities",
  (ledger) => {
    const declaredOptional = declaredOptionalProps(
      readFileSync(path.join(REPO_ROOT, ledger.componentPath), "utf8"),
      ledger.componentName,
      path.join(REPO_ROOT, ledger.componentPath)
    );
    const supplied = propsPassedToImported(
      readFileSync(path.join(REPO_ROOT, ledger.hostPath), "utf8"),
      ledger.componentModule,
      ledger.componentName
    );

    it("classifies every optional capability, and every claim matches the JSX", () => {
      expect(
        capabilityDrift({ declaredOptional, ledger, supplied })
      ).toStrictEqual([]);
    });

    it("reads a non-empty capability set from both sources", () => {
      expect(declaredOptional.size).toBeGreaterThan(0);
      expect(supplied.size).toBeGreaterThan(0);
      expect(Object.keys(ledger.capabilities)).toHaveLength(
        declaredOptional.size
      );
      // ISS-9218: the kind map is `satisfies`-bound to the prop TYPE; this reads
      // the same props off the AST. A prop reaching this ledger with no kind would
      // keep the old, unrestricted escape hatch.
      expect(Object.keys(ledger.kinds)).toHaveLength(declaredOptional.size);
    });
  }
);

describe("BranchesListSurfaceV2 production mounts", () => {
  it(
    "has a ledger for every production module that mounts it",
    () => {
      const mounts = productionMountsOf({
        exportName: "BranchesListSurfaceV2",
        moduleSuffix: "branches-list-surface-v2",
        repoRoot: REPO_ROOT,
        searchRoots: SEARCH_ROOTS,
      });

      expect(
        unledgeredMounts({
          componentName: "BranchesListSurfaceV2",
          ledgers: LEDGERS,
          mounts,
        })
      ).toStrictEqual([]);
      expect(mounts).toStrictEqual([
        "apps/app/app/(authenticated)/[orgSlug]/branches/page.tsx",
        "apps/desktop/src/renderer/components/branches/branches-view.tsx",
      ]);
    },
    REPO_WALK_TIMEOUT_MS
  );
});
