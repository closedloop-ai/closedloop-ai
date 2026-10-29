import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DeleteConfirmationDialog } from "../delete-confirmation-dialog";

/**
 * ISS-12537 (AC-003): the deletion scope review EXTENDS the shared delete
 * confirmation dialog, so every existing caller (documents, artifacts, teams,
 * projects) must render exactly what it rendered before. Those callers' own
 * tests mock this dialog away, so this pins its legacy render directly: the
 * props every caller passes today, and nothing else.
 *
 * This file was run green against origin/main's dialog BEFORE the extension
 * landed, then again after it, so it describes the shipped render rather than
 * the new one.
 */
function renderLegacy(description?: string) {
  return render(
    <DeleteConfirmationDialog
      description={description}
      itemName="Editor refresh"
      onConfirm={vi.fn(async () => true)}
      onOpenChange={vi.fn()}
      open
      title="Project"
    />
  );
}

describe("DeleteConfirmationDialog legacy render (no scope review)", () => {
  it("renders the title, default description and two buttons, nothing more", () => {
    renderLegacy();
    const dialog = screen.getByRole("dialog", { name: "Delete Project" });
    expect(dialog).toHaveAccessibleDescription(
      'Are you sure you want to delete "Editor refresh"? This action cannot be undone.'
    );
    expect(
      within(dialog)
        .getAllByRole("button")
        .map((button) => button.textContent)
    ).toEqual(["Cancel", "Delete", "Close"]);
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
    expect(within(dialog).queryByRole("group")).toBeNull();
    expect(within(dialog).queryByRole("list")).toBeNull();
    expect(
      within(dialog).getByRole("button", { name: "Delete" })
    ).toBeEnabled();
  });

  it("keeps a caller's description override verbatim", () => {
    const override = "fixture-description-override";
    renderLegacy(override);
    expect(
      screen.getByRole("dialog", { name: "Delete Project" })
    ).toHaveAccessibleDescription(override);
  });
});
