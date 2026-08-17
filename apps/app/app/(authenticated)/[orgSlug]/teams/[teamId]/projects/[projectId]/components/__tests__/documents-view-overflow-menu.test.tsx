import { DocumentType } from "@repo/api/src/types/document";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { makeArtifact } from "@repo/app/shared/test-fixtures/documents";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { DocumentRowActions } from "../document-row-actions";

// FEA-4242: the reported regression was "clicking a row's 3-dot (More actions)
// button does nothing" — the overflow menu never opened. The old fix used a
// single view-level menu anchored to an invisible span, and the test forced
// that menu `open` while swapping in fake actions, so it never exercised the
// real click. These tests drive the REAL path: render the row's own overflow
// menu (`DocumentRowActions`, per FEA-4242), CLICK its trigger, and assert the
// menu opens and a production action fires.

// Radix DropdownMenu drives open via pointer-capture APIs jsdom lacks; shim
// them so the real click-to-open interaction works (we never force `open`).
beforeAll(() => {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {
      // no-op
    };
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {
      // no-op
    };
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {
      // no-op
    };
  }
});

function docItem(type: DocumentType = DocumentType.Prd): DocumentRowItem {
  return { kind: "document", data: makeArtifact({ id: "doc-1", type }) };
}

function renderRowActions(
  overrides: Partial<Parameters<typeof DocumentRowActions>[0]> = {}
) {
  const handlers = {
    onMoveToTop: vi.fn(),
    onMoveToBottom: vi.fn(),
    onMove: vi.fn(),
    onGeneratePrd: vi.fn(),
    onDelete: vi.fn(),
  };
  render(
    <DocumentRowActions
      canGeneratePrd={false}
      item={docItem()}
      showRankActions={false}
      {...handlers}
      {...overrides}
    />
  );
  return handlers;
}

describe("DocumentRowActions row overflow menu (FEA-4242)", () => {
  it("stays closed until the row's More actions button is clicked", () => {
    renderRowActions();

    // The regression: nothing is open on mount — the actions are not in the DOM
    // until the real trigger is clicked.
    expect(screen.getByRole("button", { name: "More actions" })).toBeVisible();
    expect(
      screen.queryByRole("menuitem", { name: "Move to Project" })
    ).not.toBeInTheDocument();
  });

  it("opens the menu with the production actions when the trigger is clicked", async () => {
    const user = userEvent.setup();
    renderRowActions();

    await user.click(screen.getByRole("button", { name: "More actions" }));

    // The previously-dead click now opens the menu, showing the real row
    // actions (not stand-in items).
    expect(
      await screen.findByRole("menuitem", { name: "Move to Project" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Delete" })
    ).toBeInTheDocument();
  });

  it("fires the Delete action from the opened menu", async () => {
    const user = userEvent.setup();
    const handlers = renderRowActions();

    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));

    expect(handlers.onDelete).toHaveBeenCalledTimes(1);
  });

  it("offers Generate PRD only when the row is generate-eligible", async () => {
    const user = userEvent.setup();
    const handlers = renderRowActions({ canGeneratePrd: true });

    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Generate PRD" })
    );

    expect(handlers.onGeneratePrd).toHaveBeenCalledTimes(1);
  });

  it("offers Move to top / bottom only on the stack-rank surface", async () => {
    const user = userEvent.setup();
    const handlers = renderRowActions({ showRankActions: true });

    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Move to top" })
    );

    await waitFor(() => expect(handlers.onMoveToTop).toHaveBeenCalledTimes(1));
  });
});
