import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DesktopAuthProvider } from "../../../shared-agent-sessions/desktop-auth-provider";
import type { DesktopAuthState } from "../../../types/desktop-api";
import { DesktopAccountTab } from "../desktop-account-tab";

const AUTHENTICATED_STATE: DesktopAuthState = {
  status: "authenticated",
  userId: "user_123",
  organizationId: "org_456",
};

// Stub the auth bridge as authenticated so DesktopAccountTab renders the
// SignedInDetails "Sign out" button. `signOutDesktop` drives the outcome under
// test; the identity fetch is omitted so the panel falls back to the id.
function installAuthedDesktopApi(signOutDesktop: () => Promise<void>) {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      getDesktopAuthState: vi.fn(() => Promise.resolve(AUTHENTICATED_STATE)),
      signOutDesktop: vi.fn(signOutDesktop),
    },
  });
}

function renderAccountTab(): void {
  render(
    <DesktopAuthProvider>
      <DesktopAccountTab />
    </DesktopAuthProvider>
  );
}

describe("DesktopAccountTab sign-out error feedback (FEA-2569)", () => {
  it("surfaces an error message when sign-out rejects", async () => {
    installAuthedDesktopApi(() => Promise.reject(new Error("boom")));
    renderAccountTab();

    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));

    expect(
      await screen.findByText("Sign-out could not be completed. Try again.")
    ).not.toBeNull();
  });

  it("shows no error when sign-out resolves", async () => {
    installAuthedDesktopApi(() => Promise.resolve());
    renderAccountTab();

    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));

    // Let the resolved sign-out settle; the busy button returns to "Sign out".
    await screen.findByRole("button", { name: "Sign out" });
    expect(
      screen.queryByText("Sign-out could not be completed. Try again.")
    ).toBeNull();
  });
});
