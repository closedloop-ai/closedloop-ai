/**
 * ISS-5301: the Settings → gateway profiles row. It is a pure presentational
 * projection of one saved profile, but it carries the whole per-row state
 * machine — rename in progress, apply in flight, delete confirmation, and the
 * three independent error slots — and each of those decides which controls the
 * user is offered. These assert the rendered affordances and the callbacks they
 * fire, not just that the row mounts.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  GatewayProfileRow,
  type GatewayProfileRowData,
  type GatewayProfileRowProps,
} from "../gateway-profile-row";

const PROFILE: GatewayProfileRowData = {
  id: "profile-1",
  name: "Staging",
  relayOrigin: "wss://relay.stage.example",
  apiOrigin: "https://api.stage.example",
  webAppOrigin: "https://app.stage.example",
};

function renderRow(overrides: Partial<GatewayProfileRowProps> = {}) {
  const handlers = {
    onStartRename: vi.fn(),
    onRenameValueChange: vi.fn(),
    onRename: vi.fn(),
    onCancelRename: vi.fn(),
    onSelect: vi.fn(),
    onApply: vi.fn(),
    onStartDelete: vi.fn(),
    onConfirmDelete: vi.fn(),
    onCancelDelete: vi.fn(),
  };
  const props: GatewayProfileRowProps = {
    profile: PROFILE,
    globalSandbox: "",
    isActive: false,
    isSelected: false,
    isRenaming: false,
    renameValue: "",
    renameError: null,
    renameBusy: false,
    applying: false,
    applyError: null,
    confirmingDelete: false,
    deleting: false,
    deleteError: null,
    ...handlers,
    ...overrides,
  };
  render(<GatewayProfileRow {...props} />);
  return handlers;
}

describe("GatewayProfileRow — resting state", () => {
  it("shows the profile origins and the rename/delete affordances", () => {
    const handlers = renderRow();

    expect(screen.getByText("Staging")).toBeTruthy();
    expect(screen.getByText("wss://relay.stage.example")).toBeTruthy();
    expect(
      screen.getByText("https://api.stage.example - https://app.stage.example")
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Rename profile" }));
    expect(handlers.onStartRename).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Delete profile" }));
    expect(handlers.onStartDelete).toHaveBeenCalledTimes(1);
  });

  it("offers Select while the row is not already selected", () => {
    const handlers = renderRow({ isSelected: false });

    fireEvent.click(screen.getByRole("button", { name: "Select" }));

    expect(handlers.onSelect).toHaveBeenCalledTimes(1);
  });

  it("drops Select once the row is the selected one", () => {
    renderRow({ isSelected: true });

    expect(screen.queryByRole("button", { name: "Select" })).toBeNull();
  });

  it("offers Apply while the profile is not the active one", () => {
    const handlers = renderRow({ isActive: false });

    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(handlers.onApply).toHaveBeenCalledTimes(1);
  });

  it("badges the active profile and drops its Apply button", () => {
    renderRow({ isActive: true });

    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  });

  it("disables Apply and says so while an apply is in flight", () => {
    renderRow({ applying: true });

    const applying = screen.getByRole("button", { name: "Applying..." });
    expect((applying as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("GatewayProfileRow — sandbox scope line", () => {
  it("names the profile's own sandbox root when it has one", () => {
    renderRow({
      profile: { ...PROFILE, sandboxBaseDirectory: "/srv/scope" },
      globalSandbox: "/home/global",
    });

    expect(screen.getByText("Sandbox: /srv/scope")).toBeTruthy();
  });

  it("says it inherits the global root, and names it, on a pre-FEA-4005 profile", () => {
    renderRow({ globalSandbox: "/home/global" });

    expect(
      screen.getByText("Sandbox: inherits global (/home/global)")
    ).toBeTruthy();
  });

  it("omits the parenthetical when no global root is configured", () => {
    renderRow({ globalSandbox: "" });

    expect(screen.getByText("Sandbox: inherits global")).toBeTruthy();
  });
});

describe("GatewayProfileRow — renaming", () => {
  it("swaps the name for an input and commits on Enter", () => {
    const handlers = renderRow({ isRenaming: true, renameValue: "Staging" });

    const input = screen.getByRole("textbox", { name: "Rename profile" });
    fireEvent.change(input, { target: { value: "Stage 2" } });
    expect(handlers.onRenameValueChange).toHaveBeenCalledWith("Stage 2");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(handlers.onRename).toHaveBeenCalledTimes(1);
  });

  it("abandons the rename on Escape", () => {
    const handlers = renderRow({ isRenaming: true, renameValue: "Staging" });

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Rename profile" }), {
      key: "Escape",
    });

    expect(handlers.onCancelRename).toHaveBeenCalledTimes(1);
    expect(handlers.onRename).not.toHaveBeenCalled();
  });

  it("ignores unrelated keys so typing never commits by accident", () => {
    const handlers = renderRow({ isRenaming: true, renameValue: "Staging" });

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Rename profile" }), {
      key: "a",
    });

    expect(handlers.onRename).not.toHaveBeenCalled();
    expect(handlers.onCancelRename).not.toHaveBeenCalled();
  });

  it("locks the input and both buttons while the rename is saving", () => {
    renderRow({ isRenaming: true, renameValue: "Staging", renameBusy: true });

    expect(
      (
        screen.getByRole("textbox", {
          name: "Rename profile",
        }) as HTMLInputElement
      ).disabled
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Saving..." }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
  });

  it("commits from the Save button too", () => {
    const handlers = renderRow({ isRenaming: true, renameValue: "Stage 2" });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(handlers.onRename).toHaveBeenCalledTimes(1);
  });

  it("surfaces a rename error only while renaming", () => {
    renderRow({
      isRenaming: true,
      renameValue: "Staging",
      renameError: "That name is taken",
    });
    expect(screen.getByText("That name is taken")).toBeTruthy();
  });

  it("hides a stale rename error once the rename is closed", () => {
    renderRow({ isRenaming: false, renameError: "That name is taken" });

    expect(screen.queryByText("That name is taken")).toBeNull();
  });
});

describe("GatewayProfileRow — errors and delete confirmation", () => {
  it("surfaces an apply error next to the row", () => {
    renderRow({ applyError: "Relay unreachable" });

    expect(screen.getByText("Relay unreachable")).toBeTruthy();
  });

  it("names the profile in the confirmation and wires both answers", () => {
    const handlers = renderRow({ confirmingDelete: true });

    expect(
      screen.getByText('Delete "Staging"? This cannot be undone.')
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(handlers.onConfirmDelete).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(handlers.onCancelDelete).toHaveBeenCalledTimes(1);
  });

  it("locks both answers while the delete is in flight", () => {
    renderRow({ confirmingDelete: true, deleting: true });

    expect(
      (screen.getByRole("button", { name: "Deleting..." }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
  });

  it("shows a delete error inside the confirmation block", () => {
    renderRow({ confirmingDelete: true, deleteError: "Profile is in use" });

    expect(screen.getByText("Profile is in use")).toBeTruthy();
  });

  it("keeps the confirmation closed until it is asked for", () => {
    renderRow({ confirmingDelete: false, deleteError: "Profile is in use" });

    expect(screen.queryByText("Profile is in use")).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });
});
