import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopAppPanel } from "../../../settings-v2/panels/desktop-app-panel";
import {
  awaitSecuritySection,
  installSecurityTabDesktopApi,
  restoreDesktopApi,
} from "./security-tab-desktop-api-fixture";

// Behavioral replacement for the old renderer-logs-static source-text guard:
// mount the real Desktop App panel, which is where the Security block ships,
// and assert the
// SecurityTab wires the desktop API-key IPC (getApiKeyStatus on mount,
// setApiKey / clearApiKey on the Set / Clear controls).

afterEach(restoreDesktopApi);

describe("Settings Security block API-key controls", () => {
  it("reads the API key status on mount", async () => {
    const api = installSecurityTabDesktopApi();
    render(<DesktopAppPanel />);

    await awaitSecuritySection();

    await waitFor(() => expect(api.getApiKeyStatus).toHaveBeenCalled());
  });

  it("stores a typed key through setApiKey when Set is clicked", async () => {
    const api = installSecurityTabDesktopApi();
    render(<DesktopAppPanel />);
    await awaitSecuritySection();

    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "sk_live_example" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    await waitFor(() =>
      expect(api.setApiKey).toHaveBeenCalledWith("sk_live_example")
    );
  });

  it("removes the stored key through clearApiKey when Clear is clicked", async () => {
    const api = installSecurityTabDesktopApi();
    render(<DesktopAppPanel />);
    await awaitSecuritySection();

    const clearButton = screen.getByRole("button", { name: "Clear" });
    await waitFor(() =>
      expect((clearButton as HTMLButtonElement).disabled).toBe(false)
    );
    fireEvent.click(clearButton);

    await waitFor(() => expect(api.clearApiKey).toHaveBeenCalled());
  });
});
