/**
 * ISS-10468 — the side-by-side version compare, through the REAL render path.
 *
 * Driven through `AgentDetail` (the one production caller of
 * `VersionUsagePanel`) behind the real flag provider, so deleting the mount site
 * or the gate fails these cases rather than leaving them green against a prop
 * bundle nothing renders.
 *
 * The compare's own axis is the five states a reader acts on differently — still
 * loading, failed, not comparable, a genuine zero, a computed change. The
 * derivation's four are pinned in `agents/lib/__tests__/version-usage-compare.test.ts`;
 * what these cases pin is that the SURFACE reaches them: the gate, the
 * affordance's own precondition, the call shape, and that a bounded or absent
 * operand never costs the reader the column.
 */

import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import type {
  AgentComponentVersionUsage,
  AgentComponentVersionUsageResponse,
} from "@repo/api/src/types/agent-component-version-usage";
import { EMPTY_COHORT_DELIVERY_METRICS } from "@repo/api/src/types/analytics";
import { EMPTY_VERSION_SPEND } from "@repo/api/src/utils/version-spend";
import { NO_COMPARISON_CHIP_LABEL } from "@repo/app/insights/components/kpi-delta-placeholder";
import { AGENTS_VERSION_USAGE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import { AgentComponentsDataSourceProvider } from "../../../data-source/provider";
import {
  VERSION_COMPARE_DIRECTION_WORD,
  VERSION_COMPARE_NO_CHANGE_LABEL,
  VersionCompareDirection,
} from "../../../lib/version-usage-compare";
import { AgentDetail } from "../agent-detail";
import {
  CURRENT_HASH,
  MEASURED_ATTRIBUTION,
  makeDetail,
  OLDER_HASH,
  PANEL_HEADING,
  renderDetail,
  revision,
} from "./version-usage-fixtures";

const COMPARE_TOGGLE = "Compare the selected revision with another";
const CHANGE_COLUMN = "Change";
const BASELINE_SELECT = "Revision to compare against";
/** The baseline trigger's own "vs" prefix, stripped to leave the revision name. */
const BASELINE_TRIGGER_PREFIX = /^vs/;
// Top-level per `useTopLevelRegex`. Word-bounded so the direction WORDS are
// matched as words rather than as a substring of some other cell's copy.
const DIRECTION_UP = /\bup\b/;
const DIRECTION_DOWN = /\bdown\b/;
const MERGED_PRS_ROW = /Merged PRs/;
/** The Unchanged direction word, located through the canonical map, not a copy. */
const DIRECTION_UNCHANGED = new RegExp(
  `\\b${VERSION_COMPARE_DIRECTION_WORD[VersionCompareDirection.Unchanged]}\\b`
);
const INVOCATIONS_ROW = /Invocations/;
const BOUNDED_CAVEAT = /approximate rather than exact/;
const CANDIDATE_ABSENT_REASON = /This revision has no measured/;
// The family restatement, TERMINATOR INCLUDED and with nothing after it. The
// sentence about the body below is the half that must not survive a failed read
// (whitlockk), and only an anchored match can tell "tail dropped" from "tail
// present": every unanchored regex over this paragraph matches either way.
const FAMILY_RESTATEMENT_ALONE =
  /^The cards above total 76 invocations across 5 sessions, for every revision\.$/;

function usageEntry(
  hash: string,
  overrides: Partial<AgentComponentVersionUsage>
): AgentComponentVersionUsage {
  return {
    hash,
    invocations: null,
    sessions: null,
    locPerDollar: null,
    truncated: false,
    ...EMPTY_COHORT_DELIVERY_METRICS,
    ...EMPTY_VERSION_SPEND,
    ...overrides,
  };
}

/**
 * A source that answers PER REQUESTED HASH, in request order.
 *
 * A single-entry mock would make every compare assertion vacuous: the table
 * would pass against an implementation that renders one revision's figures in
 * both columns and subtracts a number from itself.
 */
function pairSource(
  byHash: Record<string, Partial<AgentComponentVersionUsage>>
) {
  return (_slug: string, hashes: readonly string[]) =>
    Promise.resolve<AgentComponentVersionUsageResponse>({
      entries: hashes.map((hash) => usageEntry(hash, byHash[hash] ?? {})),
      attribution: MEASURED_ATTRIBUTION,
    });
}

/** The two revisions the fixture detail carries, with deltas of opposite sign. */
const RISING_AND_FALLING = pairSource({
  [CURRENT_HASH]: { invocations: 50, sessions: 8, mergedPrs: 4 },
  [OLDER_HASH]: { invocations: 40, sessions: 10, mergedPrs: 4 },
});

async function openCompare() {
  const toggle = await screen.findByRole("button", { name: COMPARE_TOGGLE });
  await userEvent.click(toggle);
  return toggle;
}

describe("version compare — a FAILED read", () => {
  it("does not promise two columns and a change that are not there", async () => {
    render(
      <AppCoreStoryProviders
        enabledFlags={[AGENTS_VERSION_USAGE_FEATURE_FLAG_KEY]}
      >
        <AgentComponentsDataSourceProvider
          dataSource={{
            scope: "test-version-compare-error",
            honorsDateWindow: false,
            list: () => Promise.reject(new Error("unused")),
            detail: () => Promise.resolve(makeDetail()),
            // `supported` is a SOURCE-CAPABILITY probe, not the read's outcome,
            // so the compare affordance is reachable on a failing read — which
            // is exactly how the stale promise below was reachable.
            versionUsage: () => Promise.reject(new Error("read failed")),
          }}
        >
          <AgentDetail
            backHref="/acme/agents"
            slug="skill::version-usage-fixture"
          />
        </AgentComponentsDataSourceProvider>
      </AppCoreStoryProviders>
    );

    await screen.findByText(PANEL_HEADING);
    await openCompare();

    // The body is the named error alert and nothing else.
    const panel = screen.getByRole("region", { name: PANEL_HEADING });
    expect(await within(panel).findByRole("alert")).toHaveTextContent(
      "Couldn't load this version's usage. Refresh to try again."
    );
    expect(within(panel).queryByText(CHANGE_COLUMN)).toBeNull();
    // So the lead sentence states the family baseline — still true, those cards
    // are rendering — and stops. Leaving the tail on would tell the reader two
    // revisions' figures and their change are below the alert.
    expect(
      within(panel).getByText(FAMILY_RESTATEMENT_ALONE)
    ).toBeInTheDocument();
  });
});

describe("version compare — the gate and its precondition", () => {
  it("flag OFF: no compare affordance at all", async () => {
    renderDetail({ detail: makeDetail(), source: RISING_AND_FALLING }, false);

    await screen.findByText("Definition");
    // Closed by default (ISS-4779): the surface is not in the tree, not merely
    // disabled. This case and the next are identical but for the flag, so a
    // compare that rendered regardless would fail exactly this one.
    expect(
      screen.queryByRole("button", { name: COMPARE_TOGGLE })
    ).not.toBeInTheDocument();
  });

  it("flag ON: offers the compare when a second revision exists", async () => {
    renderDetail({ detail: makeDetail(), source: RISING_AND_FALLING });

    await screen.findByText(PANEL_HEADING);
    const toggle = await screen.findByRole("button", {
      name: COMPARE_TOGGLE,
    });
    // A toggle, so its state is in the accessibility tree rather than in colour.
    expect(toggle).toHaveAttribute("aria-pressed", "false");
  });

  it("offers no compare when the history holds ONE revision", async () => {
    // The one honest reason to withhold the comparison: there is no second
    // operand. Not because a figure inside it was hard to compute.
    renderDetail({
      detail: makeDetail({ versions: [revision(CURRENT_HASH, true)] }),
      source: RISING_AND_FALLING,
    });

    await screen.findByText(PANEL_HEADING);
    expect(
      screen.queryByRole("button", { name: COMPARE_TOGGLE })
    ).not.toBeInTheDocument();
    // And the drill-down itself still renders, so this is a precondition rather
    // than a panel-wide suppression.
    const panel = screen.getByRole("region", { name: PANEL_HEADING });
    expect(within(panel).getByText("Invocations")).toBeInTheDocument();
  });
});

describe("version compare — the read it drives", () => {
  it("asks the producer for BOTH versions, candidate first", async () => {
    const spy = vi.fn(RISING_AND_FALLING);
    const detail = makeDetail();
    render(
      <AppCoreStoryProviders
        enabledFlags={[AGENTS_VERSION_USAGE_FEATURE_FLAG_KEY]}
      >
        <AgentComponentsDataSourceProvider
          dataSource={{
            scope: "test-version-compare-call-shape",
            honorsDateWindow: false,
            list: () => Promise.reject(new Error("unused")),
            detail: () => Promise.resolve(detail),
            versionUsage: spy,
          }}
        >
          <AgentDetail backHref="/acme/agents" slug={detail.slug} />
        </AgentComponentsDataSourceProvider>
      </AppCoreStoryProviders>
    );

    await screen.findByText(PANEL_HEADING);
    // Before the toggle the drill-down still costs ONE version's read.
    expect(spy).toHaveBeenCalledWith(detail.slug, [CURRENT_HASH]);

    await openCompare();

    // The CALL SHAPE, and the order: the contract answers "in the order
    // requested", and the readout reads the baseline positionally.
    await vi.waitFor(() =>
      expect(spy).toHaveBeenCalledWith(detail.slug, [CURRENT_HASH, OLDER_HASH])
    );
  });
});

describe("version compare — what the table states", () => {
  it("renders each revision's OWN figures and the change between them", async () => {
    renderDetail({ detail: makeDetail(), source: RISING_AND_FALLING });
    await screen.findByText(PANEL_HEADING);
    await openCompare();

    const panel = screen.getByRole("region", { name: PANEL_HEADING });
    // Both columns carry their own revision's number — 50 and 40, not one
    // number twice — so an implementation ignoring the baseline hash fails here.
    expect(await within(panel).findByText("50")).toBeInTheDocument();
    expect(within(panel).getByText("40")).toBeInTheDocument();
    // The change column exists and is named, which is the slot #7017 deleted.
    expect(
      within(panel).getByRole("columnheader", { name: CHANGE_COLUMN })
    ).toBeInTheDocument();
    // 40 → 50 is a hand-written +25%, not re-derived with the code's arithmetic.
    expect(within(panel).getByText("+25%")).toBeInTheDocument();
  });

  it("states the direction in WORDS, never in hue alone", async () => {
    renderDetail({ detail: makeDetail(), source: RISING_AND_FALLING });
    await screen.findByText(PANEL_HEADING);
    await openCompare();

    const panel = screen.getByRole("region", { name: PANEL_HEADING });
    // WCAG 2.2 SC 1.4.1. The arrow is `aria-hidden`, so without these words the
    // direction would reach a screen-reader user as a bare magnitude.
    expect(await within(panel).findByText(DIRECTION_UP)).toBeInTheDocument();
    expect(within(panel).getByText(DIRECTION_DOWN)).toBeInTheDocument();
  });

  it("a GENUINE zero change reads as No change, not as no comparison", async () => {
    renderDetail({ detail: makeDetail(), source: RISING_AND_FALLING });
    await screen.findByText(PANEL_HEADING);
    await openCompare();

    const panel = screen.getByRole("region", { name: PANEL_HEADING });
    await within(panel).findByText(VERSION_COMPARE_NO_CHANGE_LABEL);
    // Scoped to the Merged PRs ROW, because other rows in this fixture
    // legitimately have no measured figure and DO render "No comparison" — which
    // is the point: the two states coexist in one table and must read
    // differently. Merged PRs are 4 on both sides: measured, identical, a real
    // answer. Collapsing the two states would print the chip in this row too.
    const row = within(panel).getByRole("row", { name: MERGED_PRS_ROW });
    expect(
      within(row).getByText(VERSION_COMPARE_NO_CHANGE_LABEL)
    ).toBeInTheDocument();
    expect(
      within(row).queryByText(NO_COMPARISON_CHIP_LABEL)
    ).not.toBeInTheDocument();
    // The sr-only direction word is SKIPPED here (tamsinb): the visible
    // magnitude is already "No change", so emitting "unchanged" beside it makes
    // a screen reader say "No change unchanged". The word is located through
    // `VERSION_COMPARE_DIRECTION_WORD`, so this cannot pass by holding its own
    // stale copy of the string.
    expect(
      within(row).queryByText(DIRECTION_UNCHANGED)
    ).not.toBeInTheDocument();
  });

  it("numbers the baseline column and the baseline selector off ONE base", async () => {
    // A third revision whose hash coerces away (FEA-3520), placed AFTER the one
    // the compare reads against, so `versions` and `options` have different
    // lengths at that index and the two numbering bases disagree: the column
    // header said "Rev 2" while the dropdown right above it said "Rev 1"
    // (tamsinb). Asserted as AGREEMENT between the two renders rather than
    // against a hardcoded "Rev N", so the case cannot pass by carrying a stale
    // copy of either label.
    renderDetail({
      detail: makeDetail({
        versions: [
          revision(CURRENT_HASH, true),
          revision(OLDER_HASH, false),
          // A NON-STRING hash, which is the real FEA-3520 shape `coerceHash`
          // folds to "" — not a literal empty string, which crashes the
          // Definition panel's own unfiltered `Select` (`agent-detail.tsx:605`,
          // pre-existing and outside this change).
          {
            ...revision("dddddddd4444", false),
            hash: {} as unknown as string,
          },
        ],
      }),
      source: RISING_AND_FALLING,
    });
    await screen.findByText(PANEL_HEADING);
    await openCompare();

    const panel = screen.getByRole("region", { name: PANEL_HEADING });
    const selectorLabel = within(panel).getByRole("combobox", {
      name: BASELINE_SELECT,
    }).textContent;
    const revisionName = selectorLabel
      ?.split(" · ")[0]
      ?.replace(BASELINE_TRIGGER_PREFIX, "");
    expect(revisionName).toBeTruthy();
    expect(
      within(panel).getByRole("columnheader", {
        name: revisionName as string,
      })
    ).toBeInTheDocument();
  });

  it("publishes the delta when an operand is a FLOOR, with the shortfall stated", async () => {
    // The exact shape #7017 refused: one side's counts are bounded. The delta is
    // still real, so it renders — with its bound named beside it.
    renderDetail({
      detail: makeDetail(),
      source: pairSource({
        [CURRENT_HASH]: { invocations: 50, sessions: 8, truncated: true },
        [OLDER_HASH]: { invocations: 40, sessions: 10 },
      }),
    });
    await screen.findByText(PANEL_HEADING);
    await openCompare();

    const panel = screen.getByRole("region", { name: PANEL_HEADING });
    expect(await within(panel).findByText("+25%")).toBeInTheDocument();
    // The shortfall is STATED beside the published figure — once for the table,
    // and marked per row so the caption cannot be read as covering all of them.
    expect(within(panel).getByText(BOUNDED_CAVEAT)).toBeInTheDocument();
    const row = within(panel).getByRole("row", { name: INVOCATIONS_ROW });
    expect(within(row).getByText("approx.")).toBeInTheDocument();
    // And it is NOT the no-comparison state: the figure survived the bound.
    expect(
      within(row).queryByText(NO_COMPARISON_CHIP_LABEL)
    ).not.toBeInTheDocument();
  });

  it("withholds only the delta an ABSENT operand blocks, and names the reason", async () => {
    renderDetail({
      detail: makeDetail({ kind: AgentComponentKind.Subagent }),
      source: pairSource({
        [CURRENT_HASH]: { invocations: 50, sessions: 8, locPerDollar: null },
        [OLDER_HASH]: { invocations: 40, sessions: 10, locPerDollar: 8 },
      }),
    });
    await screen.findByText(PANEL_HEADING);
    await openCompare();

    const panel = screen.getByRole("region", { name: PANEL_HEADING });
    // The reason is IN THE ACCESSIBILITY TREE, not only a tooltip, and it names
    // the side — a bare dash would read as forgotten data.
    expect(
      await within(panel).findByText(CANDIDATE_ABSENT_REASON)
    ).toBeInTheDocument();
    // Every other row still compares: one absent operand is not a table-wide
    // refusal, which is the failure this whole surface exists not to repeat.
    expect(within(panel).getByText("+25%")).toBeInTheDocument();
    // And the older revision's own LOC / $ is still rendered beside the gap: the
    // compare withholds a delta it cannot compute, never a value it holds.
    expect(within(panel).getByText("8.00")).toBeInTheDocument();
  });
});
