import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { DeleteConfirmationDialog } from "../delete-confirmation-dialog";
import {
  DELETION_SCOPE_ITEM_KIND,
  type DeletionEffects,
  type DeletionScopeItem,
} from "../deletion-scope-review";

const SESSION_ONE_NAME = /fixture-session-one/;
const SESSION_TWO_NAME = /fixture-session-two/;

/**
 * ISS-12537. Every string here is a test fixture, not product copy: the review
 * takes all its text from the host.
 */
const ITEMS: DeletionScopeItem[] = [
  {
    id: "dir-1",
    kind: DELETION_SCOPE_ITEM_KIND.DIRECTORY,
    label: "fixture-dir-one",
  },
  {
    id: "ses-1",
    kind: DELETION_SCOPE_ITEM_KIND.SESSION,
    label: "fixture-session-one",
    detail: "fixture-detail",
  },
  {
    id: "ses-2",
    kind: DELETION_SCOPE_ITEM_KIND.SESSION,
    label: "fixture-session-two",
  },
];

const EFFECTS: DeletionEffects = {
  localCopies: { label: "fixture-local-label", statement: "fixture-local" },
  serverData: { label: "fixture-server-label", statement: "fixture-server" },
  sharedAccess: { label: "fixture-shared-label", statement: "fixture-shared" },
  futureReupload: {
    label: "fixture-reupload-label",
    statement: "fixture-reupload",
  },
};

/** What a host refresh can leave: new items, none of the selected ids. */
const REFRESHED_ITEMS: DeletionScopeItem[] = [
  {
    id: "ses-3",
    kind: DELETION_SCOPE_ITEM_KIND.SESSION,
    label: "fixture-session-three",
  },
];

function Harness({
  onConfirm = vi.fn(async () => true),
  onSelectedIdsChange,
  initialSelectedIds = ITEMS.map((item) => item.id),
  isPending = false,
  items = ITEMS,
  extraScopeReviewProps = {},
}: {
  isPending?: boolean;
  onConfirm?: (scopeIds?: string[]) => Promise<boolean>;
  onSelectedIdsChange?: (ids: string[]) => void;
  initialSelectedIds?: string[];
  items?: DeletionScopeItem[];
  /** Keys a host could put on `scopeReview` beyond its declared props. */
  extraScopeReviewProps?: Record<string, unknown>;
}) {
  const [selectedIds, setSelectedIds] = useState(initialSelectedIds);
  return (
    <DeleteConfirmationDialog
      description="fixture-description"
      isPending={isPending}
      itemName="fixture-scope"
      onConfirm={onConfirm}
      onOpenChange={vi.fn()}
      open
      scopeReview={{
        effects: EFFECTS,
        effectsLabel: "fixture-effects",
        items,
        ...extraScopeReviewProps,
        onSelectedIdsChange: (ids) => {
          onSelectedIdsChange?.(ids);
          setSelectedIds(ids);
        },
        scopeLabel: "fixture-scope-label",
        selectedIds,
      }}
      title="fixture-title"
    />
  );
}

describe("DeleteConfirmationDialog with a deletion scope review", () => {
  it("AC-001: lists every item in scope as a checked, named checkbox", () => {
    render(<Harness />);
    const scope = screen.getByRole("group", { name: "fixture-scope-label" });
    const boxes = within(scope).getAllByRole("checkbox");
    expect(boxes).toHaveLength(ITEMS.length);
    for (const item of ITEMS) {
      expect(
        within(scope).getByRole("checkbox", { name: new RegExp(item.label) })
      ).toBeChecked();
    }
    expect(within(scope).getByText("fixture-detail")).toBeInTheDocument();
  });

  it("AC-001: unchecking an item narrows the scope, in item order", () => {
    const onSelectedIdsChange = vi.fn();
    render(<Harness onSelectedIdsChange={onSelectedIdsChange} />);
    const box = screen.getByRole("checkbox", { name: SESSION_ONE_NAME });
    fireEvent.click(box);
    expect(onSelectedIdsChange).toHaveBeenLastCalledWith(["dir-1", "ses-2"]);
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    expect(onSelectedIdsChange).toHaveBeenLastCalledWith([
      "dir-1",
      "ses-1",
      "ses-2",
    ]);
  });

  it("AC-001: with nothing left in scope, Delete is disabled", () => {
    render(<Harness initialSelectedIds={["ses-2"]} />);
    const dialog = screen.getByRole("dialog");
    const deleteButton = within(dialog).getByRole("button", { name: "Delete" });
    expect(deleteButton).toBeEnabled();
    fireEvent.click(screen.getByRole("checkbox", { name: SESSION_TWO_NAME }));
    expect(deleteButton).toBeDisabled();
  });

  it("AC-001: the scope is locked while a confirmed deletion is pending", () => {
    const onSelectedIdsChange = vi.fn();
    render(<Harness isPending onSelectedIdsChange={onSelectedIdsChange} />);
    const scope = screen.getByRole("group", { name: "fixture-scope-label" });
    for (const box of within(scope).getAllByRole("checkbox")) {
      expect(box).toBeDisabled();
    }
    fireEvent.click(screen.getByRole("checkbox", { name: SESSION_ONE_NAME }));
    expect(onSelectedIdsChange).not.toHaveBeenCalled();
  });

  it("AC-002: states the effect on local copies, server data, shared access and future re-upload, in that order", () => {
    render(<Harness />);
    const effects = screen.getByRole("region", { name: "fixture-effects" });
    const terms = within(effects)
      .getAllByRole("term")
      .map((term) => term.textContent);
    const definitions = within(effects)
      .getAllByRole("definition")
      .map((definition) => definition.textContent);
    expect(terms).toEqual([
      "fixture-local-label",
      "fixture-server-label",
      "fixture-shared-label",
      "fixture-reupload-label",
    ]);
    expect(definitions).toEqual([
      "fixture-local",
      "fixture-server",
      "fixture-shared",
      "fixture-reupload",
    ]);
  });

  it("AC-003: renders inside the shared dialog and confirms through it", async () => {
    const onConfirm = vi.fn(async () => true);
    render(<Harness onConfirm={onConfirm} />);
    const dialog = screen.getByRole("dialog", { name: "Delete fixture-title" });
    expect(dialog).toHaveAccessibleDescription("fixture-description");
    expect(
      within(dialog).getByTestId("deletion-scope-review")
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await Promise.resolve();
  });

  it("AC-001: selected ids a refresh removed from items do not count as in scope", () => {
    const onConfirm = vi.fn(async () => true);
    const { rerender } = render(<Harness onConfirm={onConfirm} />);
    const dialog = screen.getByRole("dialog");
    const deleteButton = within(dialog).getByRole("button", { name: "Delete" });
    expect(deleteButton).toBeEnabled();
    // The host refreshes `items`; its `selectedIds` still names the old ids.
    rerender(<Harness items={REFRESHED_ITEMS} onConfirm={onConfirm} />);
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(deleteButton).toBeDisabled();
    fireEvent.click(deleteButton);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("AC-003: confirms with only the selected ids that are in items", async () => {
    const onConfirm = vi.fn(async () => true);
    render(
      <Harness
        initialSelectedIds={["gone-1", "ses-2", "dir-1", "gone-2"]}
        onConfirm={onConfirm}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledWith(["dir-1", "ses-2"]);
    await Promise.resolve();
  });

  it("AC-001: a scopeReview carrying disabled:false cannot unlock the scope while pending", () => {
    const onSelectedIdsChange = vi.fn();
    render(
      <Harness
        extraScopeReviewProps={{ className: "fixture-class", disabled: false }}
        isPending
        onSelectedIdsChange={onSelectedIdsChange}
      />
    );
    const scope = screen.getByRole("group", { name: "fixture-scope-label" });
    for (const box of within(scope).getAllByRole("checkbox")) {
      expect(box).toBeDisabled();
    }
    fireEvent.click(screen.getByRole("checkbox", { name: SESSION_ONE_NAME }));
    expect(onSelectedIdsChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("deletion-scope-review")).toHaveClass(
      "overflow-y-auto"
    );
  });

  it("caps the dialog to the viewport and scrolls only the review, keeping header and footer fixed", () => {
    render(<Harness />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveClass("flex", "max-h-[90vh]", "flex-col");
    expect(dialog).not.toHaveClass("grid");
    expect(screen.getByTestId("deletion-scope-review")).toHaveClass(
      "min-h-0",
      "overflow-y-auto"
    );
    for (const slot of ["dialog-header", "dialog-footer"]) {
      const part = dialog.querySelector(`[data-slot="${slot}"]`);
      expect(part).toHaveClass("shrink-0");
    }
    // The buttons sit in the fixed footer, outside the scrolling review.
    const footer = dialog.querySelector('[data-slot="dialog-footer"]');
    expect(
      within(footer as HTMLElement).getByRole("button", { name: "Delete" })
    ).toBeInTheDocument();
  });
});
