/**
 * @file packs-workspace-skeleton.test.tsx
 * @description Render tests for the shared PacksWorkspace loading skeleton
 * (FEA-4068). Both the web member dashboard and the desktop plugins panel mount
 * this, so the same surface loads the same way — a card-reserving grid, not a
 * bare "Loading…" line.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PacksWorkspaceSkeleton } from "../packs-workspace-skeleton";

const SKELETON_TESTID = "packs-workspace-skeleton";
const DEFAULT_CARD_COUNT = 6;
const SKELETON_SLOT = '[data-slot="skeleton"]';
// Placeholder cards use the DS Card, whose root carries data-slot="card".
const CARD_SLOT = '[data-slot="card"]';

// The team-layout default reserves the two-column shell plus a rail card, so
// the placeholder-card count is the grid cards + 1 rail Card.
const RAIL_CARD_COUNT = 1;

describe("PacksWorkspaceSkeleton", () => {
  it("renders a tokenized card-grid skeleton of DS primitives", () => {
    const { container } = render(<PacksWorkspaceSkeleton />);

    expect(screen.getByTestId(SKELETON_TESTID)).toBeDefined();
    // Built from the DS Card + Skeleton primitives (tokenized), not hand-rolled
    // divs — assert the shipped data-slots are present.
    expect(container.querySelectorAll(CARD_SLOT).length).toBe(
      DEFAULT_CARD_COUNT + RAIL_CARD_COUNT
    );
    expect(container.querySelectorAll(SKELETON_SLOT).length).toBeGreaterThan(0);
  });

  it("reserves the requested number of placeholder cards", () => {
    const cardCount = 3;
    const { container } = render(
      <PacksWorkspaceSkeleton cardCount={cardCount} />
    );

    expect(container.querySelectorAll(CARD_SLOT).length).toBe(
      cardCount + RAIL_CARD_COUNT
    );
  });

  it("exposes an accessible loading status hiding the decorative placeholders", () => {
    render(<PacksWorkspaceSkeleton />);

    // Screen readers hear one "Loading Packs" announcement, not the tree of
    // empty placeholder nodes (which are aria-hidden).
    const status = screen.getByRole("status", { name: "Loading Packs" });
    expect(status.getAttribute("aria-busy")).toBe("true");
  });

  it("reserves the two-column team shell with a rail placeholder by default", () => {
    const { container } = render(<PacksWorkspaceSkeleton />);

    // The loaded workspace lays team surfaces out as 1fr/20rem with a rail on
    // the right; the skeleton reserves that same track so nothing reflows.
    const teamGrid = container.querySelector(".lg\\:grid-cols-\\[1fr_20rem\\]");
    expect(teamGrid).not.toBeNull();
  });

  it("drops the rail and fills the width for a single-column surface", () => {
    const { container } = render(
      <PacksWorkspaceSkeleton showTeamLayout={false} />
    );

    // DesktopSolo has no team rail — only the grid cards, no reserved 20rem.
    expect(
      container.querySelector(".lg\\:grid-cols-\\[1fr_20rem\\]")
    ).toBeNull();
    expect(container.querySelectorAll(CARD_SLOT).length).toBe(
      DEFAULT_CARD_COUNT
    );
  });

  it("renders a static header for real, outside the aria-hidden placeholders", () => {
    render(<PacksWorkspaceSkeleton header={<h2>Plugins</h2>} />);

    // The known-ahead-of-fetch heading is a real, announced heading during
    // loading (so it does not pop in on resolve), not a gray placeholder.
    const heading = screen.getByRole("heading", { name: "Plugins" });
    expect(heading.closest("[aria-hidden='true']")).toBeNull();
  });
});
