import { MetricCard } from "@closedloop-ai/design-system/components/ui/primitives/metric-card";
import { MetricPolarity } from "@closedloop-ai/design-system/components/ui/primitives/metric-polarity";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

const SERIES = [3, 5, 4, 8, 9, 12];

function sparklineMarks(
  container: HTMLElement
): NodeListOf<SVGPolylineElement> {
  // The sparkline is the only `polyline` this card can draw — the directional
  // fallbacks are lucide `path` glyphs — so this counts marks, not shapes.
  return container.querySelectorAll("svg polyline");
}

/** An isolated measured bucket, drawn as its own round line cap. */
function sparklineDots(container: HTMLElement): NodeListOf<SVGCircleElement> {
  return container.querySelectorAll("svg circle");
}

function standaloneCard(series: readonly (number | null)[]) {
  return render(
    <MetricCard
      label="AI spend"
      sparkline={series}
      sparklineWithoutDelta
      value="$1,204"
    />
  );
}

/** The card's own mark width (`SPARKLINE_WIDTH`), spanned by every slot. */
const MARK_WIDTH = 26;

describe("MetricCard standalone sparkline (ISS-10363)", () => {
  it("draws the series with no delta once the consumer opts in", () => {
    const { container } = render(
      <MetricCard
        label="AI spend"
        sparkline={SERIES}
        sparklineWithoutDelta
        value="$1,204"
      />
    );
    expect(sparklineMarks(container)).toHaveLength(1);
    expect(screen.getByText("Trend across the period")).toBeTruthy();
  });

  it("draws nothing extra for a consumer that has not opted in", () => {
    // The shipped render, and the reason the opt-in exists: this primitive's
    // other surfaces pass a series on their no-comparison arm too, and they get
    // no pixel of movement from this change.
    const { container } = render(
      <MetricCard label="AI spend" sparkline={SERIES} value="$1,204" />
    );
    expect(sparklineMarks(container)).toHaveLength(0);
    expect(screen.queryByText("Trend across the period")).toBeNull();
  });

  it("keeps the no-comparison placeholder beside the mark", () => {
    // Both operands are absent-or-present independently, so the card states both
    // rather than letting the mark stand in for a comparison it is not.
    const { container } = render(
      <MetricCard
        deltaPlaceholder={<span>No comparison</span>}
        label="AI spend"
        sparkline={SERIES}
        sparklineWithoutDelta
        value="$1,204"
      />
    );
    expect(sparklineMarks(container)).toHaveLength(1);
    expect(screen.getByText("No comparison")).toBeTruthy();
  });

  it("draws one mark, not two, when a numeric delta is present", () => {
    // With a chip the mark belongs INSIDE it; the standalone slot must not add
    // a second line for the same series.
    const { container } = render(
      <MetricCard
        delta={12}
        deltaPolarity={MetricPolarity.HigherIsBetter}
        label="AI spend"
        sparkline={SERIES}
        sparklineWithoutDelta
        value="$1,204"
      />
    );
    expect(sparklineMarks(container)).toHaveLength(1);
    expect(screen.queryByText("Trend across the period")).toBeNull();
  });

  it("holds an uncomputable bucket's slot instead of closing the line over it", () => {
    // ISS-10363 (whitlockk review on #7448): `null` is the contract for a bucket the
    // producer could not compute. Filtering it out drew [10, null, 30] as one
    // uninterrupted full-width rise — a claim about the period we did not
    // measure, built from the two we did. The two measured buckets keep their
    // own x slots and nothing is drawn across the gap.
    const { container } = standaloneCard([10, null, 30]);
    expect(sparklineMarks(container)).toHaveLength(0);
    const dots = sparklineDots(container);
    expect(dots).toHaveLength(2);
    expect(Array.from(dots, (dot) => dot.getAttribute("cx"))).toEqual([
      "0.0",
      MARK_WIDTH.toFixed(1),
    ]);
  });

  it("spaces a run by its slots, not by its rank among the known buckets", () => {
    // Four slots, the last unmeasured: the drawn run must end at the THIRD
    // slot's x, not be re-spread across the full width as if it were the series.
    const { container } = standaloneCard([10, 20, 30, null]);
    const marks = sparklineMarks(container);
    expect(marks).toHaveLength(1);
    expect(sparklineDots(container)).toHaveLength(0);
    const xs = (marks[0].getAttribute("points") ?? "")
      .split(" ")
      .map((point) => point.split(",")[0]);
    expect(xs).toEqual(["0.0", "8.7", "17.3"]);
  });

  it("draws nothing for a series with one finite point", () => {
    // One point is a dot, not a trend, and a gap-only series is an absent
    // series — neither may be dressed up as a line.
    const { container } = render(
      <MetricCard
        label="AI spend"
        sparkline={[null, 5, null]}
        sparklineWithoutDelta
        value="$1,204"
      />
    );
    expect(sparklineMarks(container)).toHaveLength(0);
    expect(screen.queryByText("Trend across the period")).toBeNull();
  });
});
