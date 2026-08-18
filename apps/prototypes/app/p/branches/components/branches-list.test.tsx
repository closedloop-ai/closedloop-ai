// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { buildGeneratedBranchFixture } from "./branch-list-fixtures";
import { BranchesList } from "./branches-list";

describe("BranchesList accessibility", () => {
  it("keeps one hidden page heading and a named, focusable overflow region", () => {
    render(<BranchesList onOpenDetail={vi.fn()} />);

    const headings = screen.getAllByRole("heading", {
      level: 1,
      name: "Branches",
    });
    expect(headings).toHaveLength(1);
    expect(headings[0]?.classList.contains("sr-only")).toBe(true);

    const region = screen.getByRole("region", { name: "Branches" });
    expect(region.tabIndex).toBe(0);
    expect(region.classList.contains("min-h-0")).toBe(true);
    expect(region.classList.contains("flex-1")).toBe(true);
    expect(region.classList.contains("overflow-auto")).toBe(true);

    region.focus();
    expect(document.activeElement).toBe(region);
  });

  it("keeps pre-pagination cards stable while exact 20-row pages change", () => {
    const fixture = buildGeneratedBranchFixture(47);
    render(
      <BranchesList
        evidence={fixture.evidence}
        onOpenDetail={vi.fn()}
        rows={fixture.rows}
      />
    );
    const spendCard = screen
      .getByText("AI spend")
      .closest("[data-slot='card']");
    const spendBefore = spendCard?.textContent;

    expect(screen.getByText("1–20 of 47")).not.toBeNull();
    fireEvent.click(screen.getByLabelText("Go to next page"));

    expect(screen.getByText("21–40 of 47")).not.toBeNull();
    expect(
      screen.getByText("AI spend").closest("[data-slot='card']")?.textContent
    ).toBe(spendBefore);
  });

  it("updates the table, cards, and pager from one real date control", () => {
    const fixture = buildGeneratedBranchFixture(21);
    const rows = fixture.rows.map((row, index) =>
      index === 0 ? { ...row, lastActivityAt: "2026-07-10T12:00:00.000Z" } : row
    );
    render(
      <BranchesList
        evidence={fixture.evidence}
        onOpenDetail={vi.fn()}
        rows={rows}
      />
    );
    const activeBefore = screen
      .getByText("Active branches")
      .closest("[data-slot='card']")?.textContent;

    expect(screen.getByText("1–20 of 21")).not.toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Last 7 days" }));

    expect(screen.getByText("1–20 of 20")).not.toBeNull();
    expect(screen.queryByLabelText("Go to next page")).toBeNull();
    expect(
      screen.getByText("Active branches").closest("[data-slot='card']")
        ?.textContent
    ).not.toBe(activeBefore);
    expect(
      screen.queryByRole("button", { name: "agent/generated-branch-001" })
    ).toBeNull();
  });

  it.each([
    [100, 4, "81–100 of 100", "agent/generated-branch-100"],
    [101, 5, "101–101 of 101", "agent/generated-branch-101"],
  ])("renders the final fixed page for the %s-row fixture", (count, nextClicks, range, finalRow) => {
    const fixture = buildGeneratedBranchFixture(count);
    render(
      <BranchesList
        evidence={fixture.evidence}
        onOpenDetail={vi.fn()}
        rows={fixture.rows}
      />
    );

    for (let index = 0; index < nextClicks; index += 1) {
      fireEvent.click(screen.getByLabelText("Go to next page"));
    }

    expect(screen.getByText(range)).not.toBeNull();
    expect(screen.getByRole("button", { name: finalRow })).not.toBeNull();
    expect(screen.getByText("AI spend")).not.toBeNull();
  });
});
