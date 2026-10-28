import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  type ProjectOption,
  ProjectSelectPopover,
  projectSelectionValue,
} from "../project-select-popover";

// Radix Popover uses pointer-capture APIs jsdom omits; the shared setup already
// shims ResizeObserver + scrollIntoView.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {
  // no-op
};
Element.prototype.releasePointerCapture ??= () => {
  // no-op
};

const PROJECT_TRIGGER_NAME = /^Project:/;

const projects: ProjectOption[] = [
  { id: "p1", name: "Platform", slug: "platform" },
  { id: "p2", name: "Growth", slug: "growth" },
  { id: "p3", name: "Untitled", slug: null },
];

describe("ProjectSelectPopover", () => {
  it("opens the typeahead and selects a project by name", async () => {
    const onSelect = vi.fn();
    render(
      <ProjectSelectPopover
        ariaLabel="Project"
        onSelect={onSelect}
        projects={projects}
        value={null}
      />
    );

    fireEvent.click(
      screen.getByRole("combobox", { name: PROJECT_TRIGGER_NAME })
    );
    fireEvent.click(await screen.findByText("Growth"));

    expect(onSelect).toHaveBeenCalledWith({
      id: "p2",
      name: "Growth",
      slug: "growth",
    });
  });

  it("lists projects alphabetically regardless of input order", async () => {
    // The tied pair arrives p5 before p2, so only the id tiebreak (not a stable
    // sort) puts p2 first; the slugs make the two rows distinguishable.
    const unsorted: ProjectOption[] = [
      { id: "p1", name: "platform" },
      { id: "p5", name: "Growth", slug: "growth-b" },
      { id: "p3", name: "Apollo" },
      { id: "p2", name: "Growth", slug: "growth-a" },
      { id: "p4", name: "Zeta" },
    ];
    render(
      <ProjectSelectPopover
        onSelect={vi.fn()}
        projects={unsorted}
        value={null}
      />
    );

    fireEvent.click(screen.getByRole("combobox"));
    await screen.findByText("Apollo");

    expect(
      screen.getAllByRole("option").map((option) => option.textContent)
    ).toEqual([
      "Apollo",
      "Growthgrowth-a",
      "Growthgrowth-b",
      "platform",
      "Zeta",
    ]);
  });

  it("filters the options by the typed query", async () => {
    render(
      <ProjectSelectPopover
        onSelect={vi.fn()}
        projects={projects}
        value={null}
      />
    );

    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.change(await screen.findByPlaceholderText("Search projects…"), {
      target: { value: "grow" },
    });

    expect(screen.getByText("Growth")).toBeDefined();
    expect(screen.queryByText("Platform")).toBeNull();
  });

  it("shows the empty state when there are no projects", async () => {
    render(
      <ProjectSelectPopover onSelect={vi.fn()} projects={[]} value={null} />
    );

    fireEvent.click(screen.getByRole("combobox"));
    expect(await screen.findByText("No projects found.")).toBeDefined();
  });

  it("resolves the selection value to the slug, falling back to the id", () => {
    expect(
      projectSelectionValue({ id: "p1", name: "Platform", slug: "platform" })
    ).toBe("platform");
    expect(
      projectSelectionValue({ id: "p3", name: "Untitled", slug: null })
    ).toBe("p3");
  });
});
