import {
  CategoryBarChart,
  type CategoryDatum,
} from "@repo/design-system/components/ui/category-bar-chart";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ControlledCategoryBarChart } from "./category-bar-chart-test-utils";

vi.mock("recharts", async () => {
  const { createCategoryBarChartRechartsMock } = await vi.importActual<
    typeof import("./category-bar-chart-test-utils")
  >("./category-bar-chart-test-utils");
  return createCategoryBarChartRechartsMock();
});

const data: CategoryDatum[] = [
  { key: "2026-01-01", label: "01/01", value: 5 },
  { key: "2026-02-01", label: "02/01", value: 9 },
  { key: "2027-01-01", label: "01/01", value: 7 },
];
const CLICK_FEBRUARY_BUCKET_NAME = /Click 02\/01/;

describe("CategoryBarChart tracker", () => {
  it("calls onDatumClick with the clicked datum and renders the selected tracker", () => {
    const onDatumClick = vi.fn();

    render(
      <CategoryBarChart
        data={data}
        onDatumClick={onDatumClick}
        selectedKey="2026-02-01"
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: CLICK_FEBRUARY_BUCKET_NAME })
    );

    expect(onDatumClick).toHaveBeenCalledWith(data[1]);
    expect(screen.getByTestId("tracker-line")).toHaveAttribute(
      "data-x",
      "2026-02-01"
    );
  });

  it("moves the controlled tracker on repeated first-click selections", () => {
    render(<ControlledCategoryBarChart data={data} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Click 01/01 2026-01-01" })
    );
    expect(screen.getByTestId("tracker-line")).toHaveAttribute(
      "data-x",
      "2026-01-01"
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Click 01/01 2027-01-01" })
    );
    expect(screen.getByTestId("tracker-line")).toHaveAttribute(
      "data-x",
      "2027-01-01"
    );
  });

  it("uses datum keys for duplicate labels and ignores label-like selected keys", () => {
    const { rerender } = render(
      <CategoryBarChart data={data} selectedKey="2027-01-01" />
    );

    expect(screen.getByTestId("tracker-line")).toHaveAttribute(
      "data-x",
      "2027-01-01"
    );

    rerender(<CategoryBarChart data={data} selectedKey="01/01" />);

    expect(screen.queryByTestId("tracker-line")).not.toBeInTheDocument();
  });

  it("uses activeTooltipIndex-only events for first-click and repeated-click selections", () => {
    const onDatumClick = vi.fn();

    render(<CategoryBarChart data={data} onDatumClick={onDatumClick} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Click 01/01 2026-01-01" })
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Click 01/01 2027-01-01" })
    );

    expect(onDatumClick).toHaveBeenNthCalledWith(1, data[0]);
    expect(onDatumClick).toHaveBeenNthCalledWith(2, data[2]);
  });

  it("does not call onDatumClick for ambiguous or missing click payloads", () => {
    const onDatumClick = vi.fn();

    render(<CategoryBarChart data={data} onDatumClick={onDatumClick} />);

    fireEvent.click(screen.getByRole("button", { name: "Missing payload" }));
    fireEvent.click(screen.getByRole("button", { name: "Ambiguous payload" }));

    expect(onDatumClick).not.toHaveBeenCalled();
  });

  it("prefers an unambiguous payload over the tooltip index fallback", () => {
    const onDatumClick = vi.fn();

    render(<CategoryBarChart data={data} onDatumClick={onDatumClick} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Payload wins over index" })
    );

    expect(onDatumClick).toHaveBeenCalledWith(data[2]);
  });

  it("preserves absent-prop category chart rendering without a tracker", () => {
    render(<CategoryBarChart data={data} />);

    expect(screen.getByTestId("category-bar-chart")).toBeInTheDocument();
    expect(screen.queryByTestId("tracker-line")).not.toBeInTheDocument();
  });
});
