import { DISPLAYED_ARTIFACT_STATUS } from "@repo/api/src/types/artifact-status";
import { ARTIFACT_STATUS_DISPLAY_LABELS } from "@repo/api/src/types/artifact-status-display";
import {
  GenericArtifactKind,
  GenericArtifactStatus,
} from "@repo/app/shared/components/generic-artifact-surface/generic-artifact-status";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ArtifactCreationStatusPicker } from "../artifact-creation-status-picker";

describe("creation status picker", () => {
  it("puts selectable Issue parents ahead of their own indented details", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ArtifactCreationStatusPicker
        kind={GenericArtifactKind.Issue}
        onChange={onChange}
        status={GenericArtifactStatus.InReview}
      />
    );

    await user.click(screen.getByRole("button", { name: "Change status…" }));
    const todo = await screen.findByRole("option", { name: "Todo" });
    const triage = screen.getByRole("option", { name: "Todo, Triage" });
    const backlog = screen.getByRole("option", { name: "Todo, Backlog" });
    const options = screen.getAllByRole("option");
    expect(options.indexOf(todo)).toBeLessThan(options.indexOf(triage));
    expect(options.indexOf(triage)).toBeLessThan(options.indexOf(backlog));
    expect(triage).toHaveClass("ml-3");
    expect(backlog).toHaveClass("ml-3");
    expect(screen.queryByText("1")).toBeNull();
    expect(screen.queryByText("Status and detail")).toBeNull();

    await user.click(todo);
    expect(onChange).toHaveBeenCalledWith(GenericArtifactStatus.Todo);
    expect(
      screen.queryByRole("option", {
        name: ARTIFACT_STATUS_DISPLAY_LABELS[DISPLAYED_ARTIFACT_STATUS.Todo],
      })
    ).toBeNull();
  });

  it("shows Document roots without inventing unavailable parent-only writes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ArtifactCreationStatusPicker
        kind={GenericArtifactKind.Document}
        onChange={onChange}
        status={GenericArtifactStatus.Draft}
      />
    );

    await user.click(screen.getByRole("button", { name: "Change status…" }));
    const drafting = await screen.findByRole("option", {
      name: "In progress, Drafting",
    });
    const approved = screen.getByRole("option", { name: "Done, Approved" });
    expect(drafting).toHaveClass("ml-3");
    expect(approved).toHaveClass("ml-3");
    expect(
      screen.queryByRole("option", {
        name: ARTIFACT_STATUS_DISPLAY_LABELS[
          DISPLAYED_ARTIFACT_STATUS.InProgress
        ],
      })
    ).toBeNull();
    expect(
      screen.queryByRole("option", {
        name: ARTIFACT_STATUS_DISPLAY_LABELS[DISPLAYED_ARTIFACT_STATUS.Done],
      })
    ).toBeNull();
    expect(
      screen.queryByRole("option", {
        name: ARTIFACT_STATUS_DISPLAY_LABELS[
          DISPLAYED_ARTIFACT_STATUS.Canceled
        ],
      })
    ).toBeNull();
    expect(
      screen.getByRole("option", { name: "In review" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "In progress, Blocked" })
    ).toBeNull();

    await user.type(screen.getByPlaceholderText("Change status…"), "Approved");
    expect(
      screen.getByRole("option", { name: "Done, Approved" })
    ).toBeInTheDocument();
    await user.click(approved);
    expect(onChange).toHaveBeenCalledWith(GenericArtifactStatus.Approved);
  });

  it("does not turn provider-derived Branch status into an editable choice", () => {
    render(
      <ArtifactCreationStatusPicker
        kind={GenericArtifactKind.Branch}
        onChange={vi.fn()}
        status={GenericArtifactStatus.Active}
      />
    );

    expect(
      screen.getByRole("button", { name: "Change status…" })
    ).toBeDisabled();
    expect(screen.queryByRole("option")).toBeNull();
  });
});
