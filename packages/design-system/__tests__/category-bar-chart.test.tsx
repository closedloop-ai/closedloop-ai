import {
  CategoryBarChart,
  type CategoryDatum,
} from "@closedloop-ai/design-system/components/ui/category-bar-chart";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Pins current behavior of `CategoryBarChart`. Recharts (3.x, Redux-backed)
 * does not compute laid-out SVG geometry under jsdom's no-layout environment,
 * but it DOES render axis ticks, bar rectangles and reference lines, so these
 * tests assert at that boundary rather than at the wrapper.
 *
 * Three props have no observable output here and are deliberately NOT covered
 * rather than covered vacuously: `showValueLabels` (LabelList needs laid-out
 * bar geometry), `colorByKey` (the bar rectangles render empty, so no `fill`
 * reaches the DOM) and `onDatumClick` (Recharts derives the active index from
 * pointer coordinates jsdom never produces, so the handler cannot be driven).
 * A test that mounts them and asserts the shared wrapper passes with the wiring
 * deleted, which is what this file used to do.
 *
 * Read-only characterization — never change `category-bar-chart.tsx` to make
 * one of these pass.
 */

afterEach(cleanup);

const DATA: CategoryDatum[] = [
  { key: "claude", label: "Claude", value: 30 },
  { key: "codex", label: "Codex", value: 10 },
];

function queryChartWrapper(container: HTMLElement) {
  return container.querySelector('[data-slot="chart"]');
}

describe("CategoryBarChart", () => {
  it("renders the default empty message for an empty data array", () => {
    const { container } = render(<CategoryBarChart data={[]} />);
    expect(screen.getByText("No data")).toBeInTheDocument();
    expect(queryChartWrapper(container)).not.toBeInTheDocument();
  });

  it("renders the empty message when every value is zero", () => {
    const { container } = render(
      <CategoryBarChart
        data={[
          { key: "a", label: "A", value: 0 },
          { key: "b", label: "B", value: 0 },
        ]}
      />
    );
    expect(screen.getByText("No data")).toBeInTheDocument();
    expect(queryChartWrapper(container)).not.toBeInTheDocument();
  });

  it("renders a custom emptyMessage in place of the default", () => {
    render(<CategoryBarChart data={[]} emptyMessage="Nothing to show yet" />);
    expect(screen.getByText("Nothing to show yet")).toBeInTheDocument();
    expect(screen.queryByText("No data")).not.toBeInTheDocument();
  });

  it("does not render the empty message for non-empty data, and renders the chart wrapper", () => {
    const { container } = render(<CategoryBarChart data={DATA} />);
    expect(screen.queryByText("No data")).not.toBeInTheDocument();
    expect(queryChartWrapper(container)).toBeInTheDocument();
  });

  it("renders the chart wrapper when only one datum has a nonzero value", () => {
    const { container } = render(
      <CategoryBarChart
        data={[
          { key: "a", label: "A", value: 0 },
          { key: "b", label: "B", value: 5 },
        ]}
      />
    );
    expect(screen.queryByText("No data")).not.toBeInTheDocument();
    expect(queryChartWrapper(container)).toBeInTheDocument();
  });

  it("hides the numeric axis in horizontal layout, keeping the category labels", () => {
    // Horizontal passes `hide` to the numeric XAxis, so its ticks stop
    // rendering while the category labels move to the YAxis. Asserting the
    // ticks is what separates the two layouts: both mount the same wrapper.
    render(<CategoryBarChart data={DATA} horizontal />);

    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.queryByText("32")).not.toBeInTheDocument();
  });

  it("renders the numeric axis ticks in the default vertical layout", () => {
    render(<CategoryBarChart data={DATA} />);

    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(screen.getByText("32")).toBeInTheDocument();
  });

  it("formats the numeric axis ticks through valueFormatter", () => {
    render(
      <CategoryBarChart data={DATA} valueFormatter={(value) => `$${value}`} />
    );

    expect(screen.getByText("$32")).toBeInTheDocument();
    // The unformatted tick must be GONE, or the formatter could be ignored and
    // this would still pass on the raw axis.
    expect(screen.queryByText("32")).not.toBeInTheDocument();
  });

  it("draws a reference line for selectedKey, and none without one", () => {
    const { container: selected } = render(
      <CategoryBarChart data={DATA} selectedKey="claude" />
    );
    expect(selected.querySelectorAll(".recharts-reference-line")).toHaveLength(
      1
    );

    cleanup();

    const { container: unselected } = render(<CategoryBarChart data={DATA} />);
    expect(
      unselected.querySelectorAll(".recharts-reference-line")
    ).toHaveLength(0);
  });

  it("allows fractional axis ticks only when allowDecimals is set", () => {
    const SMALL: CategoryDatum[] = [
      { key: "a", label: "A", value: 1 },
      { key: "b", label: "B", value: 2 },
    ];

    render(<CategoryBarChart allowDecimals data={SMALL} />);
    expect(screen.getAllByText("0.5").length).toBeGreaterThan(0);

    cleanup();

    render(<CategoryBarChart data={SMALL} />);
    expect(screen.queryAllByText("0.5")).toHaveLength(0);
  });

  it("gives the chart wrapper a stable data-chart id", () => {
    const { container } = render(<CategoryBarChart data={DATA} />);
    const wrapper = queryChartWrapper(container);
    expect(wrapper?.getAttribute("data-chart")).toBeTruthy();
  });
});
