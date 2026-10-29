import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopAppPanel } from "../../../settings-v2/panels/desktop-app-panel";
import type { ApiKeyStatusView } from "../security-tab";
import {
  apiKeyStatusMock,
  awaitSecuritySection,
  installSecurityTabDesktopApi,
  restoreDesktopApi,
} from "./security-tab-desktop-api-fixture";

// ISS-7043: the Security block's "API Key" summary row has three distinct
// readings — not-yet-read, read-and-absent, read-and-present — and the first
// two must never collapse into each other: telling a signed-in user "Not
// configured" while the IPC is still in flight reports a key they have as one
// they don't. Nothing pinned that distinction while the label was a nested
// ternary inline in the legacy Settings panel, so extracting SecurityTab into
// its own
// module (and rewriting that ternary as an if/else helper) could have dropped
// the loading arm silently. These expectations are hand-derived from the
// pre-split expression and pass against it unchanged.

function installStatus(status: ApiKeyStatusView | "pending"): void {
  installSecurityTabDesktopApi({ getApiKeyStatus: apiKeyStatusMock(status) });
}

async function openSecurityTabAndReadApiKeyValue(): Promise<HTMLElement> {
  await awaitSecuritySection();
  // ConfigRow renders the label and its value as adjacent spans, so the value
  // is read off the label's sibling rather than by matching the value text —
  // which is the thing under assertion and must not also be the selector.
  const valueCell = screen.getByText("API Key").nextElementSibling;
  if (!(valueCell instanceof HTMLElement)) {
    throw new Error("API Key ConfigRow rendered no value cell");
  }
  return valueCell;
}

afterEach(restoreDesktopApi);

describe("Settings Security block API Key summary label", () => {
  it("shows the pending placeholder, not an absence claim, while the status read is in flight", async () => {
    installStatus("pending");
    render(<DesktopAppPanel />);

    const valueCell = await openSecurityTabAndReadApiKeyValue();

    expect(valueCell.textContent).toBe("...");
    expect(valueCell.textContent).not.toBe("Not configured");
  });

  it("reports an absent key once the status resolves with hasApiKey false", async () => {
    installStatus({ hasApiKey: false, source: "none" });
    render(<DesktopAppPanel />);

    const valueCell = await openSecurityTabAndReadApiKeyValue();

    await waitFor(() => expect(valueCell.textContent).toBe("Not configured"));
  });

  it("names the source of a configured key that carries no provenance", async () => {
    installStatus({ hasApiKey: true, source: "safeStorage" });
    render(<DesktopAppPanel />);

    const valueCell = await openSecurityTabAndReadApiKeyValue();

    await waitFor(() =>
      expect(valueCell.textContent).toBe("Configured (safeStorage)")
    );
  });

  it("appends provenance after the source when the status carries one", async () => {
    installStatus({
      hasApiKey: true,
      provenance: "CLOSEDLOOP_API_KEY",
      source: "environment",
    });
    render(<DesktopAppPanel />);

    const valueCell = await openSecurityTabAndReadApiKeyValue();

    await waitFor(() =>
      expect(valueCell.textContent).toBe(
        "Configured (environment, CLOSEDLOOP_API_KEY)"
      )
    );
  });
});
