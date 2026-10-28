import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UnavailableValue, WidgetUnavailable } from "../unavailable";

describe("UnavailableValue", () => {
  it("renders the NO_VALUE glyph as an aria-hidden dash and the reason as visible text", () => {
    render(<UnavailableValue reason="Rollup read failed" />);

    const dash = screen.getByText("—");
    expect(dash).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("Rollup read failed")).toBeInTheDocument();
  });
});

describe("WidgetUnavailable", () => {
  it("renders the NO_VALUE glyph as an aria-hidden inline span and the reason as visible text", () => {
    render(<WidgetUnavailable reason="No sessions in this window" />);

    const dash = screen.getByText("—");
    expect(dash).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("No sessions in this window")).toBeInTheDocument();
  });
});
