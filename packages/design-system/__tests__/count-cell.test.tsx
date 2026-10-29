import {
  CountCell,
  compareCountValues,
  isCountCellEmpty,
} from "@closedloop-ai/design-system/components/ui/count-cell";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Companion to cell-primitives.test.tsx (ISS-6384), which already pins the
 * zero/unknown/loading trio and the basic comparator cases. This file covers
 * what that one does not: the populated-count render, the two interactive
 * wrappers actually wearing a chip (not just avoiding one), alignment on the
 * interactive branch, string-vs-object pluralization at count one, and the
 * pure helpers exercised directly rather than through a render loop.
 */

afterEach(cleanup);

describe("CountCell", () => {
  it("renders a positive count through the shared grouping formatter", () => {
    render(<CountCell count={12_847} noun="tokens" />);

    // Grouped digits, not a raw run — the component docstring calls this out
    // as the reason the shared formatter exists.
    expect(screen.getByText("12,847")).toBeInTheDocument();
    expect(screen.getByText("12,847 tokens")).toBeInTheDocument();
  });

  it("wraps a renderLink count in the interactive chip", () => {
    render(
      <CountCell
        count={4}
        noun="linked sessions"
        renderLink={(content, accessibleName) => (
          <a aria-label={accessibleName} href="/sessions">
            {content}
          </a>
        )}
      />
    );

    // The plain-count branch is pinned elsewhere as carrying NO chip; this is
    // the other half of that contract — the interactive branch must actually
    // wear one, not just avoid an unstyled bare link.
    const link = screen.getByRole("link", { name: "4 linked sessions" });
    expect(link).toHaveAttribute("data-slot", "chip");
  });

  it("wraps an onSelect count in the interactive chip", () => {
    render(<CountCell count={4} noun="comments" onSelect={vi.fn()} />);

    const button = screen.getByRole("button", { name: "4 comments" });
    expect(button).toHaveAttribute("data-slot", "chip");
  });

  it("takes renderLink over onSelect, and never wires the click handler through", () => {
    const onSelect = vi.fn();
    render(
      <CountCell
        count={4}
        noun="linked sessions"
        onSelect={onSelect}
        renderLink={(content, accessibleName) => (
          <a aria-label={accessibleName} href="/sessions">
            {content}
          </a>
        )}
      />
    );

    fireEvent.click(screen.getByRole("link", { name: "4 linked sessions" }));

    // Not just "no button rendered" — the handler must be truly unreachable,
    // not merely unattached to a visible control.
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("right-aligns the interactive branch too, not only the static ones", () => {
    const { container } = render(
      <CountCell alignEnd count={4} noun="comments" onSelect={vi.fn()} />
    );

    expect(container.querySelector(".ml-auto")).not.toBeNull();
  });

  it("never pluralizes a plain string noun, even at a count of one", () => {
    render(
      <>
        <CountCell count={1} noun="linked sessions" />
        <CountCell
          count={1}
          noun={{ one: "linked session", other: "linked sessions" }}
        />
      </>
    );

    // A string noun is used verbatim for every count — the docstring warns
    // this ships "1 linked sessions" — and that is what this pins.
    expect(screen.getByText("1 linked sessions")).toBeInTheDocument();
    // The object form is the one that actually collapses to the singular.
    expect(screen.getByText("1 linked session")).toBeInTheDocument();
  });

  it("does not treat a still-loading count as empty", () => {
    expect(isCountCellEmpty(0, true)).toBe(false);
    expect(isCountCellEmpty(null, true)).toBe(false);
    expect(isCountCellEmpty(12, true)).toBe(false);
  });

  it("reverses ascending order for a descending sort", () => {
    expect(compareCountValues(3, 10, "desc")).toBeGreaterThan(0);
    expect(compareCountValues(10, 3, "desc")).toBeLessThan(0);
    expect(compareCountValues(3, 10)).toBeLessThan(0);
  });

  it("treats two unknown counts as equal", () => {
    expect(compareCountValues(null, null)).toBe(0);
    expect(compareCountValues(null, undefined)).toBe(0);
  });

  it("sorts an unknown count last without the direction flip that governs known values", () => {
    // The null branch returns before the ascending/descending switch, so a
    // descending compare produces the SAME sign as ascending here — the
    // opposite of what direction does when both values are known.
    expect(compareCountValues(5, null)).toBeLessThan(0);
    expect(compareCountValues(5, null, "desc")).toBeLessThan(0);
    expect(compareCountValues(null, 5)).toBeGreaterThan(0);
    expect(compareCountValues(null, 5, "desc")).toBeGreaterThan(0);
  });
});
