import type { InsightsSection } from "@repo/api/src/types/insights";
import { InsightsSection as InsightsSectionValues } from "@repo/api/src/types/insights";
import { describe, expect, it } from "vitest";
import type { InsightsSectionData } from "../../tile-content";
import {
  DashboardRowState,
  isRowFailed,
  isRowLoading,
  isRowStale,
  ROW_SECTIONS,
  recentSessionsAnchorRow,
  resolveDashboardRowState,
  visibleDashboardRows,
} from "../dashboard-row-sections";
import {
  DASHBOARD_ROWS,
  type DashboardRow,
  DashboardRowTour,
} from "../dashboard-tiles";

/**
 * ISS-6673 — `isRowLoading` under keys it does not recognise.
 *
 * The interesting cases are the two lookups that can miss despite their
 * `Record<…>` types: a row whose `tour` has no section dependencies declared,
 * and a declared section with no entry in the loading map. Neither is reachable
 * from the call sites in this repo today — see the backstop note on
 * `isRowLoading` — so these cases pin the DEFENSIVE contract: neither may
 * crash, and neither may resolve to "loaded", which would render the row's
 * content against data that never arrived.
 *
 * Every case below has a sibling in the opposite state, so a helper that simply
 * always returned `true` (or always `false`) fails.
 */

const ALL_SETTLED: Record<InsightsSection, boolean> = {
  [InsightsSectionValues.Delivery]: false,
  [InsightsSectionValues.Utilization]: false,
  [InsightsSectionValues.Agents]: false,
};

// `models` reads from Agents alone, which makes it the cleanest row for probing
// a single dependency. Written out here rather than looked up from
// ROW_SECTIONS: deriving the fixture from the table under test would let a
// wrong table satisfy its own assertions.
const MODELS_ROW: DashboardRow = { tour: "models", tileIds: [] };

describe("isRowLoading", () => {
  it("reports a settled row as loaded, and the same row as loading while its section is in flight", () => {
    // The pair that makes every negative assertion below meaningful: the helper
    // does consult the map, in both directions.
    expect(isRowLoading(MODELS_ROW, ALL_SETTLED)).toBe(false);
    expect(
      isRowLoading(MODELS_ROW, {
        ...ALL_SETTLED,
        [InsightsSectionValues.Agents]: true,
      })
    ).toBe(true);
  });

  it("keeps a row loading when its section is missing from the loading map", () => {
    // The false-zero shape. `sectionLoading[Agents]` is `undefined` here, which
    // is falsy — the pre-ISS-6673 helper read that as "settled" and let the row
    // render its content against a section that had not arrived, so a reader
    // could not tell a still-loading widget from one that legitimately has no
    // data. An absent entry is an unknown state, not a settled one.
    const missingAgents = {
      [InsightsSectionValues.Delivery]: false,
      [InsightsSectionValues.Utilization]: false,
    } as Record<InsightsSection, boolean>;

    expect(isRowLoading(MODELS_ROW, missingAgents)).toBe(true);
    // Scoped to the row that actually depends on the missing section: a blanket
    // "everything is loading" would also satisfy the line above.
    expect(isRowLoading({ tour: "prs", tileIds: [] }, missingAgents)).toBe(
      false
    );
  });

  it("keeps an unrecognised row loading instead of throwing", () => {
    // `deps` is `undefined` for a tour with no ROW_SECTIONS entry, and the
    // pre-ISS-6673 helper called `.some` on it — a TypeError that took down the
    // whole dashboard render, not just this row.
    const unknownRow = {
      tour: "not-a-real-row",
      tileIds: [],
    } as unknown as DashboardRow;

    expect(() => isRowLoading(unknownRow, ALL_SETTLED)).not.toThrow();
    expect(isRowLoading(unknownRow, ALL_SETTLED)).toBe(true);
  });
});

/**
 * ISS-10408 — `isRowFailed`, the fact `sectionLoading` cannot carry.
 *
 * `sectionLoading` is built as `!isSuccess`, so a terminally errored section is
 * indistinguishable from a pending one there. Before this helper the desktop
 * shell had no need to tell them apart, because ANY errored section replaced
 * the whole page; now that a failure degrades only its own rows, a shell that
 * asked `isRowLoading` alone would skeleton those rows for the life of the
 * window — a placeholder that can never resolve.
 */
describe("isRowFailed", () => {
  const NONE_FAILED: Record<InsightsSection, boolean> = {
    [InsightsSectionValues.Delivery]: false,
    [InsightsSectionValues.Utilization]: false,
    [InsightsSectionValues.Agents]: false,
  };

  it("reports a row failed only when a section it reads from failed", () => {
    // Both directions, so a helper hardwired either way fails.
    expect(isRowFailed(MODELS_ROW, NONE_FAILED)).toBe(false);
    expect(
      isRowFailed(MODELS_ROW, {
        ...NONE_FAILED,
        [InsightsSectionValues.Agents]: true,
      })
    ).toBe(true);
  });

  it("leaves rows that read from a healthy section alone", () => {
    // The whole point of the split: one failed section must not take the rows
    // that never depended on it. `prs` reads Delivery, `models` reads Agents.
    const agentsFailed = {
      ...NONE_FAILED,
      [InsightsSectionValues.Agents]: true,
    };

    expect(isRowFailed({ tour: "prs", tileIds: [] }, agentsFailed)).toBe(false);
    expect(isRowFailed(MODELS_ROW, agentsFailed)).toBe(true);
  });

  it("does not call an unrecognised row failed, leaving it to the loading backstop", () => {
    // "We do not recognise this row" is not "this row's data failed". Reporting
    // it failed would show the reader a retry for a read that never happened;
    // `isRowLoading` owns the unknown-key answer (ISS-6673) and still gives it.
    const unknownRow = {
      tour: "not-a-real-row",
      tileIds: [],
    } as unknown as DashboardRow;

    expect(() => isRowFailed(unknownRow, NONE_FAILED)).not.toThrow();
    expect(isRowFailed(unknownRow, NONE_FAILED)).toBe(false);
    expect(isRowLoading(unknownRow, ALL_SETTLED)).toBe(true);
  });

  it("reads an absent entry as not-failed rather than failed", () => {
    // The mirror of `isRowLoading`'s missing-entry case. An unknown state must
    // not be promoted to a terminal one: that would replace a row that is
    // merely still arriving with a permanent failure card.
    const missingAgents = {
      [InsightsSectionValues.Delivery]: false,
      [InsightsSectionValues.Utilization]: false,
    } as Record<InsightsSection, boolean>;

    expect(isRowFailed(MODELS_ROW, missingAgents)).toBe(false);
  });
});

/**
 * ISS-10408 — the row verdict as one closed value.
 *
 * The precedence is the point. `sectionLoading` is `!isSuccess`, so an errored
 * section is also "loading" there; a caller that asked loading first would
 * skeleton a row whose data can never arrive. Holding that order in the shared
 * resolver rather than in each shell is what stops the next caller getting it
 * wrong silently.
 */
describe("resolveDashboardRowState", () => {
  const NONE: Record<InsightsSection, boolean> = {
    [InsightsSectionValues.Delivery]: false,
    [InsightsSectionValues.Utilization]: false,
    [InsightsSectionValues.Agents]: false,
  };

  it("ranks a failed section above a loading one for the same row", () => {
    // Agents is BOTH not-successful and errored — the real shape of a failed
    // section, and the one a loading-first caller renders as a permanent
    // skeleton.
    const loadingAndFailed = {
      ...NONE,
      [InsightsSectionValues.Agents]: true,
    };

    expect(
      resolveDashboardRowState(MODELS_ROW, loadingAndFailed, loadingAndFailed)
    ).toBe(DashboardRowState.Failed);
  });

  it("names each of the three branches from the inputs that produce it", () => {
    const agentsPending = {
      ...NONE,
      [InsightsSectionValues.Agents]: true,
    };

    expect(resolveDashboardRowState(MODELS_ROW, NONE, NONE)).toBe(
      DashboardRowState.Ready
    );
    expect(resolveDashboardRowState(MODELS_ROW, agentsPending, NONE)).toBe(
      DashboardRowState.Loading
    );
    expect(resolveDashboardRowState(MODELS_ROW, NONE, agentsPending)).toBe(
      DashboardRowState.Failed
    );
  });
});

describe("isRowStale", () => {
  it("reports a current row as current, and the same row as stale while its section answers for the previous key", () => {
    // The pair that makes every assertion below meaningful: the helper does
    // consult the map, in both directions. ALL_SETTLED reads as "no section is
    // stale" here — the map is the same shape, the fact is the other one.
    expect(isRowStale(MODELS_ROW, ALL_SETTLED)).toBe(false);
    expect(
      isRowStale(MODELS_ROW, {
        ...ALL_SETTLED,
        [InsightsSectionValues.Agents]: true,
      })
    ).toBe(true);
  });

  it("is independent of isRowLoading for the same input", () => {
    // ISS-10414's whole shape: `keepPreviousData` reports settled success, so
    // the row is NOT loading and renders its content — with the previous key's
    // numbers. A helper that merely aliased the loading fact could not tell the
    // two apart, and this is the input where they disagree.
    const agentsServingPreviousKey = {
      ...ALL_SETTLED,
      [InsightsSectionValues.Agents]: true,
    };

    expect(isRowLoading(MODELS_ROW, ALL_SETTLED)).toBe(false);
    expect(isRowStale(MODELS_ROW, agentsServingPreviousKey)).toBe(true);
  });

  it("marks only the rows that read from the stale section", () => {
    // The recorded defect: Delivery had landed the new range (PR throughput was
    // correct) while Agents had not (model cost was still last quarter's). A
    // blanket "everything is stale" would paint the settled row too, which is
    // the FEA-4020 noise complaint; a blanket "nothing" is the defect itself.
    const agentsStale = {
      ...ALL_SETTLED,
      [InsightsSectionValues.Agents]: true,
    };

    expect(isRowStale(MODELS_ROW, agentsStale)).toBe(true);
    expect(isRowStale({ tour: "prs", tileIds: [] }, agentsStale)).toBe(false);
  });

  it("treats a section missing from the map as current, the OPPOSITE of isRowLoading", () => {
    // The asymmetry is deliberate and is the one thing a reader of these two
    // helpers will assume wrong. Unknown-is-loading withholds a value that may
    // be wrong; unknown-is-stale would ASSERT an update that may not be running
    // and withdraw a period caption that, on this input, is still true. Falling
    // back to the shipped no-disclosure behavior degrades to today; the other
    // fold invents a claim from a missing one.
    const missingAgents = {
      [InsightsSectionValues.Delivery]: false,
      [InsightsSectionValues.Utilization]: false,
    } as Record<InsightsSection, boolean>;

    expect(isRowStale(MODELS_ROW, missingAgents)).toBe(false);
    // The sibling in the opposite state, so a helper that always returned false
    // could not satisfy this block.
    expect(
      isRowStale(MODELS_ROW, {
        ...missingAgents,
        [InsightsSectionValues.Agents]: true,
      })
    ).toBe(true);
    expect(isRowLoading(MODELS_ROW, missingAgents)).toBe(true);
  });

  it("treats an unrecognised row as current instead of throwing", () => {
    const unknownRow = {
      tour: "not-a-real-row",
      tileIds: [],
    } as unknown as DashboardRow;

    expect(() => isRowStale(unknownRow, ALL_SETTLED)).not.toThrow();
    expect(isRowStale(unknownRow, ALL_SETTLED)).toBe(false);
  });
});

describe("ROW_SECTIONS", () => {
  it("declares dependencies for every dashboard row, dropping none", () => {
    // Rows in equals rows out. `DASHBOARD_ROWS` is the independent registry of
    // what the dashboard renders; a row that reaches it without an entry here
    // is exactly the silently-dropped row this ticket is about, and it would
    // now skeleton forever rather than crash — still wrong, and this is what
    // catches it.
    const declared = Object.keys(ROW_SECTIONS).sort();
    const rendered = DASHBOARD_ROWS.map((row) => row.tour).sort();

    expect(declared).toEqual(rendered);
  });

  it("declares only real insights sections", () => {
    // A typo'd section string type-checks nowhere near as loudly as it fails at
    // runtime: it would never match a `sectionLoading` key, so its row would sit
    // in the permanent-skeleton state the fix above introduces.
    const known = new Set<string>(Object.values(InsightsSectionValues));
    const used = new Set(Object.values(ROW_SECTIONS).flat());

    expect([...used].filter((section) => !known.has(section))).toEqual([]);
  });
});

// ISS-9993 — the one rule both hosts use to decide which rows exist. Every
// fixture and expected row list below is written out by hand, never derived
// from the rule table, so a wrong table cannot satisfy its own assertions.

const GATES_OPEN = { agentCollaborationNetwork: true };
const EMPTY_SERIES = { series: [], points: [] };
const PIPELINE_NODE = { id: "researcher", label: "researcher", value: 4 };

type ChartsBySection = {
  [InsightsSectionValues.Utilization]: Record<string, unknown>;
  [InsightsSectionValues.Agents]: Record<string, unknown>;
};

function sectionsWith(charts: ChartsBySection): InsightsSectionData {
  return {
    [InsightsSectionValues.Delivery]: { kpis: [], charts: {} },
    [InsightsSectionValues.Utilization]: {
      kpis: [],
      charts: charts[InsightsSectionValues.Utilization],
    },
    [InsightsSectionValues.Agents]: {
      kpis: [],
      charts: charts[InsightsSectionValues.Agents],
    },
  } as unknown as InsightsSectionData;
}

function allCharts(): ChartsBySection {
  return {
    [InsightsSectionValues.Utilization]: {
      activityHeatmap: { days: [], cells: [] },
    },
    [InsightsSectionValues.Agents]: {
      autonomyTrend: EMPTY_SERIES,
      frustrationTrend: EMPTY_SERIES,
      agentPipeline: { nodes: [PIPELINE_NODE], edges: [] },
    },
  };
}

const ALL_DATA = sectionsWith(allCharts());
const NO_DATA = sectionsWith({
  [InsightsSectionValues.Utilization]: {},
  [InsightsSectionValues.Agents]: {},
});

const EVERY_ROW = [
  DashboardRowTour.Stats,
  DashboardRowTour.Activity,
  DashboardRowTour.Models,
  DashboardRowTour.AgentPipeline,
  DashboardRowTour.Autonomy,
  DashboardRowTour.Frustration,
  DashboardRowTour.Prs,
  DashboardRowTour.Distribution,
];

// Each data-conditional row, the section that carries its data, and the one
// chart field whose absence drops it.
const DATA_CONDITIONAL_ROWS = [
  [
    DashboardRowTour.Activity,
    InsightsSectionValues.Utilization,
    "activityHeatmap",
  ],
  [
    DashboardRowTour.AgentPipeline,
    InsightsSectionValues.Agents,
    "agentPipeline",
  ],
  [DashboardRowTour.Autonomy, InsightsSectionValues.Agents, "autonomyTrend"],
  [
    DashboardRowTour.Frustration,
    InsightsSectionValues.Agents,
    "frustrationTrend",
  ],
] as const;

function tours(
  sections: InsightsSectionData,
  sectionLoading: Record<InsightsSection, boolean> = ALL_SETTLED,
  gates = GATES_OPEN
): string[] {
  return visibleDashboardRows({ gates, sections, sectionLoading }).map(
    (row) => row.tour
  );
}

describe("visibleDashboardRows", () => {
  it("keeps every row, in catalog order, when every row has its data", () => {
    expect(tours(ALL_DATA)).toEqual(EVERY_ROW);
  });

  it("drops only the data-conditional rows once their sections settle with no data", () => {
    expect(tours(NO_DATA)).toEqual([
      DashboardRowTour.Stats,
      DashboardRowTour.Models,
      DashboardRowTour.Prs,
      DashboardRowTour.Distribution,
    ]);
  });

  it.each(DATA_CONDITIONAL_ROWS)(
    "drops %s, and no other row, when only its own data is missing",
    (tour, section, chart) => {
      const charts = allCharts();
      Reflect.deleteProperty(charts[section], chart);

      expect(tours(sectionsWith(charts))).toEqual(
        EVERY_ROW.filter((row) => row !== tour)
      );
    }
  );

  it.each(DATA_CONDITIONAL_ROWS)(
    "keeps %s while its section is still loading, so the layout does not reflow",
    (tour, section) => {
      expect(tours(NO_DATA, { ...ALL_SETTLED, [section]: true })).toContain(
        tour
      );
    }
  );

  it("drops the agent-pipeline row when the graph has no nodes", () => {
    const charts = allCharts();
    charts[InsightsSectionValues.Agents].agentPipeline = {
      nodes: [],
      edges: [],
    };

    expect(tours(sectionsWith(charts))).not.toContain(
      DashboardRowTour.AgentPipeline
    );
  });

  it("drops a gated-off row even when its data is present", () => {
    expect(
      tours(ALL_DATA, ALL_SETTLED, { agentCollaborationNetwork: false })
    ).toEqual(
      EVERY_ROW.filter((row) => row !== DashboardRowTour.AgentPipeline)
    );
  });
});

describe("recentSessionsAnchorRow", () => {
  it("anchors under the activity row when it is shown, and under stats when it is not", () => {
    expect(recentSessionsAnchorRow(visibleDashboardRows(ALL_VISIBLE))).toBe(
      DashboardRowTour.Activity
    );
    expect(recentSessionsAnchorRow(visibleDashboardRows(NONE_VISIBLE))).toBe(
      DashboardRowTour.Stats
    );
  });
});

const ALL_VISIBLE = {
  gates: GATES_OPEN,
  sections: ALL_DATA,
  sectionLoading: ALL_SETTLED,
};
const NONE_VISIBLE = { ...ALL_VISIBLE, sections: NO_DATA };
