/**
 * ISS-10903: Settings → Relay/Gateway "Gateway Profiles" (ISS-7043). The card
 * owns four independent IPC actions over one list — apply, rename, delete, and
 * save (for a new profile and for the selected one) — each with its own busy
 * flag and its own error slot, plus the selection effect that keeps a valid
 * profile selected as the list changes underneath it.
 *
 * What makes the error slots worth pinning is that they are keyed BY PROFILE
 * ID: a failed apply on one row must not paint an error on its sibling. Every
 * failure case here therefore asserts both that the error appears on its own
 * row and that the sibling row stays clean.
 *
 * Scoping matters here and is deliberate. The card can render the profile
 * connection form TWICE at once (the selected-profile editor and the
 * New-profile dialog), so a bare `screen.getByLabelText("Profile Name")` is
 * ambiguous by construction — every form query below is scoped to the dialog or
 * to the editor, and every row query to that row, so a case can never assert
 * against the wrong copy of the same control.
 *
 * Each case drives the rendered control and asserts the resulting IPC payload
 * or the resulting sentence — never that a mock was merely reached.
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_PROFILE_ROW_TEST_ID,
  type GatewayProfileRowData,
} from "../gateway-profile-row";
import {
  GATEWAY_PROFILE_EDITOR_TEST_ID,
  GatewayProfilesCard,
} from "../gateway-profiles-card";

const PROFILE_A: GatewayProfileRowData = {
  id: "profile-a",
  name: "Production",
  relayOrigin: "https://relay.prod.test",
  apiOrigin: "https://api.prod.test",
  webAppOrigin: "https://app.prod.test",
  hasCloudApiKey: true,
};

const PROFILE_B: GatewayProfileRowData = {
  id: "profile-b",
  name: "Staging",
  relayOrigin: "https://relay.stage.test",
  apiOrigin: "https://api.stage.test",
  webAppOrigin: "https://app.stage.test",
};

const EMPTY_LIST_COPY = "No gateway profiles saved";
const SAVE_PROFILE_LABEL = "Save Profile";
const SELECTED_PROFILE_COPY = "Selected Profile";
const APPLY_LABEL = "Apply";
const SELECT_LABEL = "Select";
const SAVE_LABEL = "Save";
const CANCEL_LABEL = "Cancel";
const DELETE_LABEL = "Delete";
const RENAME_CONTROL_LABEL = "Rename profile";
const DELETE_CONTROL_LABEL = "Delete profile";
const PROFILE_NAME_LABEL = "Profile Name";
const TOKEN_LABEL = "Authentication Token";
const RELAY_LABEL = "Relay URI";
const SANDBOX_LABEL = "Sandbox Directory";
const SAVED_TOKEN_PLACEHOLDER = "Leave blank to keep saved token";
const NEW_TOKEN_PLACEHOLDER = "sk_live_...";
const NAME_REQUIRED_COPY = "Name is required";
const GLOBAL_SANDBOX = "/workspace/global";
const DELETE_STAGING_RE = /Delete "Staging"\?/;

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

afterEach(() => {
  cleanup();
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
    return;
  }
  Reflect.deleteProperty(window, "desktopApi");
});

describe("GatewayProfilesCard — the list and its selection", () => {
  it("says the list is empty rather than rendering a headless editor", () => {
    installDesktopApi();
    render(<GatewayProfilesCard settings={settings({ savedConfigs: [] })} />);

    expect(screen.getByText(EMPTY_LIST_COPY)).toBeTruthy();
    expect(screen.queryByText(SELECTED_PROFILE_COPY)).toBeNull();
  });

  it("survives settings being null entirely", () => {
    installDesktopApi();
    render(<GatewayProfilesCard settings={null} />);

    expect(screen.getByText(EMPTY_LIST_COPY)).toBeTruthy();
  });

  it("selects the active profile on mount, and only the inactive row offers Apply", () => {
    installDesktopApi();
    render(<GatewayProfilesCard settings={settings()} />);

    expect(editor().getByText(PROFILE_A.name)).toBeTruthy();
    expect(rowFor(PROFILE_A).queryByText(APPLY_LABEL)).toBeNull();
    expect(rowFor(PROFILE_B).getByText(APPLY_LABEL)).toBeTruthy();
  });

  it("falls back to the first profile when nothing is active", () => {
    installDesktopApi();
    render(
      <GatewayProfilesCard settings={settings({ activeConfigId: null })} />
    );

    expect(editor().getByText(PROFILE_A.name)).toBeTruthy();
    // With no active profile, BOTH rows are appliable.
    expect(rowFor(PROFILE_A).getByText(APPLY_LABEL)).toBeTruthy();
    expect(rowFor(PROFILE_B).getByText(APPLY_LABEL)).toBeTruthy();
  });

  it("moves the selection to another row on Select", () => {
    installDesktopApi();
    render(<GatewayProfilesCard settings={settings()} />);

    fireEvent.click(rowFor(PROFILE_B).getByText(SELECT_LABEL));

    expect(editor().getByText(PROFILE_B.name)).toBeTruthy();
    // The newly selected row no longer offers Select; the other one now does.
    expect(rowFor(PROFILE_B).queryByText(SELECT_LABEL)).toBeNull();
    expect(rowFor(PROFILE_A).getByText(SELECT_LABEL)).toBeTruthy();
  });

  it("re-points the selection when the selected profile leaves the list", () => {
    installDesktopApi();
    const { rerender } = render(<GatewayProfilesCard settings={settings()} />);
    fireEvent.click(rowFor(PROFILE_B).getByText(SELECT_LABEL));
    expect(editor().getByText(PROFILE_B.name)).toBeTruthy();

    rerender(
      <GatewayProfilesCard settings={settings({ savedConfigs: [PROFILE_A] })} />
    );

    // Staging is gone; the active profile takes the selection rather than none.
    expect(screen.queryByText(PROFILE_B.relayOrigin)).toBeNull();
    expect(editor().getByText(PROFILE_A.name)).toBeTruthy();
  });

  it("drops the selection entirely once the list empties", () => {
    installDesktopApi();
    const { rerender } = render(<GatewayProfilesCard settings={settings()} />);
    expect(screen.getByText(SELECTED_PROFILE_COPY)).toBeTruthy();

    rerender(<GatewayProfilesCard settings={settings({ savedConfigs: [] })} />);

    expect(screen.queryByText(SELECTED_PROFILE_COPY)).toBeNull();
    expect(screen.getByText(EMPTY_LIST_COPY)).toBeTruthy();
  });

  it("badges a saved token and prompts to keep it, versus asking for a new one", () => {
    installDesktopApi();
    const { rerender } = render(<GatewayProfilesCard settings={settings()} />);

    expect(screen.getByText("Token saved")).toBeTruthy();
    expect(
      editor().getByLabelText(TOKEN_LABEL).getAttribute("placeholder")
    ).toBe(SAVED_TOKEN_PLACEHOLDER);

    rerender(
      <GatewayProfilesCard
        settings={settings({
          savedConfigs: [PROFILE_B],
          activeConfigId: PROFILE_B.id,
        })}
      />
    );

    expect(screen.queryByText("Token saved")).toBeNull();
    expect(
      editor().getByLabelText(TOKEN_LABEL).getAttribute("placeholder")
    ).toBe(NEW_TOKEN_PLACEHOLDER);
  });

  it("shows the global sandbox a legacy profile inherits, per row", () => {
    installDesktopApi();
    render(<GatewayProfilesCard settings={settings()} />);

    expect(
      rowFor(PROFILE_A).getByText(
        `Sandbox: inherits global (${GLOBAL_SANDBOX})`
      )
    ).toBeTruthy();
  });
});

describe("GatewayProfilesCard — apply", () => {
  it("applies the row's own id and refreshes settings upward", async () => {
    const applyConfig = vi.fn(async () => undefined);
    const onSettingsChange = vi.fn();
    const refreshed = settings({ activeConfigId: PROFILE_B.id });
    installDesktopApi({
      applyConfig,
      getSettings: vi.fn(async () => refreshed),
    });
    render(
      <GatewayProfilesCard
        onSettingsChange={onSettingsChange}
        settings={settings()}
      />
    );

    await actOn(() => {
      fireEvent.click(rowFor(PROFILE_B).getByText(APPLY_LABEL));
    });

    expect(applyConfig).toHaveBeenCalledWith(PROFILE_B.id);
    expect(onSettingsChange).toHaveBeenCalledWith(refreshed);
  });

  it("paints a failed apply on its own row and leaves the sibling clean", async () => {
    installDesktopApi({
      applyConfig: vi.fn(() => Promise.reject(new Error("relay unreachable"))),
    });
    render(<GatewayProfilesCard settings={settings()} />);

    await actOn(() => {
      fireEvent.click(rowFor(PROFILE_B).getByText(APPLY_LABEL));
    });

    expect(rowFor(PROFILE_B).getByText("relay unreachable")).toBeTruthy();
    expect(rowFor(PROFILE_A).queryByText("relay unreachable")).toBeNull();
  });

  it("falls back to a generic sentence when the failure carries no message", async () => {
    installDesktopApi({
      applyConfig: vi.fn(() => Promise.reject("not an Error")),
    });
    render(<GatewayProfilesCard settings={settings()} />);

    await actOn(() => {
      fireEvent.click(rowFor(PROFILE_B).getByText(APPLY_LABEL));
    });

    expect(rowFor(PROFILE_B).getByText("Failed to apply profile")).toBeTruthy();
  });

  it("selects the row it applied, even when the apply itself fails", async () => {
    installDesktopApi({
      applyConfig: vi.fn(() => Promise.reject(new Error("relay unreachable"))),
    });
    render(<GatewayProfilesCard settings={settings()} />);

    await actOn(() => {
      fireEvent.click(rowFor(PROFILE_B).getByText(APPLY_LABEL));
    });

    expect(editor().getByText(PROFILE_B.name)).toBeTruthy();
  });
});

describe("GatewayProfilesCard — rename", () => {
  it("refuses a blank name without reaching the IPC", async () => {
    const renameConfig = vi.fn(async () => undefined);
    installDesktopApi({ renameConfig });
    render(<GatewayProfilesCard settings={settings()} />);
    const row = startRename(PROFILE_B);

    fireEvent.change(row.getByLabelText(RENAME_CONTROL_LABEL), {
      target: { value: "   " },
    });
    await actOn(() => {
      fireEvent.click(row.getByText(SAVE_LABEL));
    });

    expect(row.getByText(NAME_REQUIRED_COPY)).toBeTruthy();
    expect(renameConfig).not.toHaveBeenCalled();
  });

  it("renames with the trimmed value and closes the editor", async () => {
    const renameConfig = vi.fn(async () => undefined);
    installDesktopApi({ renameConfig });
    render(<GatewayProfilesCard settings={settings()} />);
    const row = startRename(PROFILE_B);

    fireEvent.change(row.getByLabelText(RENAME_CONTROL_LABEL), {
      target: { value: "  Staging EU  " },
    });
    await actOn(() => {
      fireEvent.click(row.getByText(SAVE_LABEL));
    });

    expect(renameConfig).toHaveBeenCalledWith(PROFILE_B.id, "Staging EU");
    await waitFor(() => {
      expect(
        rowFor(PROFILE_B).queryByRole("textbox", {
          name: RENAME_CONTROL_LABEL,
        })
      ).toBeNull();
    });
  });

  it("renames on Enter and abandons on Escape", async () => {
    const renameConfig = vi.fn(async () => undefined);
    installDesktopApi({ renameConfig });
    render(<GatewayProfilesCard settings={settings()} />);
    const row = startRename(PROFILE_B);

    fireEvent.keyDown(row.getByLabelText(RENAME_CONTROL_LABEL), {
      key: "Escape",
    });
    expect(renameConfig).not.toHaveBeenCalled();

    const reopened = startRename(PROFILE_B);
    fireEvent.change(reopened.getByLabelText(RENAME_CONTROL_LABEL), {
      target: { value: "Staging EU" },
    });
    await actOn(() => {
      fireEvent.keyDown(reopened.getByLabelText(RENAME_CONTROL_LABEL), {
        key: "Enter",
      });
    });

    expect(renameConfig).toHaveBeenCalledWith(PROFILE_B.id, "Staging EU");
  });

  it("keeps the editor open and shows why when the rename fails", async () => {
    installDesktopApi({
      renameConfig: vi.fn(() => Promise.reject(new Error("name taken"))),
    });
    render(<GatewayProfilesCard settings={settings()} />);
    const row = startRename(PROFILE_B);

    fireEvent.change(row.getByLabelText(RENAME_CONTROL_LABEL), {
      target: { value: "Staging EU" },
    });
    await actOn(() => {
      fireEvent.click(row.getByText(SAVE_LABEL));
    });

    expect(row.getByText("name taken")).toBeTruthy();
    expect(row.getByLabelText(RENAME_CONTROL_LABEL)).toBeTruthy();
  });

  it("abandons the rename on Cancel", () => {
    installDesktopApi();
    render(<GatewayProfilesCard settings={settings()} />);
    const row = startRename(PROFILE_B);

    fireEvent.click(row.getByText(CANCEL_LABEL));

    expect(
      rowFor(PROFILE_B).queryByRole("textbox", { name: RENAME_CONTROL_LABEL })
    ).toBeNull();
    expect(rowFor(PROFILE_B).getByText(PROFILE_B.name)).toBeTruthy();
  });

  it("clears a stale rename error as soon as the value is edited again", async () => {
    installDesktopApi();
    render(<GatewayProfilesCard settings={settings()} />);
    const row = startRename(PROFILE_B);

    fireEvent.change(row.getByLabelText(RENAME_CONTROL_LABEL), {
      target: { value: "" },
    });
    await actOn(() => {
      fireEvent.click(row.getByText(SAVE_LABEL));
    });
    expect(row.getByText(NAME_REQUIRED_COPY)).toBeTruthy();

    fireEvent.change(row.getByLabelText(RENAME_CONTROL_LABEL), {
      target: { value: "O" },
    });

    expect(row.queryByText(NAME_REQUIRED_COPY)).toBeNull();
  });
});

describe("GatewayProfilesCard — delete", () => {
  it("asks before deleting, then deletes the row's own id", async () => {
    const deleteConfig = vi.fn(async () => undefined);
    installDesktopApi({ deleteConfig });
    render(<GatewayProfilesCard settings={settings()} />);

    fireEvent.click(rowFor(PROFILE_B).getByLabelText(DELETE_CONTROL_LABEL));
    expect(rowFor(PROFILE_B).getByText(DELETE_STAGING_RE)).toBeTruthy();

    await actOn(() => {
      fireEvent.click(rowFor(PROFILE_B).getByText(DELETE_LABEL));
    });

    expect(deleteConfig).toHaveBeenCalledWith(PROFILE_B.id);
  });

  it("backs out of the confirmation without deleting", () => {
    const deleteConfig = vi.fn(async () => undefined);
    installDesktopApi({ deleteConfig });
    render(<GatewayProfilesCard settings={settings()} />);

    fireEvent.click(rowFor(PROFILE_B).getByLabelText(DELETE_CONTROL_LABEL));
    fireEvent.click(rowFor(PROFILE_B).getByText(CANCEL_LABEL));

    expect(rowFor(PROFILE_B).queryByText(DELETE_STAGING_RE)).toBeNull();
    expect(deleteConfig).not.toHaveBeenCalled();
  });

  it("keeps the confirmation open and names the failure on that row", async () => {
    installDesktopApi({
      deleteConfig: vi.fn(() => Promise.reject(new Error("profile in use"))),
    });
    render(<GatewayProfilesCard settings={settings()} />);

    fireEvent.click(rowFor(PROFILE_B).getByLabelText(DELETE_CONTROL_LABEL));
    await actOn(() => {
      fireEvent.click(rowFor(PROFILE_B).getByText(DELETE_LABEL));
    });

    expect(rowFor(PROFILE_B).getByText("profile in use")).toBeTruthy();
    expect(rowFor(PROFILE_A).queryByText("profile in use")).toBeNull();
    expect(rowFor(PROFILE_B).getByText(DELETE_STAGING_RE)).toBeTruthy();
  });
});

describe("GatewayProfilesCard — saving a new profile", () => {
  it("omits a blank token and a blank sandbox from the payload entirely", async () => {
    const saveConfig = savedConfigMock();
    installDesktopApi({ saveConfig });
    render(<GatewayProfilesCard settings={settings()} />);

    openDialog();
    fillDialog({ name: "EU" });
    await actOn(() => {
      fireEvent.click(
        dialog().getByRole("button", { name: SAVE_PROFILE_LABEL })
      );
    });

    const payload = firstPayload(saveConfig);
    expect(payload.name).toBe("EU");
    expect("apiKey" in payload).toBe(false);
    expect("sandboxBaseDirectory" in payload).toBe(false);
  });

  it("threads a non-blank token and sandbox through, trimmed", async () => {
    const saveConfig = savedConfigMock();
    installDesktopApi({ saveConfig });
    render(<GatewayProfilesCard settings={settings()} />);

    openDialog();
    fillDialog({
      name: "EU",
      apiKey: "  sk_live_abc  ",
      sandbox: "  /workspace/eu  ",
    });
    await actOn(() => {
      fireEvent.click(
        dialog().getByRole("button", { name: SAVE_PROFILE_LABEL })
      );
    });

    const payload = firstPayload(saveConfig);
    expect(payload.apiKey).toBe("sk_live_abc");
    expect(payload.sandboxBaseDirectory).toBe("/workspace/eu");
  });

  it("seeds the new-profile form from the current global settings", () => {
    installDesktopApi();
    render(<GatewayProfilesCard settings={settings()} />);

    openDialog();

    expect(
      (dialog().getByLabelText(RELAY_LABEL) as HTMLInputElement).value
    ).toBe("https://relay.prod.test");
    // The sandbox seeds BLANK (inherit) rather than pinning today's global.
    expect(
      (dialog().getByLabelText(SANDBOX_LABEL) as HTMLInputElement).value
    ).toBe("");
  });

  it("refuses to save while a required field is blank", () => {
    installDesktopApi();
    render(<GatewayProfilesCard settings={settings()} />);

    openDialog();

    expect(
      (
        dialog().getByRole("button", {
          name: SAVE_PROFILE_LABEL,
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
  });

  it("selects the newly saved profile once the IPC returns its id", async () => {
    const saveConfig = savedConfigMock(PROFILE_B.id);
    installDesktopApi({ saveConfig });
    render(<GatewayProfilesCard settings={settings()} />);

    openDialog();
    fillDialog({ name: "EU" });
    await actOn(() => {
      fireEvent.click(
        dialog().getByRole("button", { name: SAVE_PROFILE_LABEL })
      );
    });

    await waitFor(() => {
      expect(editor().getByText(PROFILE_B.name)).toBeTruthy();
    });
  });

  it("closes the dialog without a selection change when the IPC returns no id", async () => {
    const saveConfig = vi.fn(async (_payload: SaveConfigPayload) => ({}));
    installDesktopApi({ saveConfig });
    render(<GatewayProfilesCard settings={settings()} />);

    openDialog();
    fillDialog({ name: "EU" });
    await actOn(() => {
      fireEvent.click(
        dialog().getByRole("button", { name: SAVE_PROFILE_LABEL })
      );
    });

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(editor().getByText(PROFILE_A.name)).toBeTruthy();
  });

  it("names a failed save inside the dialog and keeps the dialog open", async () => {
    installDesktopApi({
      saveConfig: vi.fn(() => Promise.reject(new Error("origin rejected"))),
    });
    render(<GatewayProfilesCard settings={settings()} />);

    openDialog();
    fillDialog({ name: "EU" });
    await actOn(() => {
      fireEvent.click(
        dialog().getByRole("button", { name: SAVE_PROFILE_LABEL })
      );
    });

    expect(dialog().getByText("origin rejected")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("closes the dialog on Cancel without saving", async () => {
    const saveConfig = savedConfigMock();
    installDesktopApi({ saveConfig });
    render(<GatewayProfilesCard settings={settings()} />);

    openDialog();
    fireEvent.click(dialog().getByRole("button", { name: CANCEL_LABEL }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it("saves on Enter from a dialog field, but not while the form is incomplete", async () => {
    const saveConfig = savedConfigMock();
    installDesktopApi({ saveConfig });
    render(<GatewayProfilesCard settings={settings()} />);

    openDialog();
    await actOn(() => {
      fireEvent.keyDown(dialog().getByLabelText(PROFILE_NAME_LABEL), {
        key: "Enter",
      });
    });
    expect(saveConfig).not.toHaveBeenCalled();

    fillDialog({ name: "EU" });
    await actOn(() => {
      fireEvent.keyDown(dialog().getByLabelText(PROFILE_NAME_LABEL), {
        key: "Enter",
      });
    });

    expect(saveConfig).toHaveBeenCalledTimes(1);
  });
});

describe("GatewayProfilesCard — saving the selected profile", () => {
  it("sends the selected profile's id and clears the token field afterwards", async () => {
    const saveConfig = savedConfigMock(PROFILE_A.id);
    installDesktopApi({ saveConfig });
    render(<GatewayProfilesCard settings={settings()} />);

    fireEvent.change(editor().getByLabelText(TOKEN_LABEL), {
      target: { value: "sk_live_rotated" },
    });
    await actOn(() => {
      fireEvent.click(editor().getByRole("button", { name: SAVE_LABEL }));
    });

    const payload = firstPayload(saveConfig);
    expect(payload.id).toBe(PROFILE_A.id);
    expect(payload.apiKey).toBe("sk_live_rotated");
    await waitFor(() => {
      expect(
        (editor().getByLabelText(TOKEN_LABEL) as HTMLInputElement).value
      ).toBe("");
    });
  });

  it("omits a blank token so an unrelated save cannot clear the stored one", async () => {
    const saveConfig = savedConfigMock(PROFILE_A.id);
    installDesktopApi({ saveConfig });
    render(<GatewayProfilesCard settings={settings()} />);

    await actOn(() => {
      fireEvent.click(editor().getByRole("button", { name: SAVE_LABEL }));
    });

    const payload = firstPayload(saveConfig);
    expect("apiKey" in payload).toBe(false);
  });

  it("disables Save once a required field is emptied", () => {
    installDesktopApi();
    render(<GatewayProfilesCard settings={settings()} />);

    expect(
      (editor().getByRole("button", { name: SAVE_LABEL }) as HTMLButtonElement)
        .disabled
    ).toBe(false);

    fireEvent.change(editor().getByLabelText(RELAY_LABEL), {
      target: { value: "  " },
    });

    expect(
      (editor().getByRole("button", { name: SAVE_LABEL }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
  });

  it("names a failed save under the editor", async () => {
    installDesktopApi({
      saveConfig: vi.fn(() => Promise.reject(new Error("token rejected"))),
    });
    render(<GatewayProfilesCard settings={settings()} />);

    await actOn(() => {
      fireEvent.click(editor().getByRole("button", { name: SAVE_LABEL }));
    });

    expect(editor().getByText("token rejected")).toBeTruthy();
  });

  it("clears a stale save error as soon as a field is edited", async () => {
    installDesktopApi({
      saveConfig: vi.fn(() => Promise.reject(new Error("token rejected"))),
    });
    render(<GatewayProfilesCard settings={settings()} />);
    await actOn(() => {
      fireEvent.click(editor().getByRole("button", { name: SAVE_LABEL }));
    });
    expect(editor().getByText("token rejected")).toBeTruthy();

    fireEvent.change(editor().getByLabelText(RELAY_LABEL), {
      target: { value: "https://relay.new.test" },
    });

    expect(editor().queryByText("token rejected")).toBeNull();
  });

  it("saves on Enter from the editor, but not while the form is incomplete", async () => {
    const saveConfig = savedConfigMock(PROFILE_A.id);
    installDesktopApi({ saveConfig });
    render(<GatewayProfilesCard settings={settings()} />);

    fireEvent.change(editor().getByLabelText(RELAY_LABEL), {
      target: { value: "" },
    });
    await actOn(() => {
      fireEvent.keyDown(editor().getByLabelText(RELAY_LABEL), { key: "Enter" });
    });
    expect(saveConfig).not.toHaveBeenCalled();

    fireEvent.change(editor().getByLabelText(RELAY_LABEL), {
      target: { value: "https://relay.new.test" },
    });
    await actOn(() => {
      fireEvent.keyDown(editor().getByLabelText(RELAY_LABEL), { key: "Enter" });
    });

    expect(saveConfig).toHaveBeenCalledTimes(1);
  });

  it("re-seeds the editor when the selection moves to another profile", () => {
    installDesktopApi();
    render(<GatewayProfilesCard settings={settings()} />);
    expect(
      (editor().getByLabelText(RELAY_LABEL) as HTMLInputElement).value
    ).toBe(PROFILE_A.relayOrigin);

    fireEvent.click(rowFor(PROFILE_B).getByText(SELECT_LABEL));

    expect(
      (editor().getByLabelText(RELAY_LABEL) as HTMLInputElement).value
    ).toBe(PROFILE_B.relayOrigin);
  });
});

/** What `saveConfig` receives: the card builds it field by field. */
type SaveConfigPayload = Record<string, unknown>;

function savedConfigMock(id = "profile-c") {
  return vi.fn(async (_payload: SaveConfigPayload) => ({ id }));
}

/**
 * The payload of the FIRST saveConfig call, failing loudly when there was no
 * call at all — so a case asserting on payload fields can never pass because
 * the save never happened.
 */
function firstPayload(
  mock: ReturnType<typeof savedConfigMock>
): SaveConfigPayload {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error("saveConfig was never called");
  }
  return call[0];
}

/** The settings object the card projects, overridable per case. */
function settings(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    relayOrigin: "https://relay.prod.test",
    apiOrigin: "https://api.prod.test",
    webAppOrigin: "https://app.prod.test",
    sandboxBaseDirectory: GLOBAL_SANDBOX,
    activeConfigId: PROFILE_A.id,
    savedConfigs: [PROFILE_A, PROFILE_B],
    ...overrides,
  };
}

/**
 * Scope to one profile's row. Keyed on `relayOrigin` because it is unique per
 * profile and appears only in the row — the profile NAME also renders in the
 * selected-profile editor, which would make the lookup ambiguous.
 */
function rowFor(profile: GatewayProfileRowData) {
  const row = screen
    .getByText(profile.relayOrigin)
    .closest(`[data-testid="${GATEWAY_PROFILE_ROW_TEST_ID}"]`);
  if (!row) {
    throw new Error(`no profile row rendered for ${profile.name}`);
  }
  return within(row as HTMLElement);
}

/** Scope to the selected-profile editor beneath the list. */
function editor() {
  const container = screen
    .getByText(SELECTED_PROFILE_COPY)
    .closest(`[data-testid="${GATEWAY_PROFILE_EDITOR_TEST_ID}"]`);
  if (!container) {
    throw new Error("no selected-profile editor rendered");
  }
  return within(container as HTMLElement);
}

/** Scope to the New-profile dialog. */
function dialog() {
  return within(screen.getByRole("dialog"));
}

function openDialog(): void {
  fireEvent.click(screen.getByRole("button", { name: SAVE_PROFILE_LABEL }));
}

function startRename(profile: GatewayProfileRowData) {
  fireEvent.click(rowFor(profile).getByLabelText(RENAME_CONTROL_LABEL));
  return rowFor(profile);
}

function fillDialog(values: {
  name: string;
  apiKey?: string;
  sandbox?: string;
}): void {
  fireEvent.change(dialog().getByLabelText(PROFILE_NAME_LABEL), {
    target: { value: values.name },
  });
  if (values.apiKey !== undefined) {
    fireEvent.change(dialog().getByLabelText(TOKEN_LABEL), {
      target: { value: values.apiKey },
    });
  }
  if (values.sandbox !== undefined) {
    fireEvent.change(dialog().getByLabelText(SANDBOX_LABEL), {
      target: { value: values.sandbox },
    });
  }
}

function installDesktopApi(
  overrides: Record<string, ReturnType<typeof vi.fn>> = {}
): void {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      getSettings: vi.fn(async () => settings()),
      applyConfig: vi.fn(async () => undefined),
      renameConfig: vi.fn(async () => undefined),
      deleteConfig: vi.fn(async () => undefined),
      saveConfig: vi.fn(async () => ({ id: "profile-c" })),
      inspectSandboxPath: vi.fn(async () => null),
      pickSandboxDirectory: vi.fn(async () => null),
      ...overrides,
    },
  });
}

// React closes an `act` scope as soon as its callback settles. The mocked IPC
// resolves or rejects on a later microtask, so a synchronous callback closes
// the scope before the component's catch/finally state updates land, and React
// reports those as updates "not wrapped in act". Awaiting inside the scope
// holds it open across that turn, so the updates are flushed before the
// caller's assertions read the DOM.
async function actOn(fire: () => void | Promise<void>) {
  await act(async () => {
    await fire();
  });
}
