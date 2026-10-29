import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopAppPanel } from "../../../settings-v2/panels/desktop-app-panel";
import {
  awaitSecuritySection,
  installSecurityTabDesktopApi,
  restoreDesktopApi,
} from "./security-tab-desktop-api-fixture";

// Covers the SecurityTab branches not exercised by the sibling API-key suites:
// the blank-input guard on Set, the Enter-key submit path on the API-key field,
// and the inline error rendering both with and without a failure.

const NO_API_KEY_ERROR_RE = /failed to set api key/i;

afterEach(restoreDesktopApi);

describe("SecurityTab — blank-input guard, Enter submit, and error rendering", () => {
  it("does not call setApiKey when Enter is pressed on a blank (whitespace only) field", async () => {
    const api = installSecurityTabDesktopApi();
    render(<DesktopAppPanel />);
    await awaitSecuritySection();

    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "   " },
    });
    const setButton = screen.getByRole("button", { name: "Set" });
    expect((setButton as HTMLButtonElement).disabled).toBe(true);
    // A disabled button never fires onClick; Enter reaches handleSetApiKey directly.
    fireEvent.keyDown(screen.getByLabelText("API key"), { key: "Enter" });

    expect(api.setApiKey).not.toHaveBeenCalled();
  });

  it("submits the trimmed key on Enter in the API-key field", async () => {
    const api = installSecurityTabDesktopApi();
    render(<DesktopAppPanel />);
    await awaitSecuritySection();

    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "sk_live_enter_example" },
    });
    fireEvent.keyDown(screen.getByLabelText("API key"), { key: "Enter" });

    await waitFor(() =>
      expect(api.setApiKey).toHaveBeenCalledWith("sk_live_enter_example")
    );
  });

  it("does not submit on a non-Enter key in the API-key field", async () => {
    const api = installSecurityTabDesktopApi();
    render(<DesktopAppPanel />);
    await awaitSecuritySection();

    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "sk_live_should_not_submit" },
    });
    fireEvent.keyDown(screen.getByLabelText("API key"), { key: "a" });

    expect(api.setApiKey).not.toHaveBeenCalled();
  });

  it("renders no inline API-key error before any failure occurs", async () => {
    installSecurityTabDesktopApi();
    render(<DesktopAppPanel />);
    await awaitSecuritySection();

    expect(screen.queryByText(NO_API_KEY_ERROR_RE)).toBeNull();
  });

  it("renders the inline error message when setApiKey rejects", async () => {
    const api = installSecurityTabDesktopApi({
      setApiKey: vi.fn(() => Promise.reject(new Error("network down"))),
    });
    render(<DesktopAppPanel />);
    await awaitSecuritySection();

    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "sk_live_will_fail" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    await waitFor(() => expect(api.setApiKey).toHaveBeenCalled());
    expect(await screen.findByText("network down")).toBeTruthy();
  });
});
