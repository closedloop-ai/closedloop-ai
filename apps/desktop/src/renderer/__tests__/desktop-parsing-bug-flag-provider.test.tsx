import { useCanFlagParsingBug } from "@repo/app/agents/data-source/parsing-bug-flag-provider";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopAuthState } from "../types/desktop-api";

// FEA-4347: the desktop surface adapter resolves staff-ness from the signed-in
// desktop identity's email (fetched over the main-process bridge) and injects it
// into the shared parsing-bug-flag context.
const { useDesktopAuthMock } = vi.hoisted(() => ({
  useDesktopAuthMock: vi.fn(),
}));

vi.mock("../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: useDesktopAuthMock,
}));

// Imported after the mock is declared (vi.mock is hoisted).
const { DesktopParsingBugFlagProvider } = await import(
  "../shared-agent-sessions/desktop-parsing-bug-flag-provider"
);

const AUTHENTICATED: DesktopAuthState = {
  status: "authenticated",
  userId: "user-1",
  organizationId: "org-1",
};
const AUTHENTICATED_CUSTOMER: DesktopAuthState = {
  status: "authenticated",
  userId: "user-2",
  organizationId: "org-2",
};
const SIGNED_OUT: DesktopAuthState = {
  status: "signed_out",
  userId: null,
  organizationId: null,
};

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);
const originalOnLine = Object.getOwnPropertyDescriptor(
  window.navigator,
  "onLine"
);

function setOnLine(value: boolean): void {
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    value,
  });
}

function stubIdentity(email: string | undefined, userId = "user-1"): void {
  const getDesktopIdentity = vi.fn(() =>
    Promise.resolve(
      email
        ? {
            userId,
            organizationId: "org-1",
            email,
            firstName: null,
            lastName: null,
            organizationName: null,
          }
        : null
    )
  );
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: { getDesktopIdentity },
  });
}

function CanFlagProbe() {
  return <span data-testid="can-flag">{String(useCanFlagParsingBug())}</span>;
}

function renderProvider(): ReturnType<typeof render> {
  return render(
    <DesktopParsingBugFlagProvider>
      <CanFlagProbe />
    </DesktopParsingBugFlagProvider>
  );
}

afterEach(() => {
  cleanup();
  useDesktopAuthMock.mockReset();
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
  if (originalOnLine) {
    Object.defineProperty(window.navigator, "onLine", originalOnLine);
  }
});

describe("DesktopParsingBugFlagProvider (desktop adapter, FEA-4347)", () => {
  it("enables the flag for a signed-in staff (@closedloop.ai) identity", async () => {
    useDesktopAuthMock.mockReturnValue({ state: AUTHENTICATED });
    stubIdentity("dev@closedloop.ai");
    renderProvider();

    await waitFor(() =>
      expect(screen.getByTestId("can-flag").textContent).toBe("true")
    );
  });

  it("keeps the flag disabled for a customer identity", async () => {
    useDesktopAuthMock.mockReturnValue({ state: AUTHENTICATED });
    stubIdentity("user@acme.com");
    renderProvider();

    // The identity resolves asynchronously; assert it never flips to staff.
    await waitFor(() =>
      expect(window.desktopApi.getDesktopIdentity).toHaveBeenCalled()
    );
    expect(screen.getByTestId("can-flag").textContent).toBe("false");
  });

  it("keeps the flag disabled when signed out (no identity fetched)", () => {
    useDesktopAuthMock.mockReturnValue({ state: SIGNED_OUT });
    stubIdentity("dev@closedloop.ai");
    renderProvider();

    expect(screen.getByTestId("can-flag").textContent).toBe("false");
    expect(window.desktopApi.getDesktopIdentity).not.toHaveBeenCalled();
  });

  it("retries the staff lookup when connectivity returns (started offline)", async () => {
    // A staff session that boots offline (or whose first identity request never
    // completed) must regain the checkbox once connectivity returns, without a
    // reload — DesktopAppCoreModeStack preserves these children across the flip.
    useDesktopAuthMock.mockReturnValue({ state: AUTHENTICATED });
    stubIdentity("dev@closedloop.ai");
    setOnLine(false);
    renderProvider();

    // Offline: the lookup is skipped and the affordance stays hidden.
    expect(screen.getByTestId("can-flag").textContent).toBe("false");
    expect(window.desktopApi.getDesktopIdentity).not.toHaveBeenCalled();

    // Connectivity returns: useOnlineStatus re-renders and the effect re-runs.
    setOnLine(true);
    act(() => {
      window.dispatchEvent(new Event("online"));
    });

    await waitFor(() =>
      expect(screen.getByTestId("can-flag").textContent).toBe("true")
    );
    expect(window.desktopApi.getDesktopIdentity).toHaveBeenCalled();
  });

  it("drops the staff flag immediately on a staff→customer account switch", async () => {
    // DesktopAppCoreModeStack preserves this subtree across auth changes. A
    // stale `true` from the previous (staff) account must not linger — and must
    // never survive a lookup that resolves for the *new* customer account.
    useDesktopAuthMock.mockReturnValue({ state: AUTHENTICATED });
    stubIdentity("dev@closedloop.ai", "user-1");
    const { rerender } = renderProvider();

    await waitFor(() =>
      expect(screen.getByTestId("can-flag").textContent).toBe("true")
    );

    // Switch to a customer account. The next identity fetch resolves for the
    // new user (user-2, non-staff email); the flag must be false the moment the
    // authed user changes and stay false after the lookup lands.
    useDesktopAuthMock.mockReturnValue({ state: AUTHENTICATED_CUSTOMER });
    stubIdentity("user@acme.com", "user-2");
    rerender(
      <DesktopParsingBugFlagProvider>
        <CanFlagProbe />
      </DesktopParsingBugFlagProvider>
    );

    // No stale-true window: the reset is synchronous on the auth change.
    expect(screen.getByTestId("can-flag").textContent).toBe("false");
    await waitFor(() =>
      expect(window.desktopApi.getDesktopIdentity).toHaveBeenCalled()
    );
    expect(screen.getByTestId("can-flag").textContent).toBe("false");
  });

  it("ignores a late identity reply that belongs to a prior account", async () => {
    // A slow getDesktopIdentity for the previous staff user resolving after a
    // switch must not grant staff to the current customer account.
    let resolveStaff: ((v: unknown) => void) | undefined;
    const getDesktopIdentity = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveStaff = resolve;
          })
      )
      .mockImplementation(() =>
        Promise.resolve({
          userId: "user-2",
          organizationId: "org-2",
          email: "user@acme.com",
          firstName: null,
          lastName: null,
          organizationName: null,
        })
      );
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: { getDesktopIdentity },
    });

    useDesktopAuthMock.mockReturnValue({ state: AUTHENTICATED });
    const { rerender } = renderProvider();

    // Switch to the customer account before the staff lookup resolves.
    useDesktopAuthMock.mockReturnValue({ state: AUTHENTICATED_CUSTOMER });
    rerender(
      <DesktopParsingBugFlagProvider>
        <CanFlagProbe />
      </DesktopParsingBugFlagProvider>
    );

    // The stale staff reply lands now — but it is for user-1, not the current
    // user-2, so the correlation guard drops it.
    act(() => {
      resolveStaff?.({
        userId: "user-1",
        organizationId: "org-1",
        email: "dev@closedloop.ai",
        firstName: null,
        lastName: null,
        organizationName: null,
      });
    });

    await waitFor(() =>
      expect(window.desktopApi.getDesktopIdentity).toHaveBeenCalledTimes(2)
    );
    expect(screen.getByTestId("can-flag").textContent).toBe("false");
  });
});
