/**
 * ISS-9223 — a surface that stops wiring a `GridTableV2` capability fails HERE
 * instead of quietly rendering one table's affordance and not another's.
 *
 * The host↔surface guard (ISS-8636, narrowed by ISS-9218) runs on every PR and
 * classifies ONE seam: what a shell passes to a list surface. All three of its
 * kind maps are surface-prop maps, so nothing read `GridTableV2`'s own prop set
 * across its callers, and a capability the Sessions grid passed while the
 * Branches list did not stayed invisible — the exact class of defect ISS-9223
 * was an instance of. PR #6671 recorded that gap as "left to ISS-9218"; that
 * ticket's PR had already merged eight hours earlier, scoped to host↔surface,
 * and its own escape hatch — a linked follow-up — was never exercised.
 *
 * The check is worth something because its four inputs are four DIFFERENT
 * sources, exactly as the seam above: the primitive's own source for what is
 * optional, each surface's JSX for what it passes, a hand-written ledger for
 * what it claims, and the `satisfies`-bound kind map for what a surface is even
 * allowed to claim. A check that read the prop type and compared it to itself
 * could not fail.
 *
 * What this seam needed that the one above did not:
 * - SPREADS. Both list surfaces spread into the mount — Branches builds one
 *   `gridProps` and mounts twice off it, Sessions picks between named prop
 *   shapes per gate — and the differ used to refuse every spread outright.
 * - `gatedOn`. Branches passes `pinLeadColumn` on one of those two mounts,
 *   behind its own live flag. `notSupported` would claim an inability that does
 *   not exist and an inert claim needs a companion, so the honest answer is a
 *   third, checked one: the JSX must show the split and the module must still
 *   reference the gate.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { PRODUCT_GRID_FAVORITE_SUPPLIED_PROPS } from "@repo/app/shared/lib/product-grid-favorites";
import { describe, expect, it } from "vitest";
import {
  BRANCHES_GRID_LEDGER,
  GRID_TABLE_V2_COMPONENT_MODULE,
  GRID_TABLE_V2_COMPONENT_NAME,
  GRID_TABLE_V2_COMPONENT_PATH,
  GRID_TABLE_V2_SURFACE_LEDGERS,
  PRODUCT_GRID_TABLE_V2_COMPONENT_NAME,
  PRODUCT_GRID_TABLE_V2_COMPONENT_PATH,
  SESSIONS_GRID_LEDGER,
} from "./support/grid-table-v2-surface-ledgers";
import { propsPassedToImported } from "./support/jsx-mount-props";
import {
  RESPONSIVE_NARROW_GRIDVIEW_AUDIT_LEDGER,
  RESPONSIVE_NARROW_GRIDVIEW_INFORMATION_RULES,
} from "./support/responsive-narrow-gridview-ledgers";
import {
  gatedClaimProblem,
  moduleReferencesIdentifier,
} from "./support/surface-capability-gate";
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
/** The walk across `apps` + `packages` is cached, but the first one pays it. */
const REPO_WALK_TIMEOUT_MS = 60_000;
const COMPONENT_FILE = path.join(REPO_ROOT, GRID_TABLE_V2_COMPONENT_PATH);

const DECLARED_OPTIONAL = declaredOptionalProps(
  readFileSync(COMPONENT_FILE, "utf8"),
  GRID_TABLE_V2_COMPONENT_NAME,
  COMPONENT_FILE
);

describe("PRD-727 tracked child evidence", () => {
  it("maps the ISS-9377 audit to stable, non-duplicated owners and evidence", () => {
    const ids = RESPONSIVE_NARROW_GRIDVIEW_AUDIT_LEDGER.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(RESPONSIVE_NARROW_GRIDVIEW_AUDIT_LEDGER).toHaveLength(8);
    expect(
      new Set(RESPONSIVE_NARROW_GRIDVIEW_AUDIT_LEDGER.map((row) => row.kind))
    ).toEqual(
      new Set(["adapter", "champion", "data-dependency", "defect", "non-goal"])
    );
    expect(RESPONSIVE_NARROW_GRIDVIEW_AUDIT_LEDGER).toStrictEqual([
      {
        behavior: "Viewport-based one-column Name projection",
        disposition: "adopted",
        evidence:
          "Shared header, row, group, tree, focus, and ARIA render path",
        id: "RNG-AUDIT-001",
        kind: "champion",
        owner: "GridTableV2",
        paths: ["packages/design-system/components/ui/grid-table-v2.tsx"],
      },
      {
        behavior: "Sessions row mapping, status, tags, Favorite, and actions",
        disposition: "adopted",
        evidence:
          "Domain renderLead/renderCell and product compatibility adapter",
        id: "RNG-AUDIT-002",
        kind: "adapter",
        owner: "SessionsListSurfaceV2",
        paths: [
          "packages/app/agents/components/sessions/sessions-list-surface-v2.tsx",
        ],
      },
      {
        behavior: "Branches row mapping, syncing precedence, tags, and actions",
        disposition: "adopted",
        evidence: "Approved Branches grid adapter",
        id: "RNG-AUDIT-003",
        kind: "adapter",
        owner: "BranchesGridV2",
        paths: ["packages/app/branches/components/branches-grid-v2.tsx"],
      },
      {
        behavior:
          "Documents, project, and Generic Artifact production adoption",
        disposition: "adopted",
        evidence:
          "ProductGridTableV2 callers and default-off compatibility adapters",
        id: "RNG-AUDIT-004",
        kind: "adapter",
        owner: "Product grid callers",
        paths: [
          "packages/app/documents/components/table/document-row.tsx",
          "packages/app/shared/components/product-grid-table-v2.tsx",
        ],
      },
      {
        behavior: "Closed-by-default web and Desktop rollout",
        disposition: "preserved",
        evidence: "One PostHog key plus viewport media query",
        id: "RNG-AUDIT-005",
        kind: "data-dependency",
        owner: "Responsive narrow Gridview feature-flag adapter",
        paths: [
          "packages/app/shared/feature-flags/use-responsive-narrow-gridview.ts",
        ],
      },
      {
        behavior:
          "Documents must not re-enter container-width cards while flag on",
        disposition: "defect-fixed",
        evidence: "DocumentRow flag-on veto plus production routing coverage",
        id: "RNG-AUDIT-006",
        kind: "defect",
        owner: "DocumentRow",
        paths: ["packages/app/documents/components/table/document-row.tsx"],
      },
      {
        behavior: "Explicit Board/Card view",
        disposition: "unchanged-non-goal",
        evidence: "Separate PRD-724 surface, never the responsive fallback",
        id: "RNG-AUDIT-007",
        kind: "non-goal",
        owner: "Board/Card surfaces",
        paths: ["packages/app/documents/components/table/table-view-menu.tsx"],
      },
      {
        behavior: "Selection reconciliation and toolbar model",
        disposition: "unchanged-non-goal",
        evidence: "Owned by #8900 and #8922 respectively",
        id: "RNG-AUDIT-008",
        kind: "non-goal",
        owner: "Adjacent active work",
        paths: [
          "packages/design-system/components/ui/table-bulk-action-bar.tsx",
          "packages/design-system/components/ui/grid-table-toolbar.tsx",
        ],
      },
    ]);
    expect(
      RESPONSIVE_NARROW_GRIDVIEW_AUDIT_LEDGER.every(
        (row) =>
          row.owner.length > 0 &&
          row.evidence.length > 0 &&
          row.paths.length > 0 &&
          row.paths.every((repoPath) =>
            existsSync(path.join(REPO_ROOT, repoPath))
          )
      )
    ).toBe(true);
  });

  it("keeps the ISS-9520 narrow information rules paired with wide behavior", () => {
    const ids = RESPONSIVE_NARROW_GRIDVIEW_INFORMATION_RULES.map(
      (row) => row.id
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(RESPONSIVE_NARROW_GRIDVIEW_INFORMATION_RULES).toHaveLength(8);
    expect(RESPONSIVE_NARROW_GRIDVIEW_INFORMATION_RULES).toStrictEqual([
      {
        disposition: "adopted",
        id: "RNG-INFO-001",
        narrow: "Only the Name column header remains",
        owner: "GridTableV2 header",
        paths: ["packages/design-system/components/ui/grid-table-v2.tsx"],
        wide: "Every configured visible column remains",
      },
      {
        disposition: "adopted",
        id: "RNG-INFO-002",
        narrow: "Status icon precedes the ellipsized title",
        owner: "Domain lead adapters",
        paths: [
          "packages/app/agents/components/sessions/session-name-lead-cell.tsx",
          "packages/app/branches/components/approved-branches-grid-adapter.tsx",
        ],
        wide: "Existing status and title cells remain",
      },
      {
        disposition: "preserved",
        id: "RNG-INFO-003",
        narrow: "Group header spans the one-column row",
        owner: "Shared group renderer",
        paths: [
          "packages/design-system/components/ui/group-section-header.tsx",
        ],
        wide: "Group header spans the complete grid",
      },
      {
        disposition: "preserved",
        id: "RNG-INFO-004",
        narrow: "Tree disclosure and level remain on the Name row",
        owner: "Shared row renderer",
        paths: ["packages/design-system/components/ui/grid-table-v2-row.tsx"],
        wide: "Tree disclosure and level remain on the identity column",
      },
      {
        disposition: "preserved",
        id: "RNG-INFO-005",
        narrow: "Favorite and More remain reachable at the trailing edge",
        owner: "Domain utility/action adapters",
        paths: ["packages/design-system/components/ui/grid-table-v2-row.tsx"],
        wide: "Existing utility and action columns remain",
      },
      {
        disposition: "unchanged-non-goal",
        id: "RNG-INFO-006",
        narrow: "Tags are not shown in the narrow row (ISS-12959)",
        owner: "Wide Tags column",
        paths: [
          "packages/app/agents/components/sessions/sessions-list-grid-v2.tsx",
          "packages/app/branches/components/branches-grid-v2.tsx",
        ],
        wide: "Tags remain in their configured data column",
      },
      {
        disposition: "preserved",
        id: "RNG-INFO-007",
        narrow: "Select-all remains in the single header",
        owner: "Shared header selection control",
        paths: ["packages/design-system/components/ui/grid-table-v2.tsx"],
        wide: "Select-all remains in the identity header",
      },
      {
        disposition: "preserved",
        id: "RNG-INFO-008",
        narrow: "After-row and inline-create content uses the single track",
        owner: "Shared after-row renderer",
        paths: ["packages/design-system/lib/grid-table-v2-after-row.ts"],
        wide: "After-row content uses the complete track template",
      },
    ]);
    expect(
      RESPONSIVE_NARROW_GRIDVIEW_INFORMATION_RULES.every(
        (row) =>
          row.narrow.length > 0 &&
          row.wide.length > 0 &&
          row.paths.length > 0 &&
          row.paths.every((repoPath) =>
            existsSync(path.join(REPO_ROOT, repoPath))
          )
      )
    ).toBe(true);
  });
});

describe.each(GRID_TABLE_V2_SURFACE_LEDGERS)(
  "$hostPath → GridTableV2 parity",
  (ledger: HostCapabilityLedger) => {
    const hostCode = readFileSync(
      path.join(REPO_ROOT, ledger.hostPath),
      "utf8"
    );
    const supplied = suppliedProps(hostCode, ledger);

    it("classifies every optional capability, and every claim matches the JSX", () => {
      expect(
        capabilityDrift({
          declaredOptional: DECLARED_OPTIONAL,
          hostCode,
          ledger,
          supplied,
        })
      ).toStrictEqual([]);
    });

    // A ledger that drifted to empty, or a reader that returned nothing, would
    // satisfy the check above forever.
    it("reads a non-empty capability set from every source", () => {
      expect(DECLARED_OPTIONAL.size).toBeGreaterThan(0);
      expect(supplied.size).toBeGreaterThan(0);
      expect(Object.keys(ledger.capabilities)).toHaveLength(
        DECLARED_OPTIONAL.size
      );
      expect(Object.keys(ledger.kinds)).toHaveLength(DECLARED_OPTIONAL.size);
    });
  }
);

// Without this the audited set would be the array above, and a NEW surface that
// mounted the grid would be unguarded from birth — the same silence one level
// up, which is what this ticket is about.
describe("GridTableV2 production mounts", () => {
  it(
    "has a ledger for every direct or rollout-bound production mount",
    () => {
      const directMounts = productionMountsOf({
        exportName: GRID_TABLE_V2_COMPONENT_NAME,
        moduleSuffix: path.basename(GRID_TABLE_V2_COMPONENT_PATH, ".tsx"),
        repoRoot: REPO_ROOT,
        searchRoots: SEARCH_ROOTS,
      });
      const rolloutMounts = productionMountsOf({
        exportName: PRODUCT_GRID_TABLE_V2_COMPONENT_NAME,
        moduleSuffix: path.basename(
          PRODUCT_GRID_TABLE_V2_COMPONENT_PATH,
          ".tsx"
        ),
        repoRoot: REPO_ROOT,
        searchRoots: SEARCH_ROOTS,
      });
      const directLeafMounts = directMounts.filter(
        (mount) => mount !== PRODUCT_GRID_TABLE_V2_COMPONENT_PATH
      );
      expect(
        unledgeredMounts({
          componentName: GRID_TABLE_V2_COMPONENT_NAME,
          ledgers: GRID_TABLE_V2_SURFACE_LEDGERS,
          mounts: directLeafMounts,
        })
      ).toStrictEqual([]);
      expect(
        unledgeredMounts({
          componentName: PRODUCT_GRID_TABLE_V2_COMPONENT_NAME,
          ledgers: GRID_TABLE_V2_SURFACE_LEDGERS,
          mounts: rolloutMounts,
        })
      ).toStrictEqual([]);
      expect(directMounts).toContain(PRODUCT_GRID_TABLE_V2_COMPONENT_PATH);
      // Not vacuous: discovery that found nothing would report no gap forever.
      expect(directLeafMounts.length).toBeGreaterThan(0);
      expect(rolloutMounts.length).toBeGreaterThan(0);
    },
    REPO_WALK_TIMEOUT_MS
  );
});

/**
 * The defect class this seam exists for, kept executable: a capability ONE
 * surface passes and another silently does not.
 *
 * Driven off what the Sessions grid really wires rather than a fixed prop name,
 * so it cannot rot the way a counterfactual pinned to `pageSizeOptions` did one
 * level up. Every capability Sessions supplies has to redden when a sibling
 * ledger claims it while its own JSX withholds it.
 */
describe("the divergence this seam was blind to", () => {
  const branchesCode = readFileSync(
    path.join(REPO_ROOT, BRANCHES_GRID_LEDGER.hostPath),
    "utf8"
  );
  const branchesSupplied = suppliedProps(branchesCode, BRANCHES_GRID_LEDGER);
  const onlyOnSessions = Object.keys(SESSIONS_GRID_LEDGER.capabilities)
    .filter((prop) => SESSIONS_GRID_LEDGER.capabilities[prop] === SUPPLIED)
    .filter((prop) => !branchesSupplied.has(prop))
    .sort();

  it("has capabilities one surface wires and the other does not", () => {
    expect(onlyOnSessions.length).toBeGreaterThan(0);
  });

  it.each(onlyOnSessions)(
    'reddens when Branches claims "%s" it does not pass',
    (prop) => {
      const claimed: HostCapabilityLedger = {
        ...BRANCHES_GRID_LEDGER,
        capabilities: {
          ...BRANCHES_GRID_LEDGER.capabilities,
          [prop]: SUPPLIED,
        },
      };
      const problems = capabilityDrift({
        declaredOptional: DECLARED_OPTIONAL,
        hostCode: branchesCode,
        ledger: claimed,
        supplied: branchesSupplied,
      });
      // Everything reported has to be ABOUT this capability — a mutation that
      // reddened the whole ledger would satisfy a bare "contains something"
      // assertion. Not pinned to one problem: claiming a capability another
      // entry declares itself inert without correctly expires that claim too,
      // and both messages name this prop. The remedy half of the sentence is
      // deliberately not pinned — it varies by capability KIND, and asserting it
      // would make this read its expectation off the map it is policing.
      expect(
        problems.filter((problem) => !problem.includes(`"${prop}"`))
      ).toStrictEqual([]);
      expect(problems.join("\n")).toContain(
        `${claimed.hostPath}: capability "${prop}" is classified supplied but this host does not pass it to ${claimed.componentName}, so the affordance never renders.`
      );
    }
  );
});

/**
 * The `gatedOn` hatch, proven to be a CHECK rather than a sentence. Each
 * mutation is a way the claim could stop being true, and each has to redden.
 */
describe("the gated claim", () => {
  const branchesCode = readFileSync(
    path.join(REPO_ROOT, BRANCHES_GRID_LEDGER.hostPath),
    "utf8"
  );
  const branchesSupplied = suppliedProps(branchesCode, BRANCHES_GRID_LEDGER);
  const GATED_PROP = "pinLeadColumn";

  const driftWith = (
    capabilities: HostCapabilityLedger["capabilities"],
    hostCode: string | undefined
  ) =>
    capabilityDrift({
      declaredOptional: DECLARED_OPTIONAL,
      hostCode,
      ledger: { ...BRANCHES_GRID_LEDGER, capabilities },
      supplied: branchesSupplied,
    });

  it("accepts the split the Branches surface really has", () => {
    expect(
      driftWith(BRANCHES_GRID_LEDGER.capabilities, branchesCode)
    ).toStrictEqual([]);
  });

  it("refuses a gated claim with no host source to check it against", () => {
    expect(driftWith(BRANCHES_GRID_LEDGER.capabilities, undefined)).toContain(
      `${BRANCHES_GRID_LEDGER.hostPath}: capability "${GATED_PROP}" is declared gated on "${GATE}", but this check was given no host source to verify that against. A gated claim is only a claim; pass the host's code so the split can be read.`
    );
  });

  it("refuses a gated claim over a capability NO mount passes", () => {
    expect(
      driftWith(
        {
          ...BRANCHES_GRID_LEDGER.capabilities,
          renderAfterItem: { gatedOn: GATE },
        },
        branchesCode
      )
    ).toContain(
      `${BRANCHES_GRID_LEDGER.hostPath}: capability "renderAfterItem" is declared gated on "${GATE}", but NO mount in this module passes it, so nothing here is gated — the capability is simply absent. Pass it on the open branch, or classify it as the omission it is.`
    );
  });

  it("refuses a gate the module no longer references", () => {
    expect(
      driftWith(
        {
          ...BRANCHES_GRID_LEDGER.capabilities,
          [GATED_PROP]: { gatedOn: RETIRED_GATE },
        },
        branchesCode
      )
    ).toContain(gateNotReadProblem(RETIRED_GATE));
  });

  // The case a bare "is this identifier mentioned anywhere" check would pass
  // (review-soul, this PR). The fixture names a SECOND live gate this module
  // really reads — the one that picks how the column layout is derived, which
  // decides nothing about the pin — so only a check that reads the DECIDING
  // CONDITION can tell it apart from the real gate. Two flags in one module is
  // the hardest case for that distinction, and the one it now covers.
  it("refuses a real identifier that does not decide the split", () => {
    expect(
      driftWith(
        {
          ...BRANCHES_GRID_LEDGER.capabilities,
          [GATED_PROP]: { gatedOn: UNRELATED_BUT_PRESENT_IDENTIFIER },
        },
        branchesCode
      )
    ).toContain(gateNotReadProblem(UNRELATED_BUT_PRESENT_IDENTIFIER));
  });

  // Proves the case above is not passing merely because the name is absent.
  //
  // Read off the AST rather than with a `toContain` over the source (whitlockk
  // review): scanning implementation text is what `no-raw-text-source-scan`
  // bans, and this file reaches its host through a dynamic path that gate
  // cannot see, so the ban held here only by convention. The AST read is also
  // the stricter claim — a substring would be satisfied by a prose mention in a
  // docstring or by a longer identifier that merely contains this name, and
  // neither is a reference the gate's own condition walk could follow.
  it("confirms the unrelated identifier really is referenced by the module", () => {
    expect(
      moduleReferencesIdentifier(branchesCode, UNRELATED_BUT_PRESENT_IDENTIFIER)
    ).toBe(true);
  });

  // Not vacuous: the same read has to answer false for a name this module does
  // not bind, or an `identifiersIn` that returned everything would vouch for
  // anything.
  it("answers false for an identifier the module never binds", () => {
    expect(moduleReferencesIdentifier(branchesCode, ABSENT_IDENTIFIER)).toBe(
      false
    );
  });

  function gateNotReadProblem(gate: string): string {
    return `${BRANCHES_GRID_LEDGER.hostPath}: capability "${GATED_PROP}" is declared gated on "${gate}", which is not read by the condition that actually decides whether this capability is passed. Name the gate that condition reads, or classify the capability as supplied now that nothing withholds it.`;
  }
});

/**
 * davetho review — a host with a SECOND, independent `GridTableV2` split.
 *
 * `decidingCondition` used to return after the first split the walk reached, so
 * a ledger naming the first gate stayed green while a whole other mount pair
 * withheld the same capability behind a condition nothing checked. Both halves
 * are proven below: the two-gate host must redden, and the same shape with ONE
 * gate deciding both splits must still be accepted, so the fix is not merely
 * "reject anything with two splits".
 */
function twoSplitHost(secondGate: string): string {
  return `
import { ${GRID_TABLE_V2_COMPONENT_NAME} } from "${GRID_TABLE_V2_COMPONENT_MODULE}";

export function FirstTable({ items }) {
  const pinFirst = useFeatureFlagEnabledOptional(${GATE});
  return pinFirst ? (
    <${GRID_TABLE_V2_COMPONENT_NAME} items={items} pinLeadColumn />
  ) : (
    <${GRID_TABLE_V2_COMPONENT_NAME} items={items} />
  );
}

export function SecondTable({ items }) {
  const pinSecond = useFeatureFlagEnabledOptional(${secondGate});
  return pinSecond ? (
    <${GRID_TABLE_V2_COMPONENT_NAME} items={items} pinLeadColumn />
  ) : (
    <${GRID_TABLE_V2_COMPONENT_NAME} items={items} />
  );
}
`;
}

describe("a host with two independent splits", () => {
  const problemFor = (hostCode: string) =>
    gatedClaimProblem({
      exportName: GRID_TABLE_V2_COMPONENT_NAME,
      gate: GATE,
      hostCode,
      moduleSpecifier: GRID_TABLE_V2_COMPONENT_MODULE,
      prop: "pinLeadColumn",
      suppliedOnAnyMount: new Set(["pinLeadColumn"]),
    });

  it("refuses a gate that decides only the first of them", () => {
    expect(problemFor(twoSplitHost(UNRELATED_BUT_PRESENT_IDENTIFIER))).toBe(
      `is declared gated on "${GATE}", which is not read by the condition that actually decides whether this capability is passed. Name the gate that condition reads, or classify the capability as supplied now that nothing withholds it.`
    );
  });

  it("accepts a gate that decides both of them", () => {
    expect(problemFor(twoSplitHost(GATE))).toBeUndefined();
  });
});

const GATE = "BRANCHES_PINNED_NAME_COLUMN_FEATURE_FLAG_KEY";
/**
 * ISS-9659's own key, deliberately: it named a gate that existed until this
 * change deleted it, which is precisely the drift this check catches.
 */
const RETIRED_GATE = "SESSIONS_PINNED_LEAD_COLUMN_FEATURE_FLAG_KEY";
/**
 * Genuinely imported and read by the Branches surface — it gates WHERE the
 * column layout is derived (ISS-9316), which decides nothing about the pin. The
 * distinction between this and {@link GATE} is the whole difference between a
 * gate that is READ by the deciding condition and a name that merely appears in
 * the file, and a second live gate is the hardest case for that distinction: a
 * reference check alone cannot tell two real flags apart.
 *
 * Two names this fixture held have now been retired out from under it —
 * `BRANCH_LIST_GRID_TABLE_V2_PAGE_SIZE_OPTIONS` (ISS-9225, which collapsed the
 * page-size ladders) and `MIN_COLUMN_WIDTH_PX` (ISS-9316, which moved the track
 * parser to the column adapter). Both times the sibling check below turned red
 * rather than this one silently becoming the {@link ABSENT_IDENTIFIER} case.
 */
const UNRELATED_BUT_PRESENT_IDENTIFIER =
  "BRANCHES_COLUMN_REGISTRY_FEATURE_FLAG_KEY";
/** A name the Branches surface binds nowhere, so the AST read must answer no. */
const ABSENT_IDENTIFIER = "NOT_AN_IDENTIFIER_THIS_MODULE_BINDS";

/**
 * What a host supplies, counting the utility props ProductGridTableV2 fills
 * from the host's `favorite` controller (ISS-12918).
 */
function suppliedProps(
  hostCode: string,
  ledger: HostCapabilityLedger
): ReadonlySet<string> {
  const supplied = propsPassedToImported(
    hostCode,
    ledger.componentModule,
    ledger.componentName
  );
  if (
    ledger.componentName !== PRODUCT_GRID_COMPONENT_NAME ||
    !supplied.has("favorite")
  ) {
    return supplied;
  }
  return new Set([...supplied, ...PRODUCT_GRID_FAVORITE_SUPPLIED_PROPS]);
}

const PRODUCT_GRID_COMPONENT_NAME = "ProductGridTableV2";
