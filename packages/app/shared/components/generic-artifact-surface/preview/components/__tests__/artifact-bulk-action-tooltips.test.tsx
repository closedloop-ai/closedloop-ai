// @vitest-environment jsdom

import { ARTIFACT_STATUS_ROOT } from "@repo/api/src/types/artifact-status";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  GenericArtifactKind,
  GenericArtifactStatus,
  genericArtifactCompatibleStatusOptions,
} from "../../../generic-artifact-status";
import { ArtifactBulkActionBar } from "../artifact-list-control-adapters";

const PICKER_LABELS = [
  "Add to project",
  "Assign owner",
  "Add tag",
  "Change status",
  "Move to project",
] as const;

function renderBulkActions() {
  const onAction = vi.fn();
  const onProjectMove = vi.fn();
  const onStatusChange = vi.fn();
  render(
    <ArtifactBulkActionBar
      count={2}
      currentTags={[]}
      noun={{ plural: "artifacts", singular: "artifact" }}
      onAction={onAction}
      onClear={vi.fn()}
      onProjectMove={onProjectMove}
      onStatusChange={onStatusChange}
      projectMoveDestinations={[{ id: "destination", label: "Platform" }]}
      statusOptions={genericArtifactCompatibleStatusOptions([
        { kind: GenericArtifactKind.Issue, status: GenericArtifactStatus.Todo },
      ])}
    />
  );
  return { onAction, onProjectMove, onStatusChange };
}

describe("ArtifactBulkActionBar picker tooltips", () => {
  it("labels the favorite action without repeating the selected noun", async () => {
    const { onAction } = renderBulkActions();
    const trigger = screen.getByRole("button", { name: "Favorite" });

    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    fireEvent.pointerMove(trigger, { pointerType: "mouse" });
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Favorite");
    fireEvent.click(trigger);

    expect(onAction).toHaveBeenCalledWith("favorite");
  });

  it.each(PICKER_LABELS)(
    "shows the %s action name on keyboard focus",
    async (label) => {
      renderBulkActions();
      const trigger = screen.getByRole("button", { name: label });

      fireEvent.keyDown(trigger, { key: "Tab" });
      fireEvent.focus(trigger);

      expect(await screen.findByRole("tooltip")).toHaveTextContent(label);
    }
  );

  it("shows the picker name on pointer hover and still selects its option", async () => {
    const { onProjectMove } = renderBulkActions();
    const trigger = screen.getByRole("button", { name: "Move to project" });

    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    fireEvent.pointerMove(trigger, { pointerType: "mouse" });
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Move to project"
    );
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("button", { name: "Platform" }));

    expect(onProjectMove).toHaveBeenCalledWith("Platform");
  });

  it("opens Change status and commits the selected canonical status", async () => {
    const { onStatusChange } = renderBulkActions();
    const trigger = screen.getByRole("button", { name: "Change status" });

    fireEvent.keyDown(trigger, { key: "Tab" });
    fireEvent.focus(trigger);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Change status"
    );
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("button", { name: "In progress" }));

    expect(onStatusChange).toHaveBeenCalledWith(
      ARTIFACT_STATUS_ROOT.InProgress
    );
  });
});
