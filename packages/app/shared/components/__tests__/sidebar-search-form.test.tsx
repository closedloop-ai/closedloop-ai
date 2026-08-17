import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SidebarSearchForm } from "../sidebar-search-form";

describe("SidebarSearchForm", () => {
  it("renders the controlled value with an accessible textbox name", () => {
    render(
      <SidebarSearchForm
        onClear={vi.fn()}
        onSubmit={vi.fn()}
        onValueChange={vi.fn()}
        showClear={false}
        value="alpha"
      />
    );

    expect(screen.getByRole("textbox", { name: "Search" })).toHaveValue(
      "alpha"
    );
  });

  it("submits the current controlled value", () => {
    const handleSubmit = vi.fn();
    render(
      <SidebarSearchForm
        onClear={vi.fn()}
        onSubmit={handleSubmit}
        onValueChange={vi.fn()}
        showClear={false}
        value="alpha beta"
      />
    );

    const form = screen
      .getByRole("textbox", { name: "Search" })
      .closest("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form as HTMLFormElement);

    expect(handleSubmit).toHaveBeenCalledWith("alpha beta");
  });

  it("renders adapter-owned native form attributes for pre-hydration submits", () => {
    render(
      <SidebarSearchForm
        nativeAction="/acme/search"
        nativeInputName="q"
        nativeMethod="get"
        onClear={vi.fn()}
        onSubmit={vi.fn()}
        onValueChange={vi.fn()}
        showClear={false}
        value="alpha beta"
      />
    );

    const input = screen.getByRole("textbox", { name: "Search" });
    const form = input.closest("form");
    expect(form).not.toBeNull();
    expect(form).toHaveAttribute("action", "/acme/search");
    expect(form).toHaveAttribute("method", "get");
    expect(input).toHaveAttribute("name", "q");
  });

  it("reports input changes without owning the next value", async () => {
    const handleValueChange = vi.fn();
    const user = userEvent.setup();
    render(
      <SidebarSearchForm
        onClear={vi.fn()}
        onSubmit={vi.fn()}
        onValueChange={handleValueChange}
        showClear={false}
        value=""
      />
    );

    await user.type(screen.getByRole("textbox", { name: "Search" }), "a");

    expect(handleValueChange).toHaveBeenCalledWith("a");
  });

  it("hides the clear affordance when inactive", () => {
    render(
      <SidebarSearchForm
        onClear={vi.fn()}
        onSubmit={vi.fn()}
        onValueChange={vi.fn()}
        showClear={false}
        value=""
      />
    );

    expect(
      screen.queryByRole("button", { name: "Clear search" })
    ).not.toBeInTheDocument();
  });

  it("invokes clear when the clear affordance is visible", async () => {
    const handleClear = vi.fn();
    const user = userEvent.setup();
    render(
      <SidebarSearchForm
        onClear={handleClear}
        onSubmit={vi.fn()}
        onValueChange={vi.fn()}
        showClear
        value="alpha"
      />
    );

    await user.click(screen.getByRole("button", { name: "Clear search" }));

    expect(handleClear).toHaveBeenCalledTimes(1);
  });

  it("always exposes a 'press Enter to search' instruction to assistive tech", () => {
    render(
      <SidebarSearchForm
        onClear={vi.fn()}
        onSubmit={vi.fn()}
        onValueChange={vi.fn()}
        showClear={false}
        value=""
      />
    );

    const input = screen.getByRole("textbox", { name: "Search" });
    const describedBy = input.getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    const description = document.getElementById(describedBy as string);
    expect(description).toHaveTextContent("Press Enter to search");
  });

  it("shows the return-key hint once a pending query is typed", () => {
    render(
      <SidebarSearchForm
        onClear={vi.fn()}
        onSubmit={vi.fn()}
        onValueChange={vi.fn()}
        showClear={false}
        value="alpha"
      />
    );

    expect(screen.getByText("Enter")).toBeInTheDocument();
  });

  it("hides the return-key hint when the field is empty", () => {
    render(
      <SidebarSearchForm
        onClear={vi.fn()}
        onSubmit={vi.fn()}
        onValueChange={vi.fn()}
        showClear={false}
        value=""
      />
    );

    expect(screen.queryByText("Enter")).not.toBeInTheDocument();
  });

  it("hides the return-key hint for whitespace-only input", () => {
    render(
      <SidebarSearchForm
        onClear={vi.fn()}
        onSubmit={vi.fn()}
        onValueChange={vi.fn()}
        showClear={false}
        value="   "
      />
    );

    expect(screen.queryByText("Enter")).not.toBeInTheDocument();
  });

  it("keeps the return-key hint visible alongside the clear affordance", () => {
    // Both web and desktop adapters flip showClear true as soon as any text is
    // typed, so the visible hint has to coexist with the clear button rather
    // than yield the slot — otherwise it would never render on a real surface.
    render(
      <SidebarSearchForm
        onClear={vi.fn()}
        onSubmit={vi.fn()}
        onValueChange={vi.fn()}
        showClear
        value="alpha"
      />
    );

    expect(screen.getByText("Enter")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Clear search" })
    ).toBeInTheDocument();
  });
});
