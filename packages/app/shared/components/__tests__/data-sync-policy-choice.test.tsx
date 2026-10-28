import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DATA_SYNC_LEVEL_COPY } from "../../lib/data-sync-copy";
import { offeredDataSyncLevelsWithoutRedaction } from "../../lib/data-sync-level-options";
import { DataSyncPolicyChoice } from "../data-sync-policy-choice";
import { DataSyncPolicyChoiceDemo } from "../data-sync-policy-choice-demo";

const unsetMessage = /This device has not saved a sync choice yet/;
const offName = DATA_SYNC_LEVEL_COPY[DataSyncLevel.Off].title;

describe("ISS-12523 sync policy choice", () => {
  it("leaves every option unchecked and save disabled while unset", () => {
    render(<DataSyncPolicyChoiceDemo />);
    expect(screen.getByText(unsetMessage)).toBeVisible();
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).toHaveAttribute("aria-checked", "false");
    }
    expect(
      screen.getByRole("button", { name: "Save sync choice" })
    ).toBeDisabled();
  });

  it("distinguishes a pending Off selection from a saved explicit Off choice", () => {
    render(<DataSyncPolicyChoiceDemo />);
    fireEvent.click(screen.getByRole("radio", { name: offName }));
    expect(screen.getByText(unsetMessage)).toBeVisible();
    const save = screen.getByRole("button", { name: "Save sync choice" });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    expect(screen.queryByText(unsetMessage)).not.toBeInTheDocument();
    expect(screen.getByText("Current level").parentElement).toHaveTextContent(
      DATA_SYNC_LEVEL_COPY[DataSyncLevel.Off].badgeLabel
    );
    expect(screen.getByRole("radio", { name: offName })).toHaveAttribute(
      "aria-checked",
      "true"
    );
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.getByText(unsetMessage)).toBeVisible();
    expect(screen.getByRole("radio", { name: offName })).toHaveAttribute(
      "aria-checked",
      "false"
    );
  });

  it("keeps an in-flight first choice locked without claiming it was saved", () => {
    const onSelect = vi.fn();
    const onSave = vi.fn();
    render(
      <DataSyncPolicyChoice
        currentLevel={null}
        isWriting
        levels={offeredDataSyncLevelsWithoutRedaction(null)}
        onSave={onSave}
        onSelect={onSelect}
        selectedLevel={DataSyncLevel.Off}
      />
    );
    fireEvent.click(
      screen.getByRole("radio", {
        name: DATA_SYNC_LEVEL_COPY[DataSyncLevel.Full].title,
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "Saving" }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText(unsetMessage)).toBeVisible();
  });
});
