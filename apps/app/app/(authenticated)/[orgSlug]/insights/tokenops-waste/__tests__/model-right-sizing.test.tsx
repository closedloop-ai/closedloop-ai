import {
  MODEL_VERDICT_LABELS,
  type ModelRightSizingRow,
  ModelVerdict,
} from "@repo/api/src/types/session-analytics";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ModelRightSizing } from "../components/model-right-sizing";
import { WidgetState } from "../components/widget-state";

/**
 * The model right-sizing table's appearance contract (ISS-4988), raised in
 * review (comment 3709116967): a four-way verdict mapping sits on top of a
 * six-column numeric table, and nothing rendered the four tones side by side,
 * so a tone swap could ship silently.
 *
 * A DOM test cannot judge whether the four colors READ as distinct — that needs
 * a story and a designer's eye. What it CAN pin is that the mapping is total,
 * that no two verdicts collapse onto the same tone, and that the ungraded row's
 * dash stays a different thing from a real `$0.00`.
 */

const NO_VALUE_DASH = "—";

// Module-level per the repo's useTopLevelRegex rule.
const NEEDS_12_TO_GRADE = /needs 12 sessions to grade/i;
const FEWER_THAN_12 = /fewer than 12 sessions/i;
const TOO_FEW_UNQUANTIFIED = /too few sessions to grade/i;
const ANY_NEEDS_12 = /needs 12 sessions/i;
const UNGRADED_DASH = new RegExp(`${NO_VALUE_DASH} needs 12 sessions`);
const REAL_ZERO_CONFIDENCE = /0% of cost ended in error/i;
const MODELS_UNAVAILABLE = /no model can be graded/i;
const MODELS_EMPTY = /no model cost in this range/i;
const JOB_SIZE_HEADER = /median job size \(tokens\)/i;
const FIRST_PASS_BASIS = /job size counts first-pass tokens only/i;
const BILLED_BASIS = /divides cost by every billed token/i;
const NOT_A_RATE = /do not divide into a rate/i;
const OLD_API_ROW = /old-api/;
const NEW_API_ROW = /new-api/;

/** Model, Spend, Ended with error, Sessions, Median job size, Verdict. */
const JOB_SIZE_CELL_INDEX = 4;
/** A billed median far from any work median below, so a fallback is visible. */
const BILLED_MEDIAN = 2_000_000;
const WORK_MEDIAN = 48_000;
const WORK_MEDIAN_RENDERED = "48k";

/** Variant → the text-color class `ToneLabel` renders for it. */
const TONE_CLASS_BY_VARIANT: Record<string, string> = {
  error: "text-destructive",
  muted: "text-muted-foreground",
  success: "text-success-foreground",
  warning: "text-warning-foreground",
};

function modelRow(
  overrides: Partial<ModelRightSizingRow> = {}
): ModelRightSizingRow {
  return {
    confidencePct: 20,
    errorOutcomeUsd: 5,
    medianTokens: 240_000,
    medianWorkTokens: 120_000,
    model: "claude-sonnet-4.6",
    sessions: 40,
    usd: 100,
    usdPerSession: 2.5,
    verdict: ModelVerdict.RightSized,
    ...overrides,
  };
}

/**
 * The shape an `apps/api` build that predates `medianWorkTokens` sends: the key
 * is genuinely ABSENT, not present-and-undefined, which is what the wire
 * actually produces once the field is omitted from the JSON.
 */
function rowWithoutWorkMedian(
  overrides: Partial<ModelRightSizingRow> = {}
): ModelRightSizingRow {
  const { medianWorkTokens: _absent, ...rest } = modelRow(overrides);
  return rest;
}

const ALL_VERDICTS: ModelRightSizingRow[] = [
  modelRow({ model: "over", verdict: ModelVerdict.Overpowered }),
  modelRow({ model: "right", verdict: ModelVerdict.RightSized }),
  modelRow({ model: "under", verdict: ModelVerdict.Underpowered }),
  modelRow({
    confidencePct: undefined,
    model: "ungraded",
    sessions: 3,
    verdict: ModelVerdict.Ungraded,
  }),
];

describe("the model right-sizing table", () => {
  it("renders all four verdicts on their own distinct tone", () => {
    render(
      <ModelRightSizing
        minGradedSessions={12}
        models={ALL_VERDICTS}
        state={WidgetState.Ready}
      />
    );

    const seenTones = new Set<string>();
    for (const verdict of Object.values(ModelVerdict)) {
      const label = screen.getByText(MODEL_VERDICT_LABELS[verdict]);
      const tone = Object.values(TONE_CLASS_BY_VARIANT).find((cls) =>
        label.className.includes(cls)
      );
      expect(tone).toBeDefined();
      seenTones.add(tone as string);
    }
    // Four verdicts, four tones. Two verdicts sharing a color would make the
    // grading legible only by reading the label, which is the thing the tone
    // is there to save the reader from.
    expect(seenTones.size).toBe(Object.values(ModelVerdict).length);
  });

  it("names the token basis of each half of the verdict, and that they differ", () => {
    // ISS-5189: the two halves are graded on DIFFERENT token columns — job size
    // drops replayed cache reads, the price side keeps every billed token — and
    // only the first is rendered. Without this copy the reader has no way to
    // know which tokens either number counted, and dividing the two columns
    // into a rate is off by the whole cached-read volume. Pinned here because
    // it is the only thing on screen that says so.
    render(
      <ModelRightSizing
        minGradedSessions={12}
        models={ALL_VERDICTS}
        state={WidgetState.Ready}
      />
    );

    // The unit lives in the header: the cell is a bare compact number.
    expect(screen.getByText(JOB_SIZE_HEADER)).toBeInTheDocument();
    expect(screen.getByText(FIRST_PASS_BASIS)).toBeInTheDocument();
    expect(screen.getByText(BILLED_BASIS)).toBeInTheDocument();
    expect(screen.getByText(NOT_A_RATE)).toBeInTheDocument();
  });

  it("dashes the job-size cell when the work median is absent, never the billed one", () => {
    // ISS-5189 deploy skew: `apps/api` and `apps/app` are separate Vercel
    // deploy units on one push, so this build can be reading a response that
    // predates `medianWorkTokens`. The wire still carries the BILLED
    // `medianTokens` for the old client, and falling back to it would put
    // cached reads under a header and a description that both state the number
    // is first-pass — a confident false statement, which is worse than the
    // vague one this change replaced. The dash is the honest answer.
    render(
      <ModelRightSizing
        minGradedSessions={12}
        models={[
          rowWithoutWorkMedian({
            medianTokens: BILLED_MEDIAN,
            model: "old-api",
          }),
          modelRow({
            medianTokens: BILLED_MEDIAN,
            medianWorkTokens: WORK_MEDIAN,
            model: "new-api",
          }),
        ]}
        state={WidgetState.Ready}
      />
    );

    const jobSizeCell = (row: RegExp) =>
      within(screen.getByRole("row", { name: row })).getAllByRole("cell")[
        JOB_SIZE_CELL_INDEX
      ];

    // EXACT text, not `toContainText`: a fallback to the billed median would
    // put digits in this cell, and only an empty-of-value dash proves it did
    // not. Both models carry the same billed number, so a column reading the
    // retired field would render it identically on both rows.
    expect(jobSizeCell(OLD_API_ROW).textContent).toBe(NO_VALUE_DASH);
    // Anti-vacuity: the same column DOES render a work median when it is sent,
    // so the dash above is the absent case and not a column that never renders.
    expect(jobSizeCell(NEW_API_ROW).textContent).toBe(WORK_MEDIAN_RENDERED);
  });

  it("names the grading threshold it is waiting on instead of saying 'too few'", () => {
    render(
      <ModelRightSizing
        minGradedSessions={12}
        models={ALL_VERDICTS}
        state={WidgetState.Ready}
      />
    );

    expect(screen.getByText(NEEDS_12_TO_GRADE)).toBeInTheDocument();
    expect(screen.getByText(FEWER_THAN_12)).toBeInTheDocument();
  });

  it("falls back to unquantified copy when the server did not send a threshold", () => {
    // A response predating `minGradedSessions` must not have a number invented
    // for it — the render would then quote a threshold the server is not using.
    render(
      <ModelRightSizing
        minGradedSessions={undefined}
        models={ALL_VERDICTS}
        state={WidgetState.Ready}
      />
    );

    expect(screen.getByText(TOO_FEW_UNQUANTIFIED)).toBeInTheDocument();
    expect(screen.queryByText(ANY_NEEDS_12)).toBeNull();
  });

  it("keeps an ungraded dash visibly different from a real zero", () => {
    render(
      <ModelRightSizing
        minGradedSessions={12}
        models={[
          modelRow({
            confidencePct: undefined,
            model: "ungraded",
            verdict: ModelVerdict.Ungraded,
          }),
          // A real 0% means zero failed spend, which is a finding, not a gap.
          modelRow({
            confidencePct: 0,
            errorOutcomeUsd: 0,
            model: "clean",
            verdict: ModelVerdict.RightSized,
          }),
        ]}
        state={WidgetState.Ready}
      />
    );

    expect(screen.getByText(UNGRADED_DASH)).toBeInTheDocument();
    expect(screen.getByText(REAL_ZERO_CONFIDENCE)).toBeInTheDocument();
  });

  it("keeps loading, unavailable and empty as three different answers", () => {
    const { rerender } = render(
      <ModelRightSizing
        minGradedSessions={12}
        models={undefined}
        state={WidgetState.Loading}
      />
    );
    // Loading still renders the table shell, so the geometry does not jump.
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.queryByText(MODELS_UNAVAILABLE)).toBeNull();

    rerender(
      <ModelRightSizing
        minGradedSessions={12}
        models={undefined}
        state={WidgetState.Unavailable}
      />
    );
    expect(screen.getByText(MODELS_UNAVAILABLE)).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();

    rerender(
      <ModelRightSizing
        minGradedSessions={12}
        models={[]}
        state={WidgetState.Ready}
      />
    );
    const table = screen.getByRole("table");
    expect(within(table).getByText(MODELS_EMPTY)).toBeInTheDocument();
    expect(screen.queryByText(MODELS_UNAVAILABLE)).toBeNull();
  });
});
