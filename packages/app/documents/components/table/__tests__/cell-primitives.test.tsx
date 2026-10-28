/**
 * Behaviour contract for the two document-table cell primitives that had no
 * assertion of their own (ISS-6386): the rank slot's four-way branch and the
 * cell tooltip's pass-through.
 *
 * Tooltips are stubbed the way the sibling tooltip suite stubs them, so each
 * test asserts the text a hover would REVEAL rather than the Radix wrapper
 * around it — a trigger with nothing inside it satisfies a wrapper check, and
 * that silent grip is exactly the state these branches exist to avoid.
 */

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/design-system/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}));

import {
  CellTooltip,
  TruncatedTitle,
} from "@repo/app/documents/components/table/cells/cell-tooltip";
import {
  buildRankSlot,
  RANK_DISABLED_HINT,
  RANK_SLOT_WIDTH_CLASS,
} from "@repo/app/documents/components/table/cells/rank-slot";
import { RankInteractionMode } from "@repo/app/documents/components/table/sort-keys";

const SLOT_HOST = "rank-slot-host";
const DRAG_HANDLE_LABEL = "Reorder row";
const LONG_TITLE = "A very long artifact title";

const DRAG_HANDLE = (
  <button aria-label={DRAG_HANDLE_LABEL} type="button">
    grip
  </button>
);

function renderSlot(
  mode: RankInteractionMode | undefined,
  reserveRankSlot: boolean
) {
  // A host element rather than a bare fragment: `buildRankSlot` can return
  // null, and "renders nothing" is one of the four branches under test, so the
  // assertion needs a container that exists even when the slot does not.
  return render(
    <div data-testid={SLOT_HOST}>
      {buildRankSlot(mode, DRAG_HANDLE, reserveRankSlot)}
    </div>
  );
}

function revealedText(): string[] {
  return screen
    .queryAllByTestId("tooltip-content")
    .map((node) => node.textContent ?? "");
}

afterEach(() => {
  cleanup();
});

describe("buildRankSlot", () => {
  it("renders the caller's drag handle when reordering is enabled", () => {
    renderSlot(RankInteractionMode.Enabled, false);

    expect(
      screen.getByRole("button", { name: DRAG_HANDLE_LABEL })
    ).toBeInTheDocument();
    expect(revealedText()).toEqual([]);
  });

  it("reveals the reason reordering is unavailable, not just an inert grip", () => {
    renderSlot(RankInteractionMode.DisabledGrouped, false);
    const container = screen.getByTestId(SLOT_HOST);

    // The grip still renders — a slot that reserves the space but shows nothing
    // is indistinguishable from a row that was never rankable.
    expect(container.querySelector("svg")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: DRAG_HANDLE_LABEL })
    ).not.toBeInTheDocument();
    expect(revealedText()).toEqual([RANK_DISABLED_HINT]);
  });

  it("reserves a spacer of the same width as the rendered slot, and no control", () => {
    renderSlot(undefined, true);
    const reserved = screen
      .getByTestId(SLOT_HOST)
      .querySelector("[aria-hidden='true']");

    expect(reserved).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    cleanup();

    // The width is the spacer's entire job: the slot renders on root rows only,
    // so a spacer of any other width cancels or doubles one level of child
    // indentation. Assert the two tracks agree, not either one in isolation.
    renderSlot(RankInteractionMode.Enabled, false);

    expect(reserved).toHaveClass(RANK_SLOT_WIDTH_CLASS);
    expect(
      screen
        .getByRole("button", { name: DRAG_HANDLE_LABEL })
        .closest(`.${RANK_SLOT_WIDTH_CLASS}`)
    ).toHaveClass(RANK_SLOT_WIDTH_CLASS);
    expect(
      screen.getByTestId(SLOT_HOST).querySelector("[aria-hidden='true']")
    ).toBeNull();
  });

  it("renders nothing at all for a row on a surface without ranking", () => {
    renderSlot(undefined, false);

    expect(screen.getByTestId(SLOT_HOST)).toBeEmptyDOMElement();
  });
});

describe("CellTooltip", () => {
  it("reveals the full value when there is text to reveal", () => {
    render(
      <CellTooltip text={LONG_TITLE}>
        <span>Truncated…</span>
      </CellTooltip>
    );

    expect(revealedText()).toEqual([LONG_TITLE]);
  });

  it("returns the child untouched when there is no text, so an empty cell gains no dead trigger", () => {
    render(
      <CellTooltip text={null}>
        <span>Truncated…</span>
      </CellTooltip>
    );

    expect(screen.getByText("Truncated…")).toBeInTheDocument();
    expect(revealedText()).toEqual([]);
  });

  it("returns the child untouched for an empty string, not a tooltip revealing nothing", () => {
    render(
      <CellTooltip text="">
        <span>Truncated…</span>
      </CellTooltip>
    );

    expect(revealedText()).toEqual([]);
  });
});

describe("TruncatedTitle", () => {
  it("always reveals its full text, since the visible text may be clipped", () => {
    render(<TruncatedTitle text={LONG_TITLE} />);

    const visible = screen
      .getAllByText(LONG_TITLE)
      .filter((node) => !node.closest("[data-testid='tooltip-content']"));

    expect(visible).toHaveLength(1);
    expect(revealedText()).toEqual([LONG_TITLE]);
  });
});
