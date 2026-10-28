import { AgentComponentInvocationKind } from "@repo/api/src/types/agent-component-invocation";
import { describe, expect, it } from "vitest";
import { buildSessionTrace } from "../../../../../lib/session-trace/build-session-trace";
import {
  collectSpanFindings,
  collectSubtreeFindings,
  formatPreviewConfirmationRate,
  formatPreviewFindingsCounts,
  formatPreviewReportingInvocations,
  formatPreviewReportingPopulation,
  PREVIEW_FINDINGS_LEDGER,
  type PreviewFindingsFunnel,
  type PreviewFindingsTotals,
  previewConfirmationRate,
  previewFindingsFor,
  rollUpPreviewFindings,
  summarisePreviewFindings,
  totalPreviewFindings,
} from "../preview-trace-findings";

import {
  DESIGN_CRITIC_ID,
  previewTraceRow,
  spanIn,
  VISUAL_QA_ID,
} from "./support/preview-trace-rows";

function totals(
  findingsEmitted: number,
  findingsInvalidated: number
): PreviewFindingsTotals {
  return {
    findingsEmitted,
    findingsInvalidated,
    findingsConfirmed: findingsEmitted - findingsInvalidated,
    reportingInvocationCount: 1,
  };
}

describe("previewFindingsFor", () => {
  it("reads the ledger entry for a reporting invocation", () => {
    expect(
      previewFindingsFor({ externalInvocationId: DESIGN_CRITIC_ID })
    ).toEqual({ findingsEmitted: 11, findingsInvalidated: 4 });
    expect(previewFindingsFor({ externalInvocationId: VISUAL_QA_ID })).toEqual({
      findingsEmitted: 6,
      findingsInvalidated: 1,
    });
  });

  it("reports nothing for an id the ledger has never heard of", () => {
    expect(previewFindingsFor({ externalInvocationId: "n1" })).toBeUndefined();
  });

  it("does not read inherited object keys as ledger entries", () => {
    expect(
      previewFindingsFor({ externalInvocationId: "constructor" })
    ).toBeUndefined();
    expect(
      previewFindingsFor({ externalInvocationId: "toString" })
    ).toBeUndefined();
    expect(Object.hasOwn(PREVIEW_FINDINGS_LEDGER, "constructor")).toBe(false);
  });
});

describe("totalPreviewFindings", () => {
  it("returns undefined for an empty set, never a row of zeroes", () => {
    expect(totalPreviewFindings([])).toBeUndefined();
  });

  it("keeps a component that looked and found nothing as a real zero", () => {
    expect(
      totalPreviewFindings([{ findingsEmitted: 0, findingsInvalidated: 0 }])
    ).toEqual({
      findingsEmitted: 0,
      findingsInvalidated: 0,
      findingsConfirmed: 0,
      reportingInvocationCount: 1,
    });
  });

  it("sums every funnel and derives confirmed from the two sums", () => {
    function* funnels(): Generator<PreviewFindingsFunnel> {
      yield { findingsEmitted: 11, findingsInvalidated: 4 };
      yield { findingsEmitted: 6, findingsInvalidated: 1 };
      yield { findingsEmitted: 2, findingsInvalidated: 2 };
    }
    expect(totalPreviewFindings(funnels())).toEqual({
      findingsEmitted: 19,
      findingsInvalidated: 7,
      findingsConfirmed: 12,
      reportingInvocationCount: 3,
    });
  });
});

describe("subtree and span-set findings", () => {
  const trace = buildSessionTrace([
    previewTraceRow("n1", 0, {
      durationMs: 10_000,
      kind: AgentComponentInvocationKind.Subagent,
    }),
    previewTraceRow(DESIGN_CRITIC_ID, 100, {
      durationMs: 4000,
      parentExternalInvocationId: "n1",
    }),
    previewTraceRow(VISUAL_QA_ID, 200, {
      durationMs: 1000,
      parentExternalInvocationId: DESIGN_CRITIC_ID,
    }),
    previewTraceRow("n30", 5000, {
      durationMs: 100,
      parentExternalInvocationId: "n1",
    }),
  ]);
  const root = spanIn(trace, "n1");
  const critic = spanIn(trace, DESIGN_CRITIC_ID);
  const leaf = spanIn(trace, "n30");

  it("collects every funnel under a span in tree order, its own first", () => {
    expect(collectSubtreeFindings(critic)).toEqual([
      { findingsEmitted: 11, findingsInvalidated: 4 },
      { findingsEmitted: 6, findingsInvalidated: 1 },
    ]);
    expect(collectSubtreeFindings(root)).toEqual([
      { findingsEmitted: 11, findingsInvalidated: 4 },
      { findingsEmitted: 6, findingsInvalidated: 1 },
    ]);
    expect(collectSubtreeFindings(leaf)).toEqual([]);
  });

  it("rolls the whole fan-out up onto a parent that reports nothing itself", () => {
    expect(rollUpPreviewFindings(root)).toEqual({
      findingsEmitted: 17,
      findingsInvalidated: 5,
      findingsConfirmed: 12,
      reportingInvocationCount: 2,
    });
    expect(rollUpPreviewFindings(leaf)).toBeUndefined();
  });

  it("sums only the spans it is handed, without descending", () => {
    expect(collectSpanFindings([root])).toBeUndefined();
    expect(collectSpanFindings([root, critic])).toEqual({
      findingsEmitted: 11,
      findingsInvalidated: 4,
      findingsConfirmed: 7,
      reportingInvocationCount: 1,
    });
    expect(collectSpanFindings([])).toBeUndefined();
  });
});

describe("summarisePreviewFindings", () => {
  it("returns undefined when no invocation in the session reports findings", () => {
    expect(summarisePreviewFindings([])).toBeUndefined();
    expect(
      summarisePreviewFindings([
        previewTraceRow("n1", 0),
        previewTraceRow("n2", null),
      ])
    ).toBeUndefined();
  });

  it("counts reporting components by kind and key, including unplaced rows", () => {
    const population = summarisePreviewFindings([
      previewTraceRow("n1", 0),
      previewTraceRow(DESIGN_CRITIC_ID, null, {
        kind: AgentComponentInvocationKind.Subagent,
        componentKey: "design-critic",
      }),
      previewTraceRow(VISUAL_QA_ID, 500, {
        kind: AgentComponentInvocationKind.Subagent,
        componentKey: "design-critic",
      }),
    ]);
    expect(population).toEqual({
      findingsEmitted: 17,
      findingsInvalidated: 5,
      findingsConfirmed: 12,
      reportingInvocationCount: 2,
      reportingComponentCount: 1,
    });
  });

  it("treats the same key under two kinds as two components", () => {
    const population = summarisePreviewFindings([
      previewTraceRow(DESIGN_CRITIC_ID, 0, {
        kind: AgentComponentInvocationKind.Subagent,
        componentKey: "review",
      }),
      previewTraceRow(VISUAL_QA_ID, 500, {
        kind: AgentComponentInvocationKind.Skill,
        componentKey: "review",
      }),
    ]);
    expect(population?.reportingComponentCount).toBe(2);
    expect(population?.reportingInvocationCount).toBe(2);
  });
});

describe("confirmation rate", () => {
  it("has no rate when nothing was emitted", () => {
    expect(previewConfirmationRate(totals(0, 0))).toBeUndefined();
    expect(formatPreviewConfirmationRate(totals(0, 0))).toBe("—");
  });

  it("divides confirmed by emitted from a single emitted finding up", () => {
    expect(previewConfirmationRate(totals(1, 0))).toBe(1);
    expect(previewConfirmationRate(totals(1, 1))).toBe(0);
    expect(previewConfirmationRate(totals(11, 4))).toBeCloseTo(0.636_363_6);
  });

  it("prints the rate as a rounded whole percentage", () => {
    expect(formatPreviewConfirmationRate(totals(11, 4))).toBe("64%");
    expect(formatPreviewConfirmationRate(totals(17, 5))).toBe("71%");
    expect(formatPreviewConfirmationRate(totals(1, 1))).toBe("0%");
    expect(formatPreviewConfirmationRate(totals(6, 0))).toBe("100%");
  });
});

describe("findings copy", () => {
  it("singularises exactly one finding", () => {
    expect(
      formatPreviewFindingsCounts({
        findingsEmitted: 1,
        findingsInvalidated: 0,
      })
    ).toBe("1 finding, 0 invalidated");
    expect(
      formatPreviewFindingsCounts({
        findingsEmitted: 0,
        findingsInvalidated: 0,
      })
    ).toBe("0 findings, 0 invalidated");
    expect(
      formatPreviewFindingsCounts({
        findingsEmitted: 11,
        findingsInvalidated: 4,
      })
    ).toBe("11 findings, 4 invalidated");
  });

  it("names the reporting-component population, singular and plural", () => {
    expect(
      formatPreviewReportingPopulation({
        ...totals(11, 4),
        reportingComponentCount: 1,
      })
    ).toBe("across 1 reporting component");
    expect(
      formatPreviewReportingPopulation({
        ...totals(11, 4),
        reportingComponentCount: 2,
      })
    ).toBe("across 2 reporting components");
  });

  it("names the reporting-invocation population, singular and plural", () => {
    expect(formatPreviewReportingInvocations(totals(3, 1))).toBe(
      "across 1 invocation"
    );
    expect(
      formatPreviewReportingInvocations({
        ...totals(3, 1),
        reportingInvocationCount: 3,
      })
    ).toBe("across 3 invocations");
  });
});
