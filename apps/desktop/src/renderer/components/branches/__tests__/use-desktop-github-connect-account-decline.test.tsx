import type { DesktopIdentity } from "@repo/api/src/types/desktop-identity";
import type { BranchesDataSource } from "@repo/app/branches/data-source/branches-data-source";
import { BranchesDataSourceProvider } from "@repo/app/branches/data-source/provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { DesktopAuthProvider } from "../../../shared-agent-sessions/desktop-auth-provider";
import { DESKTOP_SIGN_IN_ACCOUNT_CONFIRM_COPY } from "../../../shared-agent-sessions/desktop-sign-in-copy";
import { DesktopConnectStatus } from "../../../shared-branches/desktop-connect-status";
import {
  DesktopGitHubConnectSurface,
  desktopGitHubConnectMessage,
} from "../../../shared-branches/desktop-github-connect-copy";
import type {
  DesktopAuthState,
  DesktopBrowserSignInResult,
} from "../../../types/desktop-api";
import {
  DesktopGitHubConnectState,
  useDesktopGitHubConnect,
} from "../use-desktop-github-connect";

/**
 * ISS-11345, Perrin Upcott's ruling (2026-10-02): a Cancel in the account
 * confirmation leaves Desktop signed out with no failure banner, while a sign-in
 * that really failed still shows one. Driven through the real
 * `DesktopAuthProvider`, its confirmation dialog, `useDesktopGitHubConnect` and
 * `DesktopConnectStatus`, over a stubbed preload bridge whose begin settles the
 * way main settles it.
 */

vi.mock("@repo/app/github/hooks/use-github-integration", async (actual) => ({
  ...(await actual<
    typeof import("@repo/app/github/hooks/use-github-integration")
  >()),
  useGitHubIntegrationStatus: () => ({ data: undefined, isPending: false }),
}));

const ACCOUNT: DesktopIdentity = {
  userId: "user-2",
  organizationId: "org-2",
  email: "someone-else@closedloop.test",
  firstName: "Someone",
  lastName: "Else",
  organizationName: "Their Org",
};

const SIGNED_OUT: DesktopAuthState = {
  status: DesktopAuthStatus.SignedOut,
  userId: null,
  organizationId: null,
};

const HELD: DesktopAuthState = {
  status: DesktopAuthStatus.Exchanging,
  userId: null,
  organizationId: null,
  pendingAccount: ACCOUNT,
};

const CONNECT = "connect";

const SIGN_IN_REQUIRED_BANNER = signInRequiredBanner();

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

/** Begin parks until `settle`; cancel and a failed confirm settle it as main does. */
function installBridge({ confirmFails = false } = {}) {
  const listeners = new Set<(state: DesktopAuthState) => void>();
  const push = (state: DesktopAuthState) => {
    for (const listener of listeners) {
      listener(state);
    }
  };
  let settle: (result: DesktopBrowserSignInResult) => void = () => undefined;
  const cancelled = () => {
    push(SIGNED_OUT);
    settle({ ok: false, reason: "cancelled" });
  };
  const api = {
    getDesktopAuthState: vi.fn(() => Promise.resolve(SIGNED_OUT)),
    onDesktopAuthStateChanged: vi.fn(
      (listener: (state: DesktopAuthState) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    ),
    beginDesktopSignIn: vi.fn(
      () =>
        new Promise<DesktopBrowserSignInResult>((resolve) => {
          settle = resolve;
        })
    ),
    cancelDesktopSignIn: vi.fn(() => {
      cancelled();
      return Promise.resolve();
    }),
    confirmDesktopSignIn: vi.fn(() =>
      confirmFails ? Promise.reject(new Error("ipc down")) : Promise.resolve()
    ),
    signOutDesktop: vi.fn(() => Promise.resolve()),
    openGitHubConnect: vi.fn(() => Promise.resolve({ ok: true })),
  };
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: api,
  });
  return {
    api,
    push,
    settle: (result: DesktopBrowserSignInResult) => {
      push(SIGNED_OUT);
      settle(result);
    },
  };
}

function ConnectCard() {
  const { connectState, connectGitHub } = useDesktopGitHubConnect("/insights");
  return (
    <>
      <button onClick={() => connectGitHub()} type="button">
        {CONNECT}
      </button>
      <DesktopConnectStatus
        state={connectState}
        variant={DesktopGitHubConnectSurface.List}
      />
    </>
  );
}

function renderCard() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <BranchesDataSourceProvider
        dataSource={{ scope: "test" } as unknown as BranchesDataSource}
        queryClient={new QueryClient()}
      >
        <DesktopAuthProvider>
          <ConnectCard />
        </DesktopAuthProvider>
      </BranchesDataSourceProvider>
    </QueryClientProvider>
  );
}

async function startSignIn(push: (state: DesktopAuthState) => void) {
  renderCard();
  fireEvent.click(await screen.findByRole("button", { name: CONNECT }));
  act(() => push(HELD));
  return await screen.findByRole("alertdialog", {
    name: DESKTOP_SIGN_IN_ACCOUNT_CONFIRM_COPY.title,
  });
}

describe("useDesktopGitHubConnect account decline (ISS-11345)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    if (originalDesktopApi) {
      Object.defineProperty(window, "desktopApi", originalDesktopApi);
    } else {
      Reflect.deleteProperty(window, "desktopApi");
    }
  });

  it.each([
    [
      "Cancel",
      () =>
        fireEvent.click(
          screen.getByRole("button", {
            name: DESKTOP_SIGN_IN_ACCOUNT_CONFIRM_COPY.cancelLabel,
          })
        ),
    ],
    [
      "Escape",
      () =>
        fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" }),
    ],
  ])("returns quietly when the user declines on %s", async (_way, decline) => {
    const { api, push } = installBridge();
    await startSignIn(push);

    decline();

    await waitFor(() => expect(api.cancelDesktopSignIn).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    // Let the settled begin reach the hook before asserting nothing rendered.
    await act(() => Promise.resolve());
    expect(screen.getByRole("button", { name: CONNECT })).toBeTruthy();
    expect(screen.queryByText(SIGN_IN_REQUIRED_BANNER)).toBeNull();
    expect(api.openGitHubConnect).not.toHaveBeenCalled();
  });

  it("still reports a sign-in that failed after the account was held", async () => {
    const { push, settle } = installBridge();
    await startSignIn(push);

    act(() => settle({ ok: false, reason: "exchange_failed" }));

    expect(await screen.findByText(SIGN_IN_REQUIRED_BANNER)).toBeTruthy();
  });

  it("still reports a confirm that never reached main", async () => {
    const { api, push } = installBridge({ confirmFails: true });
    await startSignIn(push);

    fireEvent.click(
      screen.getByRole("button", {
        name: DESKTOP_SIGN_IN_ACCOUNT_CONFIRM_COPY.confirmLabel,
      })
    );

    await waitFor(() => expect(api.cancelDesktopSignIn).toHaveBeenCalled());
    expect(await screen.findByText(SIGN_IN_REQUIRED_BANNER)).toBeTruthy();
  });
});

function signInRequiredBanner(): string {
  const content = desktopGitHubConnectMessage(
    DesktopGitHubConnectState.SignInRequired,
    DesktopGitHubConnectSurface.List
  );
  if (!content) {
    throw new Error("SignInRequired renders no banner on the list surface");
  }
  return content.message;
}
