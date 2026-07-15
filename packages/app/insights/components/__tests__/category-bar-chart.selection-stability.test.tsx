import {
  CategoryBarChart,
  type CategoryDatum,
} from "@repo/design-system/components/ui/category-bar-chart";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ControlledCategoryBarChart } from "./category-bar-chart-test-utils";

// Recharts keys the bar enter-animation off the `data` prop's reference
// identity (useAnimationId). If CategoryBarChart rebuilds that array on every
// render, the bars re-animate — and visibly jump — whenever selection changes
// (FEA-2499). We capture the reference recharts receives on each render to
// assert it stays stable across a selection-only re-render.
const { receivedData } = vi.hoisted(() => ({
  receivedData: [] as CategoryDatum[][],
}));

vi.mock("recharts", async () => {
  const { createCategoryBarChartRechartsMock } = await vi.importActual<
    typeof import("./category-bar-chart-test-utils")
  >("./category-bar-chart-test-utils");
  return createCategoryBarChartRechartsMock({
    onData: (data) => {
      receivedData.push(data);
    },
  });
});

const data: CategoryDatum[] = [
  { key: "2026-01-01", label: "01/01", value: 5 },
  { key: "2026-02-01", label: "02/01", value: 9 },
  { key: "2026-03-01", label: "03/01", value: 7 },
];

describe("CategoryBarChart selection stability (FEA-2499)", () => {
  it("keeps the bar data reference stable when only selection changes", () => {
    receivedData.length = 0;
    render(<ControlledCategoryBarChart data={data} />);

    const firstRenderData = receivedData.at(-1);

    fireEvent.click(
      screen.getByRole("button", { name: "Click 02/01 2026-02-01" })
    );

    // Selection moved (tracker rendered on the clicked datum)...
    expect(screen.getByTestId("tracker-line")).toHaveAttribute(
      "data-x",
      "2026-02-01"
    );
    // ...but the array handed to recharts is the same reference, so recharts
    // does not re-run its bar enter-animation (no jump).
    expect(receivedData.length).toBeGreaterThan(1);
    expect(receivedData.at(-1)).toBe(firstRenderData);
  });

  it("recomputes the bar data only when the data prop changes", () => {
    receivedData.length = 0;
    const { rerender } = render(<CategoryBarChart data={data} />);
    const firstRenderData = receivedData.at(-1);

    // Same data reference on re-render -> same colored array (no re-animation).
    rerender(<CategoryBarChart data={data} />);
    expect(receivedData.at(-1)).toBe(firstRenderData);

    // New data reference -> recomputed colored array (enter animation allowed).
    const nextData = data.map((datum) => ({ ...datum }));
    rerender(<CategoryBarChart data={nextData} />);
    expect(receivedData.at(-1)).not.toBe(firstRenderData);
  });
});
