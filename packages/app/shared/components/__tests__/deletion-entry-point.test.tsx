import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  DeletionEntryPoint,
  type DeletionEntryPointProps,
} from "../deletion-entry-point";
import {
  DELETION_SCOPE_ITEM_KIND,
  type DeletionEffects,
  type DeletionScopeItem,
} from "../deletion-scope-review";

/**
 * ISS-12539. Every string here is a test fixture, not product copy: the entry
 * point takes all its text from the host.
 */
const TRIGGER = "fixture-entry-point";
const SESSION_TWO_NAME = /fixture-session-two/;

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

function renderEntryPoint(overrides: Partial<DeletionEntryPointProps> = {}) {
  const onConfirm = vi.fn(async (_ids: string[]) => true);
  render(
    <DeletionEntryPoint
      effects={EFFECTS}
      effectsLabel="fixture-effects"
      itemName="fixture-item"
      items={ITEMS}
      onConfirm={onConfirm}
      scopeLabel="fixture-scope"
      title="fixture-title"
      triggerLabel={TRIGGER}
      {...overrides}
    />
  );
  return { onConfirm };
}

function openReview() {
  fireEvent.click(screen.getByRole("button", { name: TRIGGER }));
  return within(screen.getByRole("dialog"));
}

function checkedIds(dialog: ReturnType<typeof within>) {
  return dialog
    .getAllByRole("checkbox")
    .filter((box: HTMLElement) => box.getAttribute("aria-checked") === "true")
    .map((box: HTMLElement) => box.id);
}

describe("ISS-12539: DeletionEntryPoint", () => {
  it("is closed until the trigger is pressed", () => {
    renderEntryPoint();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByTestId("deletion-scope-review")).toBeNull();
  });

  it("AC-003: opens the shared delete dialog with the scope review", () => {
    renderEntryPoint();
    const dialog = openReview();
    expect(dialog.getByTestId("deletion-scope-review")).toBeInTheDocument();
    expect(dialog.getByText("Delete fixture-title")).toBeInTheDocument();
    expect(dialog.getAllByRole("checkbox")).toHaveLength(ITEMS.length);
    expect(checkedIds(dialog)).toHaveLength(ITEMS.length);
  });

  it("starts from initialSelectedIds when the host gives them", () => {
    renderEntryPoint({ initialSelectedIds: ["ses-2"] });
    const dialog = openReview();
    expect(
      dialog.getByRole("checkbox", { name: SESSION_TWO_NAME })
    ).toBeChecked();
    expect(checkedIds(dialog)).toHaveLength(1);
  });

  it("confirms with the narrowed scope, then closes", async () => {
    const { onConfirm } = renderEntryPoint();
    const dialog = openReview();
    fireEvent.click(dialog.getByRole("checkbox", { name: SESSION_TWO_NAME }));
    fireEvent.click(dialog.getByRole("button", { name: "Delete" }));
    await vi.waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    );
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith(["dir-1", "ses-1"]);
  });

  it("keeps the dialog open when the host's confirm fails", async () => {
    const onConfirm = vi.fn(async () => false);
    renderEntryPoint({ onConfirm });
    const dialog = openReview();
    fireEvent.click(dialog.getByRole("button", { name: "Delete" }));
    await vi.waitFor(() => expect(onConfirm).toHaveBeenCalledOnce());
    // Let the dialog settle the confirm's result before asserting it stayed.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("a cancelled narrowing does not carry into the next open", () => {
    renderEntryPoint();
    let dialog = openReview();
    fireEvent.click(dialog.getByRole("checkbox", { name: SESSION_TWO_NAME }));
    fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    dialog = openReview();
    expect(
      dialog.getByRole("checkbox", { name: SESSION_TWO_NAME })
    ).toBeChecked();
  });
});
