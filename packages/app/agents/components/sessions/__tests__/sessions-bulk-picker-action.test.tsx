import { tooltipMockModule } from "@repo/app/test/mocks/tooltip";
import { toast } from "@repo/design-system/components/ui/sonner";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createSessionTableRowFixture } from "../session-list-fixtures";
import {
  type SessionsBulkActionOption,
  type SessionsBulkUndo,
  sessionsBulkPickerAction,
} from "../sessions-bulk-picker-action";
import { SessionsBulkRail } from "./sessions-selection.test-helpers";

vi.mock("@repo/design-system/components/ui/tooltip", () => tooltipMockModule);
vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

/**
 * ISS-8942 — a host batch command as a picker descriptor. The create seam is
 * the host's, not the factory's: a command that cannot create one must not grow
 * a "Create …" row that resolves to nothing (BHA review).
 */

const ROWS = [
  createSessionTableRowFixture({ id: "session-1", name: "session/one" }),
  createSessionTableRowFixture({ id: "session-2", name: "session/two" }),
];
const OPTIONS: readonly SessionsBulkActionOption[] = [
  { id: "platform", label: "Platform" },
];
const NOOP_UNDO: SessionsBulkUndo = () => undefined;
const CREATE_ROW_NAME = /^Create “Brand new”$/;
const OPTION_NAME = /^Platform$/;
const SEARCH_NAME = /^Search add to project$/;
const TRIGGER_NAME = /^Add to project$/;

function renderRail(
  onCreateOption?: (label: string) => SessionsBulkActionOption,
  onApply: () => SessionsBulkUndo = () => NOOP_UNDO
) {
  render(
    <SessionsBulkRail
      actions={[
        sessionsBulkPickerAction({
          command: {
            onApply,
            onCreateOption,
            options: OPTIONS,
          },
          icon: null,
          id: "projects",
          label: "Add to project",
        }),
      ]}
      onClear={() => undefined}
      onRetainSelection={() => undefined}
      selectedRows={ROWS}
    />
  );
}

describe("the Sessions picker bulk action", () => {
  it("offers the create row for a command that can create an option", async () => {
    const user = userEvent.setup();
    renderRail((label) => ({ id: label.toLowerCase(), label }));

    await user.click(screen.getByRole("button", { name: TRIGGER_NAME }));
    await user.type(
      screen.getByRole("textbox", { name: SEARCH_NAME }),
      "Brand new"
    );

    expect(screen.getByRole("button", { name: CREATE_ROW_NAME })).toBeVisible();
  });

  it("offers NO create row for a command that cannot", async () => {
    const user = userEvent.setup();
    renderRail(undefined);

    await user.click(screen.getByRole("button", { name: TRIGGER_NAME }));
    await user.type(
      screen.getByRole("textbox", { name: SEARCH_NAME }),
      "Brand new"
    );

    expect(screen.queryByRole("button", { name: CREATE_ROW_NAME })).toBe(null);
    expect(screen.getByText("No matches")).toBeVisible();
  });

  /**
   * The descriptor declares `TableBulkActionUndo.Supported`, so the applied
   * toast owes the reader the Undo that declaration promises. This pins the
   * toast carrying the action at all; the guarantee that a command can never
   * withhold the callback behind it is the type's, not this test's.
   */
  it("offers the Undo its descriptor advertises on the applied toast", async () => {
    const user = userEvent.setup();
    renderRail();

    await user.click(screen.getByRole("button", { name: TRIGGER_NAME }));
    await user.click(screen.getByRole("button", { name: OPTION_NAME }));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Add to project applied to 2 sessions",
        { action: { label: "Undo", onClick: expect.any(Function) } }
      )
    );
  });

  it("retains only refused rows from a per-item command", async () => {
    const retain = vi.fn();
    const clear = vi.fn();
    const descriptor = sessionsBulkPickerAction({
      command: {
        options: OPTIONS,
        onApply: () => ({
          succeededIds: [ROWS[0]!.id],
          failedIds: [ROWS[1]!.id],
          undo: NOOP_UNDO,
        }),
      },
      icon: null,
      id: "projects",
      label: "Add to project",
    });
    if (descriptor.kind !== "picker") {
      throw new Error("Expected picker command");
    }
    await descriptor.onSelect(
      ROWS.map((row) => row.id),
      OPTIONS[0]!,
      { clear, retain }
    );
    expect(retain).toHaveBeenCalledWith([ROWS[1]!.id]);
    expect(clear).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith(
      "Add to project applied to 1 sessions",
      { action: { label: "Undo", onClick: expect.any(Function) } }
    );
    expect(toast.error).toHaveBeenCalledWith("Couldn't add to project");
  });
});
