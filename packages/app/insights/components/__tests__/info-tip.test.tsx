import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { METRIC_INFO } from "../../lib/metric-info";
import { InfoTip } from "../info-tip";

// A tile id registered in `metric-info.ts`. This suite covers the hover/dismiss
// behavior and deliberately does not pin the wording, so the expected text is
// read from the registry rather than restated here; what the `kpi:merged` copy
// must say is pinned in `lib/__tests__/tile-catalog.test.ts`.
const KNOWN_TILE_ID = "kpi:merged";
const KNOWN_WHAT = METRIC_INFO[KNOWN_TILE_ID].what;

/**
 * ISS-5501. The registry suite (`lib/__tests__/tile-catalog.test.ts`) pins this
 * copy in `METRIC_INFO`, but it reads `getMetricInfo` and renders nothing — it
 * stays green if the popover stops rendering a field, or stops opening at all.
 * These pin the same three claims as RENDERED text, through the real
 * `InfoHint` popover, so the reader-facing failure modes are covered and not
 * just the registry entry.
 */
const MERGE_RATE_TILE_ID = "kpi:merge-rate";
const MERGE_RATE_LINES = [
  "Share of decided PRs (merged or closed) that merged.",
  "Merged PRs divided by decided PRs (merged + closed). PRs still open are excluded, so they don't drag the rate down.",
  "Merged and closed PRs are read from PR state.",
];
/**
 * The denominator neither producer uses — the whole defect. "opened"/"opens",
 * not "open": the corrected copy says "PRs still open are excluded", which is
 * the right claim.
 */
const OPENED_PR_DENOMINATOR = /\bopen(ed|s)\b/i;

/**
 * ISS-5503, same reason as the ISS-5501 block above: the registry suite pins
 * this copy in `METRIC_INFO` but renders nothing, so it stays green if the
 * popover drops the `sessions` field or a shell wires the wrong tile id. The
 * two entries are the SAME metric, so both are pinned as rendered text.
 */
const KLOC_TILE_IDS = ["kpi:kloc", "chart:klocTrend"];
/**
 * The claim the review corrected: desktop COALESCEs each LOC side
 * independently, so only a MISSING SIDE is zeroed — the whole un-enriched PR
 * is not. Matches "folding un-enriched PRs in as 0" and nothing the corrected
 * copy says.
 */
const WHOLE_PR_ZEROED = /folding un-enriched PRs in as 0/i;
/**
 * The other corrected claim: the line counts are GitHub's on both surfaces,
 * so the session log may IDENTIFY a captured PR but must never be credited
 * with SIZING it. Matches the old sentence and any re-drafting of it.
 */
const SESSION_LOGS_SIZE_THE_PR =
  /line counts from each captured PR harvested from local session/i;

/**
 * ISS-6849, same reason as the ISS-5501 / ISS-5503 blocks above — and the rule
 * the Insights contract states outright: a catalog/registry assertion is not
 * coverage, because it renders nothing. `lib/__tests__/tile-catalog.test.ts`
 * pins the merged-PR scan-cap sentence in `METRIC_INFO` and stays green if the
 * popover stops rendering `how` at all. The set is DERIVED from the registry
 * rather than restated, so a tile that joins the cap inventory is rendered here
 * without a second list to keep in step.
 */
const CAP_COPY = /at most the newest 25,000 merged-PR rows in the range/;
const CAP_TILE_IDS = Object.keys(METRIC_INFO).filter((tileId) =>
  CAP_COPY.test(METRIC_INFO[tileId].how)
);
/**
 * The claim the review corrected: the cap is a LIMIT on projection ROWS, and the
 * dedupe runs after it, so a per-PR reading of the cap overstates the population
 * that survives. Matches the retired sentence and any re-drafting of it.
 */
const CAP_AS_DISTINCT_PRS = /newest 25,000 merged PRs/;
/**
 * The scan-population sentence in EITHER spelling. `kpi:merged` is the shared fold's
 * uncapped count (ISS-12408), so it never reads a bounded population and must
 * never say it does.
 */
const CAP_POPULATION_CLAIM = /newest 25,000 merged(-PR rows| PRs)/;
/**
 * ISS-6845, same reason as the two blocks above: the registry suite pins this
 * copy but renders nothing. These four Delivery charts each claimed a session
 * sourced the attribute they group by, and none of their producers reads one —
 * so the corrected line has to reach the reader UNDER the fixed "From session
 * logs" heading, which is exactly what makes a body that credits a session
 * doubly wrong.
 */
const RECORD_SOURCED_CHART_TILE_IDS = [
  "chart:prByRepo",
  "chart:prByState",
  "chart:checkStatus",
  "chart:branchesWithoutPr",
];
/**
 * The four claims the producers contradict, in one alternation asserted against
 * the WHOLE popover — so a revert cannot reintroduce any of them in a field
 * this test does not enumerate.
 */
const SESSION_SOURCED_CHART_ATTRIBUTE =
  /comes from the session that opened|PR state on each session's proposal|captured from CI events|taken from session metadata/i;

/**
 * ISS-6845 (review): `chart:branchLifespan` is the fifth changed popover, and
 * the only one whose corrected copy is NOT the "own record" sentence — it takes
 * the Time-to-merge chart's two producer claims — so the case above cannot
 * cover it. Without a rendered case the registry suite is all it has, and that
 * suite renders nothing: it stays green if this copy stops reaching the reader
 * or arrives under the wrong heading.
 */
const BRANCH_LIFESPAN_TILE_ID = "chart:branchLifespan";
/**
 * The retired provenance, and the overstatement the review caught, asserted
 * against the WHOLE popover: the branch-session claim neither producer reads,
 * and the authoring-only desktop interval that ignored the `created_rank`
 * fallback to a merely-referencing session.
 */
const BRANCH_SESSION_LIFESPAN =
  /sessions that first touched and last closed the branch/i;
const AUTHORING_SESSION_ONLY = /authoring[- ]session/i;

/**
 * ISS-9842 (marisolashgrove review), same reason as every block above: the
 * registry suite (`lib/__tests__/metric-info.test.ts`) pins these four entries
 * and renders nothing. The bar and the ring of each pair share one capped
 * desktop query, and the ring's Other-slice sentence had been rendering on the
 * bar, which draws no residual. Each tile id is driven through the real
 * popover so the bar can never again show the ring's claim.
 */
const CAPPED_PAIR_TILES = [
  { tileId: "chart:toolUsage", retained: "20 most-used tools", ring: false },
  {
    tileId: "chart:toolUsage:donut",
    retained: "20 most-used tools",
    ring: true,
  },
  {
    tileId: "chart:eventsByType",
    retained: "12 most common types",
    ring: true,
  },
  {
    tileId: "chart:eventsByType:bar",
    retained: "12 most common types",
    ring: false,
  },
] as const;
const RING_RESIDUAL_CLAIM = /one Other slice/;

describe("InfoTip", () => {
  it("renders nothing for a tile id with no registered definition", () => {
    const { container } = render(<InfoTip tileId="nope:none" />);
    expect(container.firstChild).toBeNull();
  });

  it("reveals the metric explainer on hover, with no click required", async () => {
    render(<InfoTip tileId={KNOWN_TILE_ID} />);
    const trigger = screen.getByRole("button", { name: "Metric details" });

    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });

    const dialog = await screen.findByRole("dialog", {
      name: "Metric details",
    });
    expect(dialog.textContent).toContain(KNOWN_WHAT);
  });

  it("carries the dashboard grid's drag-cancel class on the trigger", () => {
    // The dashboard grid gates dragging to `.insights-drag-handle` and also
    // cancels a drag begun on `.insights-widget-control` (dashboard-grid.tsx), so
    // the info trigger must carry that class to match the tile's other controls.
    render(<InfoTip tileId={KNOWN_TILE_ID} />);
    const trigger = screen.getByRole("button", { name: "Metric details" });
    expect(trigger.className).toContain("insights-widget-control");
  });

  it("dismisses on pointer-out", async () => {
    render(<InfoTip tileId={KNOWN_TILE_ID} />);
    const trigger = screen.getByRole("button", { name: "Metric details" });

    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    await screen.findByRole("dialog", { name: "Metric details" });

    fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("renders the decided merge-rate denominator, never the opened-PR one (ISS-5501)", async () => {
    render(<InfoTip tileId={MERGE_RATE_TILE_ID} />);
    const trigger = screen.getByRole("button", { name: "Metric details" });

    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });

    const dialog = await screen.findByRole("dialog", {
      name: "Metric details",
    });
    for (const line of MERGE_RATE_LINES) {
      expect(dialog.textContent).toContain(line);
    }
    // Asserted against the WHOLE popover rather than the lines named above, so
    // a revert cannot reintroduce the wrong denominator in a field this test
    // does not happen to enumerate.
    expect(dialog.textContent).not.toMatch(OPENED_PR_DENOMINATOR);
  });

  it.each(KLOC_TILE_IDS)(
    "renders the corrected KLOC provenance for %s, under the fixed heading (ISS-5503)",
    async (tileId) => {
      render(<InfoTip tileId={tileId} />);
      const trigger = screen.getByRole("button", { name: "Metric details" });

      fireEvent.pointerEnter(trigger, { pointerType: "mouse" });

      const dialog = await screen.findByRole("dialog", {
        name: "Metric details",
      });
      const text = dialog.textContent ?? "";
      // The `sessions` field must actually reach the reader — the failure the
      // registry suite cannot see. Its heading is a fixed literal shared by
      // every entry, which is WHY the field body has to name the real origin.
      expect(text).toContain("From session logs");
      expect(text).toContain("as GitHub reported them");
      // ISS-12594 removed the `sessions` Desktop clause, which credited the
      // deleted cloud-hydration writer; ISS-12638 (operator ruling) removed the
      // Desktop derivation from `how` too, so neither field renders it.
      expect(text).not.toContain("GitHub-sourced record");
      expect(text).not.toContain("zeroing only the sides it is missing");
      // Asserted against the WHOLE popover, not an enumerated line, so a revert
      // cannot reintroduce either wrong claim in a field this test does not
      // happen to name.
      expect(text).not.toMatch(WHOLE_PR_ZEROED);
      expect(text).not.toMatch(SESSION_LOGS_SIZE_THE_PR);
    }
  );

  it("covers every capped-scan tile (ISS-6849)", () => {
    // Guards the derivation above: a filter that matched nothing would make
    // the rendered cases below vacuously green.
    expect(CAP_TILE_IDS.length).toBeGreaterThan(0);
  });

  it.each(CAP_TILE_IDS)(
    "renders the merged-PR row-scan cap for %s (ISS-6849)",
    async (tileId) => {
      render(<InfoTip tileId={tileId} />);
      const trigger = screen.getByRole("button", { name: "Metric details" });

      fireEvent.pointerEnter(trigger, { pointerType: "mouse" });

      const dialog = await screen.findByRole("dialog", {
        name: "Metric details",
      });
      const text = dialog.textContent ?? "";
      expect(text).toMatch(CAP_COPY);
      // Asserted against the WHOLE popover, not the `how` line alone, so the
      // per-PR reading cannot come back in a field this test does not name.
      expect(text).not.toMatch(CAP_AS_DISTINCT_PRS);
    }
  );

  it("renders the median-size cloud read, under the fixed heading (ISS-11589)", async () => {
    render(<InfoTip tileId={PR_SIZE_TILE_ID} />);
    const trigger = screen.getByRole("button", { name: "Metric details" });

    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });

    const dialog = await screen.findByRole("dialog", {
      name: "Metric details",
    });
    const text = dialog.textContent ?? "";
    expect(text).toContain("From session logs");
    expect(text).toContain(PR_SIZE_CLOUD_READ);
    // The claim above is this absence assertion's positive control on the same
    // popover: it fails if it stops opening or stops rendering `how`, so the cap
    // cannot come back under a vacuous pass.
    expect(text).not.toContain(PR_SIZE_DESKTOP_GATE);
    expect(text).not.toMatch(CAP_POPULATION_CLAIM);
  });

  it.each(RECORD_SOURCED_CHART_TILE_IDS)(
    "renders record-sourced provenance for %s, under the fixed heading (ISS-6845)",
    async (tileId) => {
      render(<InfoTip tileId={tileId} />);
      const trigger = screen.getByRole("button", { name: "Metric details" });

      fireEvent.pointerEnter(trigger, { pointerType: "mouse" });

      const dialog = await screen.findByRole("dialog", {
        name: "Metric details",
      });
      const text = dialog.textContent ?? "";
      expect(text).toContain("From session logs");
      expect(text).toContain("own record");
      expect(text).not.toMatch(SESSION_SOURCED_CHART_ATTRIBUTE);
    }
  );

  it("renders the time-to-merge provenance for the lifespan bands, under the fixed heading (ISS-6845)", async () => {
    render(<InfoTip tileId={BRANCH_LIFESPAN_TILE_ID} />);
    const trigger = screen.getByRole("button", { name: "Metric details" });

    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });

    const dialog = await screen.findByRole("dialog", {
      name: "Metric details",
    });
    const text = dialog.textContent ?? "";
    expect(text).toContain("From session logs");
    // The cloud producer claim, and the band edges that are the only thing this
    // chart does not share with the Time-to-merge distribution.
    expect(text).toContain("branch-creation → merge duration");
    expect(text).toContain("day-scale");
    expect(text).not.toContain("otherwise the earliest linked one");
    expect(text).not.toMatch(BRANCH_SESSION_LIFESPAN);
    expect(text).not.toMatch(AUTHORING_SESSION_ONLY);
  });

  it.each(CAPPED_PAIR_TILES)(
    "renders $tileId's own retained population, and the Other slice only on a ring (ISS-9842)",
    async ({ tileId, retained, ring }) => {
      render(<InfoTip tileId={tileId} />);
      const trigger = screen.getByRole("button", { name: "Metric details" });

      fireEvent.pointerEnter(trigger, { pointerType: "mouse" });

      const dialog = await screen.findByRole("dialog", {
        name: "Metric details",
      });
      const text = dialog.textContent ?? "";
      expect(text).toContain(retained);
      // Asserted against the WHOLE popover so the ring's residual sentence
      // cannot reach a bar tile through a field this test does not name.
      if (ring) {
        expect(text).toMatch(RING_RESIDUAL_CLAIM);
      } else {
        expect(text).not.toMatch(RING_RESIDUAL_CLAIM);
      }
    }
  );

  it("never renders the scan cap on the uncapped merged-PR count (ISS-6849)", async () => {
    // The headline "Merged PRs" count is the shared fold's exact
    // uncapped count (ISS-12408), so the cap stated on IT is the mirror-image
    // false claim — and the one a reader is likeliest to open first.
    render(<InfoTip tileId={KNOWN_TILE_ID} />);
    const trigger = screen.getByRole("button", { name: "Metric details" });

    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });

    const dialog = await screen.findByRole("dialog", {
      name: "Metric details",
    });
    expect(dialog.textContent).not.toMatch(CAP_POPULATION_CLAIM);
  });
});

/**
 * ISS-11589 (davetho review, #8799): `kpi:pr-size` dropped out of the
 * registry-derived `CAP_TILE_IDS` above when its cloud sentence lost the
 * 25,000-row clause, and that inventory held its only rendered case — the
 * catalog suite renders nothing. Driven on its own so leaving the cap family
 * cannot take the tile's rendered coverage with it.
 */
const PR_SIZE_TILE_ID = "kpi:pr-size";
const PR_SIZE_CLOUD_READ = "it reads the merged-PR rows in the range";
const PR_SIZE_DESKTOP_GATE =
  "dropping any PR it only ever saw reviewed or only ever saw mentioned in prose";
