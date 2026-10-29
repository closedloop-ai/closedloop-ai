import { readFileSync } from "node:fs";
import path from "node:path";
import type { BranchAnalytics } from "@repo/api/src/types/branch";
import { BRANCH_METRIC_SPARKLINE_FEATURE_FLAG_KEY } from "@repo/api/src/types/branch-metric-sparkline-flag";
import {
  type BranchListMetricBundle,
  BranchMetricAvailability,
  BranchMetricComparisonLabel,
} from "@repo/api/src/types/branch-metrics";
import {
  makeBranchAnalytics,
  makeBranchListMetrics,
} from "@repo/app/branches/components/branch-analytics-fixtures";
import { BranchesSummaryCards } from "@repo/app/branches/components/branches-summary-cards";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import ts from "typescript6";
import { afterEach, describe, expect, it } from "vitest";
import { WEB_BRANCH_METRIC_SPARKLINE } from "@/app/(authenticated)/[orgSlug]/branches/branch-metric-sparkline-capability";
import { useDesktopBranchMetricSparkline } from "../../desktop/src/renderer/feature-flags/use-desktop-branch-metric-sparkline";
import { mountsIn, parseTsx } from "./support/jsx-mount-props";
import { moduleReferencesIdentifier } from "./support/surface-capability-gate";
import { productionMountsOf } from "./support/surface-capability-parity";

/**
 * ISS-10544 — the Branches metric-card trend sparkline is a HOST capability,
 * and the two production hosts answer it differently.
 *
 * The operator's ruling of 2026-09-17: graduated on WEB, still gated on DESKTOP.
 * That divergence is the whole subject, so BOTH hosts are in this fixture. One
 * of them alone cannot tell a host-supplied capability from a card that always
 * draws the mark — the web arm passing on a hardcoded `true` is exactly the
 * false green this file exists to prevent — so the desktop arms run the desktop
 * shell's REAL resolver against a real adapter, in both of its states.
 *
 * The expectations are written here, not read back from either resolver: each
 * arm states the mark it wants, so a resolver that inverts still reddens.
 *
 * KNOW WHAT THE DESKTOP ARMS DO AND DO NOT BUY (marisolashgrove review, PR #7525).
 * This is the first suite under `apps/app/__tests__` to IMPORT `apps/desktop`
 * runtime code rather than `readFileSync` it — `branches-list-v2-host-capability-parity.test.ts`
 * only reads `branches-view.tsx` as text. `apps/app` declares no dependency on
 * `apps/desktop`, so turbo has no edge between them: a desktop-only change never
 * selects `apps/app` under `turbo test --filter=...[origin/main]`, and someone
 * editing `use-desktop-branch-metric-sparkline.ts` to `return true` reddens the
 * DESKTOP suite and not the two desktop arms here. Those arms are not a hole —
 * the desktop suite covers that resolver properly — but they are weaker than
 * their placement in this file makes them look, and a reader should not treat
 * them as the thing standing between that edit and `main`.
 *
 * What lives elsewhere, deliberately: how the DESKTOP shell resolves the key
 * against its own provider is
 * `apps/desktop/src/renderer/feature-flags/__tests__/use-desktop-branch-metric-sparkline.test.tsx`,
 * which is the only project that can mount `DesktopFeatureFlagProvider`. Here
 * the hook runs against the shared static adapter, which is enough to show the
 * shell's answer reaching the shared row and no more than that.
 */

const SERIES = [10, 14, 9, 22, 30, 26];

const SIZE_VALUE_TEXT = /148 LOC/;

/**
 * The row's module as its package-local sibling imports it. Relative rather
 * than `@repo/app/...` because the only production mount left is inside the
 * same package (ISS-9427), and `mountsIn` matches the specifier as written.
 */
const SUMMARY_MODULE_RELATIVE = "./branches-summary-cards";

const REPO_ROOT = path.join(process.cwd(), "..", "..");

/**
 * The allowance every sibling parity suite gives this walk. It reads and parses
 * every `.tsx` under `apps` and `packages`: sub-second warm here, and cold CI is
 * the run the number was chosen for.
 */
const REPO_WALK_TIMEOUT_MS = 60_000;

const WEB_HOST = "apps/app/app/(authenticated)/[orgSlug]/branches/page.tsx";
const DESKTOP_HOST =
  "apps/desktop/src/renderer/components/branches/branches-view.tsx";
const DESKTOP_CAPABILITY =
  "apps/desktop/src/renderer/feature-flags/use-desktop-branch-metric-sparkline.ts";
/**
 * ISS-9427 (#7512): the one module that mounts the shared row now. Both hosts
 * reach `BranchesSummaryCards` through it, so it is where a dropped forward
 * would take the mark away from everyone at once.
 */
const SHARED_BAND =
  "packages/app/branches/components/branches-list-summary-band.tsx";

/** The object each host spreads into its summary band. */
const BAND_PROPS_BINDING = "summaryBandProps";

/** The name every legitimate read site imports the key under. */
const FLAG_KEY_IDENTIFIER = "BRANCH_METRIC_SPARKLINE_FEATURE_FLAG_KEY";

/** The card ISS-10208 leaves without a delta: a real value, no comparison. */
function analyticsWithSeries(): BranchAnalytics {
  const canonicalMetrics: BranchListMetricBundle = makeBranchListMetrics({
    medianPrSize: {
      current: { state: BranchMetricAvailability.Complete, value: 148 },
      comparison: {
        label: BranchMetricComparisonLabel.MonthOverMonth,
        priorWindow: {
          startAt: "2026-06-06T00:00:00.000Z",
          endAt: "2026-07-06T00:00:00.000Z",
        },
        deltaPct: { state: BranchMetricAvailability.Unavailable, value: null },
      },
      series: SERIES,
    },
  });
  return { ...makeBranchAnalytics(), canonicalMetrics };
}

/**
 * The desktop shell's band, reduced to the one thing under test: it resolves the
 * capability the way `BranchesDesktopSummaryBand` resolves it — through the real
 * hook, against whatever adapter is mounted above — and hands it to the same
 * shared row the real band hands it to.
 */
function DesktopBand() {
  const trendSparkline = useDesktopBranchMetricSparkline();
  return (
    <BranchesSummaryCards
      analytics={analyticsWithSeries()}
      isError={false}
      isPending={false}
      trendSparkline={trendSparkline}
    />
  );
}

function WebBand() {
  return (
    <BranchesSummaryCards
      analytics={analyticsWithSeries()}
      isError={false}
      isPending={false}
      trendSparkline={WEB_BRANCH_METRIC_SPARKLINE}
    />
  );
}

function renderBand(band: ReactElement, enabledFlags: readonly string[]) {
  render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({ enabledFlags })}
    >
      {band}
    </FeatureFlagAdapterProvider>
  );
}

/**
 * The median-PR-size card, found by its own figure, never by position.
 *
 * Throws rather than defaulting when the card cannot be found: a `?? 0` would
 * let "no card at all" satisfy every negative arm below.
 */
function sparklinesOnSizeCard(): number {
  const card = screen.getByText(SIZE_VALUE_TEXT).closest("[data-slot='card']");
  if (!card) {
    throw new Error("No metric card around the median-PR-size figure.");
  }
  return card.querySelectorAll("svg polyline").length;
}

/** A host module's source, read from the repo rather than restated here. */
function hostCode(repoRelativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, repoRelativePath), "utf8");
}

/**
 * The host, parsed with its REAL path. ISS-11472 moved the band's layout props
 * into one exported constant it spreads, and the spread reader can only follow
 * that import when the parse knows which file it came from.
 */
function hostSource(repoRelativePath: string): ts.SourceFile {
  return parseTsx(
    hostCode(repoRelativePath),
    path.join(REPO_ROOT, repoRelativePath)
  );
}

/**
 * The expression `hostPath` puts under `trendSparkline` in its summary-band
 * props, as written. Read off the AST: `no-raw-text-source-scan` bans
 * text-scanning implementation source, and a substring search could not tell a
 * property's value from the same words in a docblock anyway.
 *
 * ISS-9427 (#7512) moved each host's band out of the host and into the shared
 * `BranchesListSummaryBand`, so a host no longer writes a JSX attribute on
 * `BranchesSummaryCards` — it writes a property in the object it spreads. The
 * subject is unchanged: the VALUE this host supplies, never the prop's
 * presence.
 *
 * A shorthand (`{ trendSparkline }`) reports the property NAME, which is what
 * makes the desktop pair below meaningful: the name is then chased to its
 * binding, so `const trendSparkline = true` cannot pass for the flag read.
 */
function bandCapabilityExpression(hostPath: string): string {
  const source = hostSource(hostPath);
  const initializer = bandPropsObject(source, hostPath);
  for (const property of initializer.properties) {
    if (
      ts.isShorthandPropertyAssignment(property) &&
      property.name.text === "trendSparkline"
    ) {
      return property.name.text;
    }
    if (
      ts.isPropertyAssignment(property) &&
      property.name.getText(source) === "trendSparkline"
    ) {
      return property.initializer.getText(source);
    }
  }
  throw new Error(
    `${hostPath} puts no trendSparkline in its summary-band props — the check has nothing to read.`
  );
}

/** The `summaryBandProps` object literal in a host module. */
function bandPropsObject(
  source: ts.SourceFile,
  hostPath: string
): ts.ObjectLiteralExpression {
  let found: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node) => {
    if (
      found === undefined &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === BAND_PROPS_BINDING &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      found = node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  if (found === undefined) {
    throw new Error(`No \`${BAND_PROPS_BINDING}\` object in ${hostPath}.`);
  }
  return found;
}

/**
 * The expression the SHARED band hands `BranchesSummaryCards`. One forwarding
 * point now stands between every host and the row, so a `trendSparkline={false}`
 * written here would silently undo both hosts at once.
 */
function forwardedCapabilityExpression(): string {
  const source = hostSource(SHARED_BAND);
  const [mount] = mountsIn(
    source,
    SUMMARY_MODULE_RELATIVE,
    "BranchesSummaryCards"
  );
  const attribute = mount?.node.attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) &&
      property.name.getText(source) === "trendSparkline"
  );
  const initializer = attribute?.initializer;
  if (
    !(initializer && ts.isJsxExpression(initializer) && initializer.expression)
  ) {
    throw new Error(
      `${SHARED_BAND} hands BranchesSummaryCards no trendSparkline expression — the check has nothing to read.`
    );
  }
  return initializer.expression.getText(source);
}

/** The initializer of `const <name> = …` in `code`, as written. */
function bindingInitializer(code: string, name: string): string {
  const source = parseTsx(code);
  let found: string | undefined;
  const visit = (node: ts.Node) => {
    if (
      found === undefined &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      found = node.initializer.getText(source);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  if (found === undefined) {
    throw new Error(`No \`${name}\` binding in this module to read.`);
  }
  return found;
}

afterEach(cleanup);

describe("Branches metric sparkline per host (ISS-10544)", () => {
  it("draws on WEB from the graduated capability, no flag involved", () => {
    renderBand(<WebBand />, []);
    expect(sparklinesOnSizeCard()).toBe(1);
  });

  it("withholds on WEB if that capability is ever answered no", () => {
    // The sibling positive/negative pair on the SAME locator. Without it the
    // arm above could be satisfied by a row that always draws the mark, and the
    // constant it reads would be pinning nothing.
    renderBand(
      <BranchesSummaryCards
        analytics={analyticsWithSeries()}
        isError={false}
        isPending={false}
        trendSparkline={false}
      />,
      []
    );
    expect(sparklinesOnSizeCard()).toBe(0);
  });

  it("withholds from a host that never answered", () => {
    // `BranchesSummaryCards`' own default, which is what a new host inherits.
    renderBand(
      <BranchesSummaryCards
        analytics={analyticsWithSeries()}
        isError={false}
        isPending={false}
      />,
      []
    );
    expect(sparklinesOnSizeCard()).toBe(0);
  });

  it("withholds on DESKTOP while the flag is off", () => {
    renderBand(<DesktopBand />, []);
    expect(sparklinesOnSizeCard()).toBe(0);
  });

  it("draws on DESKTOP once the flag is on", () => {
    renderBand(<DesktopBand />, [BRANCH_METRIC_SPARKLINE_FEATURE_FLAG_KEY]);
    expect(sparklinesOnSizeCard()).toBe(1);
  });

  it("leaves the desktop shell the only reader of the key", () => {
    // The ruling is "graduated on web", not "deleted": the key still ships and
    // still gates one shell. A web host that started reading it again would put
    // the graduation back behind the gate it was taken out of.
    expect(
      moduleReferencesIdentifier(hostCode(WEB_HOST), FLAG_KEY_IDENTIFIER)
    ).toBe(false);
    expect(
      moduleReferencesIdentifier(
        hostCode(DESKTOP_CAPABILITY),
        FLAG_KEY_IDENTIFIER
      )
    ).toBe(true);
  });
});

describe("BranchesSummaryCards host capability (ISS-10544)", () => {
  // The VALUE each host hands over, never merely the prop's presence. A
  // presence check is satisfied by `trendSparkline={false}` on web and by
  // `const trendSparkline = true` on desktop — i.e. by reverting each half of
  // the ruling — so it would let the whole deliverable be undone with nothing
  // red (review-soul, 2026-09-17).
  it("web hands the graduated constant, not a literal", () => {
    expect(bandCapabilityExpression(WEB_HOST)).toBe(
      "WEB_BRANCH_METRIC_SPARKLINE"
    );
  });

  it("desktop hands what its own flag read returned", () => {
    expect(bandCapabilityExpression(DESKTOP_HOST)).toBe("trendSparkline");
    expect(bindingInitializer(hostCode(DESKTOP_HOST), "trendSparkline")).toBe(
      "useDesktopBranchMetricSparkline()"
    );
  });

  it("the shared band forwards each host's answer rather than deciding", () => {
    // ISS-9427 put one module between every host and the row. A literal here
    // would override both hosts at once, and the two host assertions above
    // would still pass — they read what the host SENDS, not what arrives.
    expect(forwardedCapabilityExpression()).toBe("trendSparkline");
  });

  it(
    "routes every production mount of the row through that one band",
    () => {
      // The capability defaults to `false`, so a mount that never answers loses
      // the mark in silence. Before ISS-9427 that risk was one new HOST; now it
      // is one new mount of the row anywhere, so this pins the mount set to the
      // single forwarding module the two assertions above cover.
      expect(
        productionMountsOf({
          exportName: "BranchesSummaryCards",
          moduleSuffix: "branches-summary-cards",
          repoRoot: REPO_ROOT,
          searchRoots: ["apps", "packages"],
        })
      ).toStrictEqual([SHARED_BAND]);
    },
    REPO_WALK_TIMEOUT_MS
  );
});
