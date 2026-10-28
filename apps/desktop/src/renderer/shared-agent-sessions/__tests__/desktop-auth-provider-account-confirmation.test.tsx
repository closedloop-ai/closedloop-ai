import type { DesktopIdentity } from "@repo/api/src/types/desktop-identity";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../shared/contracts";
import type { DesktopAuthState } from "../../types/desktop-api";
import { DesktopAuthProvider } from "../desktop-auth-provider";
import { DESKTOP_SIGN_IN_ACCOUNT_CONFIRM_COPY } from "../desktop-sign-in-copy";

/**
 * ISS-11345: the provider owns the auth state, so it is what shows the account
 * a confirmation-gated sign-in brought back, and what carries the user's answer
 * to main. Mounted through the real provider over a stubbed bridge, so deleting
 * the mount — not just the dialog — reddens this file.
 */

const ACCOUNT: DesktopIdentity = {
  userId: "user-2",
  organizationId: "org-2",
  email: "someone-else@closedloop.test",
  firstName: "Someone",
  lastName: "Else",
  organizationName: "Their Org",
};

const HELD: DesktopAuthState = {
  status: DesktopAuthStatus.Exchanging,
  userId: null,
  organizationId: null,
  pendingAccount: ACCOUNT,
};

const SIGNED_OUT: DesktopAuthState = {
  status: DesktopAuthStatus.SignedOut,
  userId: null,
  organizationId: null,
};

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

function installBridge(
  initial: DesktopAuthState,
  confirm: (() => Promise<void>) | null = () => Promise.resolve()
) {
  const listeners = new Set<(state: DesktopAuthState) => void>();
  const api = {
    getDesktopAuthState: vi.fn(() => Promise.resolve(initial)),
    onDesktopAuthStateChanged: vi.fn(
      (listener: (state: DesktopAuthState) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    ),
    beginDesktopSignIn: vi.fn(() => new Promise(() => undefined)),
    cancelDesktopSignIn: vi.fn(() => Promise.resolve()),
    ...(confirm ? { confirmDesktopSignIn: vi.fn(confirm) } : {}),
    signOutDesktop: vi.fn(() => Promise.resolve()),
  };
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: api,
  });
  return {
    api,
    push: (state: DesktopAuthState) => {
      for (const listener of listeners) {
        listener(state);
      }
    },
  };
}

function renderProvider() {
  return render(
    <DesktopAuthProvider>
      <p>app</p>
      <button type="button">{STARTED_FROM}</button>
    </DesktopAuthProvider>
  );
}

const STARTED_FROM = "the control the sign-in started from";

function confirmButton() {
  return screen.getByRole("button", {
    name: DESKTOP_SIGN_IN_ACCOUNT_CONFIRM_COPY.confirmLabel,
  });
}

function cancelButton() {
  return screen.getByRole("button", {
    name: DESKTOP_SIGN_IN_ACCOUNT_CONFIRM_COPY.cancelLabel,
  });
}

describe("DesktopAuthProvider account confirmation (ISS-11345)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    if (originalDesktopApi) {
      Object.defineProperty(window, "desktopApi", originalDesktopApi);
    } else {
      Reflect.deleteProperty(window, "desktopApi");
    }
  });

  it("shows the held account, and only while one is held", async () => {
    const bridge = installBridge(SIGNED_OUT);
    renderProvider();
    await screen.findByText("app");
    expect(screen.queryByRole("alertdialog")).toBeNull();

    act(() => bridge.push(HELD));

    const dialog = await screen.findByRole("alertdialog", {
      name: DESKTOP_SIGN_IN_ACCOUNT_CONFIRM_COPY.title,
    });
    expect(dialog.textContent).toContain("Someone Else");
    expect(dialog.textContent).toContain(ACCOUNT.email);
    expect(dialog.textContent).toContain("Their Org");

    act(() => bridge.push(SIGNED_OUT));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("sends a confirm, and only a confirm, when the user confirms", async () => {
    const { api } = installBridge(HELD);
    renderProvider();
    await screen.findByRole("alertdialog");

    fireEvent.click(confirmButton());

    await waitFor(() =>
      expect(api.confirmDesktopSignIn).toHaveBeenCalledTimes(1)
    );
    expect(api.cancelDesktopSignIn).not.toHaveBeenCalled();

    // Escape after confirming must not take the confirmation back.
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(api.cancelDesktopSignIn).not.toHaveBeenCalled();
  });

  it.each([
    ["Cancel", () => fireEvent.click(cancelButton())],
    [
      "Escape",
      () =>
        fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" }),
    ],
  ])(
    "cancels the sign-in on %s, never confirming it",
    async (_way, dismiss) => {
      const { api } = installBridge(HELD);
      renderProvider();
      await screen.findByRole("alertdialog");

      dismiss();

      await waitFor(() =>
        expect(api.cancelDesktopSignIn).toHaveBeenCalledTimes(1)
      );
      expect(api.confirmDesktopSignIn).not.toHaveBeenCalled();
    }
  );

  it("ends the sign-in when the confirm never reaches main", async () => {
    const { api } = installBridge(HELD, () =>
      Promise.reject(new Error("ipc down"))
    );
    renderProvider();
    await screen.findByRole("alertdialog");

    fireEvent.click(confirmButton());

    await waitFor(() =>
      expect(api.cancelDesktopSignIn).toHaveBeenCalledTimes(1)
    );
  });

  it("ends the sign-in when the preload has no confirm to send", async () => {
    const bridge = installBridge(HELD, null);
    renderProvider();
    await screen.findByRole("alertdialog");

    fireEvent.click(confirmButton());

    await waitFor(() =>
      expect(bridge.api.cancelDesktopSignIn).toHaveBeenCalledTimes(1)
    );
    act(() => bridge.push(SIGNED_OUT));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("hands focus back to where it was when the dialog closes", async () => {
    const bridge = installBridge(SIGNED_OUT);
    renderProvider();
    const origin = await screen.findByRole("button", { name: STARTED_FROM });
    origin.focus();

    act(() => bridge.push(HELD));
    const dialog = await screen.findByRole("alertdialog");
    await waitFor(() =>
      expect(dialog.contains(document.activeElement)).toBe(true)
    );

    fireEvent.keyDown(dialog, { key: "Escape" });
    act(() => bridge.push(SIGNED_OUT));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(origin));
  });
});
