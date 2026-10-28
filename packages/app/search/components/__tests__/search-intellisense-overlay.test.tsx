import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  IntellisenseRow,
  IntellisenseView,
} from "../../hooks/use-search-intellisense";
import {
  filterKeySuggestions,
  IntellisenseMode,
} from "../../lib/search-intellisense";
import { SearchIntellisenseOverlay } from "../search-intellisense-overlay";

const LISTBOX_ID = "intellisense-listbox";
const LOADING_LABEL = "Loading suggestions";
const ERROR_TEXT = "Something went wrong loading suggestions. Try again.";
const EMPTY_TEXT = "No matches";

function makeView(overrides: Partial<IntellisenseView>): IntellisenseView {
  return {
    isOpen: true,
    mode: IntellisenseMode.StaticValues,
    rows: [],
    isLoading: false,
    isError: false,
    commitRow: () => null,
    ...overrides,
  };
}

function renderOverlay(view: IntellisenseView, activeIndex = -1) {
  const onSelect = vi.fn();
  render(
    <SearchIntellisenseOverlay
      activeIndex={activeIndex}
      listboxId={LISTBOX_ID}
      onSelect={onSelect}
      optionId={(index) => `option-${index}`}
      view={view}
    />
  );
  return onSelect;
}

describe("SearchIntellisenseOverlay", () => {
  it("shows only the spinner while loading with no rows", () => {
    renderOverlay(makeView({ isLoading: true }));
    expect(screen.getByLabelText(LOADING_LABEL)).toBeTruthy();
    expect(screen.queryByText(EMPTY_TEXT)).toBeNull();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("shows the error message and no empty state on error", () => {
    renderOverlay(makeView({ isError: true }));
    expect(screen.getByText(ERROR_TEXT)).toBeTruthy();
    expect(screen.queryByText(EMPTY_TEXT)).toBeNull();
    expect(screen.queryByLabelText(LOADING_LABEL)).toBeNull();
  });

  it("shows the empty state when settled with no rows", () => {
    renderOverlay(makeView({}));
    expect(screen.getByText(EMPTY_TEXT)).toBeTruthy();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("keeps rows visible and hides the spinner while a refetch is loading", () => {
    renderOverlay(
      makeView({ isLoading: true, rows: [{ kind: "value", value: "draft" }] })
    );
    expect(screen.queryByLabelText(LOADING_LABEL)).toBeNull();
    expect(screen.queryByText(EMPTY_TEXT)).toBeNull();
    expect(screen.getByRole("option").textContent).toBe("draft");
  });

  it("labels the listbox by mode and marks the active row selected", () => {
    const onSelect = renderOverlay(
      makeView({
        rows: [
          { kind: "value", value: "draft" },
          { kind: "value", value: "done" },
        ],
      }),
      1
    );
    const listbox = screen.getByRole("listbox", { name: "Values" });
    expect(listbox.id).toBe(LISTBOX_ID);
    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.id)).toEqual([
      "option-0",
      "option-1",
    ]);
    expect(options[0].getAttribute("aria-selected")).toBe("false");
    expect(options[1].getAttribute("aria-selected")).toBe("true");
    expect(options[1].querySelector("button")?.className).toContain("bg-muted");
    expect(options[0].querySelector("button")?.className).toContain(
      "hover:bg-muted"
    );

    fireEvent.mouseDown(screen.getByText("done"));
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it("falls back to a generic listbox label for free text", () => {
    renderOverlay(
      makeView({
        mode: IntellisenseMode.FreeText,
        rows: [{ kind: "value", value: "x" }],
      })
    );
    expect(screen.getByRole("listbox", { name: "Suggestions" })).toBeTruthy();
  });

  it("renders a filter key's label and its operators", () => {
    const [suggestion] = filterKeySuggestions("");
    renderOverlay(
      makeView({
        mode: IntellisenseMode.FilterKeys,
        rows: [{ kind: "key", suggestion }],
      })
    );
    expect(screen.getByRole("listbox", { name: "Filters" })).toBeTruthy();
    expect(screen.getByText(suggestion.meta.label)).toBeTruthy();
    expect(screen.getByText(suggestion.operators.join(" "))).toBeTruthy();
  });

  it("renders member and project rows with their optional detail line", () => {
    const rows: IntellisenseRow[] = [
      {
        kind: "member",
        option: { value: "ada", label: "Ada", detail: "ada@example.com" },
      },
      { kind: "member", option: { value: "bob", label: "Bob" } },
    ];
    renderOverlay(makeView({ mode: IntellisenseMode.Members, rows }));
    expect(screen.getByRole("listbox", { name: "People" })).toBeTruthy();
    const options = screen.getAllByRole("option");
    expect(options[0].textContent).toBe("Adaada@example.com");
    expect(options[1].textContent).toBe("Bob");
  });

  it("renders a dynamic project value under the Projects heading", () => {
    renderOverlay(
      makeView({
        mode: IntellisenseMode.DynamicValues,
        rows: [
          {
            kind: "dynamic-value",
            option: { value: "p1", label: "Apollo", detail: "apollo" },
          },
        ],
      })
    );
    expect(screen.getByRole("listbox", { name: "Projects" })).toBeTruthy();
    expect(screen.getByRole("option").textContent).toBe("Apolloapollo");
  });
});
