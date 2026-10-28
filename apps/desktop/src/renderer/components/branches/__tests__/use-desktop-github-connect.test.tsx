import type { GitHubIntegrationStatus } from "@repo/api/src/types/github";
import { GitHubOAuthRequiredReason } from "@repo/api/src/types/github";
import type { BranchesDataSource } from "@repo/app/branches/data-source/branches-data-source";
import { BranchesDataSourceProvider } from "@repo/app/branches/data-source/provider";
import { branchesKeys } from "@repo/app/branches/hooks/use-branches";
import { githubKeys } from "@repo/app/github/hooks/use-github-integration";
import { GitHubConnectAction } from "@repo/app/github/lib/github-connect-action";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import {
  DesktopGitHubConnectState,
  useDesktopGitHubConnect,
} from "../use-desktop-github-connect";

const { useDesktopAuthMock } = vi.hoisted(() => ({
  useDesktopAuthMock: vi.fn(),
}));

vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: useDesktopAuthMock,
}));

// ISS-5958: the hook also resolves what its control SAYS, which reads the GitHub
// status. Stubbed here rather than dragging the api-adapter providers in -- and
// the stub honors `enabled`, because that flag is exactly what the gating test
// below exercises: a disabled read yields no data, the same as react-query.
const githubStatus = vi.hoisted(() => ({
  data: undefined as GitHubIntegrationStatus | undefined,
}));
vi.mock(
  "@repo/app/github/hooks/use-github-integration",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@repo/app/github/hooks/use-github-integration")
      >();
    return {
      ...actual,
      useGitHubIntegrationStatus: ({
        enabled = true,
      }: {
        enabled?: boolean;
      } = {}) => ({
        data: enabled ? githubStatus.data : undefined,
        isPending: false,
      }),
    };
  }
);

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

const REVOKED_GRANT_STATUS: GitHubIntegrationStatus = {
  connected: false,
  githubDataConnection: {
    connected: false,
    sources: [],
    oauthRequiredReasons: [GitHubOAuthRequiredReason.CredentialRevoked],
  },
};

describe("useDesktopGitHubConnect", () => {
  afterEach(() => {
    githubStatus.data = undefined;
    vi.restoreAllMocks();
    if (originalDesktopApi) {
      Object.defineProperty(window, "desktopApi", originalDesktopApi);
    } else {
      Reflect.deleteProperty(window, "desktopApi");
    }
  });

  it("invalidates GitHub on the app client and Branch reads on the injected client", async () => {
    const appClient = new QueryClient();
    const branchesClient = new QueryClient();
    const appInvalidate = vi.spyOn(appClient, "invalidateQueries");
    const branchesInvalidate = vi.spyOn(branchesClient, "invalidateQueries");
    useDesktopAuthMock.mockReturnValue({
      state: { status: DesktopAuthStatus.Authenticated },
      beginSignIn: vi.fn(async () => ({ ok: true })),
    });
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        openGitHubConnect: vi.fn(async () => ({ ok: true })),
      },
    });

    const { result } = renderHook(() => useDesktopGitHubConnect("/branches"), {
      wrapper: connectWrapper(appClient, branchesClient),
    });

    await act(() => result.current.connectGitHub());

    expect(appInvalidate).toHaveBeenCalledWith({ queryKey: githubKeys.all });
    expect(appInvalidate).not.toHaveBeenCalledWith({
      queryKey: branchesKeys.all,
    });
    expect(branchesInvalidate).toHaveBeenCalledWith({
      queryKey: branchesKeys.all,
    });
  });

  // ISS-5958 D1: the CTA's verb is decided here, beside the action it performs,
  // because this hook is the only thing that knows the session it signs in when
  // one is absent. A signed-out click starts account creation, so the control
  // must say so rather than hiding that step behind "connect".
  it.each([
    [DesktopAuthStatus.Authenticated, GitHubConnectAction.Connect],
    [DesktopAuthStatus.SignedOut, GitHubConnectAction.SignUp],
  ])("declares the %s connect target as %s", (status, expected) => {
    useDesktopAuthMock.mockReturnValue({
      state: { status },
      beginSignIn: vi.fn(async () => ({ ok: true })),
    });

    const { result } = renderHook(() => useDesktopGitHubConnect("/branches"), {
      wrapper: connectWrapper(new QueryClient(), new QueryClient()),
    });

    expect(result.current.connectTarget.action).toBe(expected);
    expect(result.current.connectTarget.onConnect).toBe(
      result.current.connectGitHub
    );
  });

  // ISS-5958: a surface that already resolved the action from a status it holds
  // hands it in, and the hook stops resolving a second one. The mocked status
  // above never resolves, so the hook's own answer here could only ever be the
  // first-time connect -- reading Reconnect proves the supplied action is what
  // reached the target, not a second read of its own.
  // ISS-5958: the read is unconditional. Gating it on whether a CTA renders was
  // tried and reverted (2026-08-21) -- the gate and the render are the same
  // instant, so it painted the first-time verb and swapped to Reconnect a
  // roundtrip later, which is the D2 collapse arriving late.
  it("resolves a revoked grant as a reconnect without being asked to", () => {
    githubStatus.data = REVOKED_GRANT_STATUS;
    useDesktopAuthMock.mockReturnValue({
      state: { status: DesktopAuthStatus.Authenticated },
      beginSignIn: vi.fn(async () => ({ ok: true })),
    });

    const { result } = renderHook(() => useDesktopGitHubConnect("/branches"), {
      wrapper: connectWrapper(new QueryClient(), new QueryClient()),
    });

    expect(result.current.connectTarget.action).toBe(
      GitHubConnectAction.Reconnect
    );
  });

  // ISS-10411: one click runs two steps, and they can end differently. A
  // sign-in that REJECTS used to fall into the shared catch and report
  // "GitHub connect could not be opened" — naming a step that was never
  // reached. Each leg now settles as itself.
  it.each([
    ["rejects", vi.fn(() => Promise.reject(new Error("bridge down")))],
    ["returns not-ok", vi.fn(async () => ({ ok: false }))],
  ])(
    "reports a sign-in that %s as the sign-in step, not the GitHub connect",
    async (_label, beginSignIn) => {
      useDesktopAuthMock.mockReturnValue({
        state: { status: DesktopAuthStatus.SignedOut },
        beginSignIn,
      });
      const openGitHubConnect = vi.fn(async () => ({ ok: true }));
      Object.defineProperty(window, "desktopApi", {
        configurable: true,
        value: { openGitHubConnect },
      });

      const { result } = renderHook(
        () => useDesktopGitHubConnect("/branches"),
        {
          wrapper: connectWrapper(new QueryClient(), new QueryClient()),
        }
      );

      await act(() => result.current.connectGitHub());

      expect(result.current.connectState).toBe(
        DesktopGitHubConnectState.SignInRequired
      );
      // The second leg must not have run: nothing is known about it, so
      // nothing may be reported about it.
      expect(openGitHubConnect).not.toHaveBeenCalled();
    }
  );

  // ISS-11345: the signed-out leg must ask main to hold the browser's account
  // for confirmation. Without the flag a shared browser signs Desktop in as
  // whoever it holds, with no prompt, and every other case here stays green.
  it("asks for the returned account to be confirmed before it is adopted", async () => {
    const beginSignIn = vi.fn(async () => ({ ok: true }));
    useDesktopAuthMock.mockReturnValue({
      state: { status: DesktopAuthStatus.SignedOut },
      beginSignIn,
    });
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: { openGitHubConnect: vi.fn(async () => ({ ok: true })) },
    });

    const { result } = renderHook(() => useDesktopGitHubConnect("/branches"), {
      wrapper: connectWrapper(new QueryClient(), new QueryClient()),
    });

    await act(() => result.current.connectGitHub());

    expect(beginSignIn).toHaveBeenCalledTimes(1);
    expect(beginSignIn).toHaveBeenCalledWith(undefined, undefined, undefined, {
      confirmAccount: true,
    });
  });

  it("reports a rejected connect handoff as the connect step", async () => {
    useDesktopAuthMock.mockReturnValue({
      state: { status: DesktopAuthStatus.Authenticated },
      beginSignIn: vi.fn(async () => ({ ok: true })),
    });
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        openGitHubConnect: vi.fn(() => Promise.reject(new Error("ipc down"))),
      },
    });

    const { result } = renderHook(() => useDesktopGitHubConnect("/branches"), {
      wrapper: connectWrapper(new QueryClient(), new QueryClient()),
    });

    await act(() => result.current.connectGitHub());

    expect(result.current.connectState).toBe(DesktopGitHubConnectState.Failed);
  });

  // ISS-10411 / PLN-2043 M3: "provide a retry scoped to the failed step".
  // Once the session exists, `auth.state.status` is authenticated and the
  // sign-in leg is skipped, so a retry re-opens ONLY the GitHub step. That
  // branch had no pin: making the sign-in leg unconditional would compile,
  // pass every other case in this file, and send a signed-in user back through
  // a device authorization they had already completed.
  it("re-runs only the GitHub step when the session already exists", async () => {
    const beginSignIn = vi.fn(async () => ({ ok: true }));
    useDesktopAuthMock.mockReturnValue({
      state: { status: DesktopAuthStatus.Authenticated },
      beginSignIn,
    });
    let openCalls = 0;
    const openGitHubConnect = vi.fn(() => {
      openCalls += 1;
      // The first hand-off fails, so the second call is a real retry rather
      // than a second first attempt.
      return Promise.resolve({ ok: openCalls > 1 });
    });
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: { openGitHubConnect },
    });

    const { result } = renderHook(() => useDesktopGitHubConnect("/branches"), {
      wrapper: connectWrapper(new QueryClient(), new QueryClient()),
    });

    await act(() => result.current.connectGitHub());
    expect(result.current.connectState).toBe(DesktopGitHubConnectState.Failed);

    await act(() => result.current.connectGitHub());

    expect(result.current.connectState).toBe(DesktopGitHubConnectState.Opened);
    expect(openGitHubConnect).toHaveBeenCalledTimes(2);
    expect(beginSignIn).not.toHaveBeenCalled();
  });

  it("takes a caller-supplied action instead of resolving its own", () => {
    useDesktopAuthMock.mockReturnValue({
      state: { status: DesktopAuthStatus.Authenticated },
      beginSignIn: vi.fn(async () => ({ ok: true })),
    });

    const { result } = renderHook(
      () =>
        useDesktopGitHubConnect({
          connectAction: GitHubConnectAction.Reconnect,
          returnTo: "/branches",
        }),
      { wrapper: connectWrapper(new QueryClient(), new QueryClient()) }
    );

    expect(result.current.connectTarget.action).toBe(
      GitHubConnectAction.Reconnect
    );
  });

  // ISS-10990 review (whitlockk): not every host that reads this outcome is keyed by
  // account -- the guided-onboarding host deliberately survives a sign-out and an
  // organization switch -- so a refusal one reader earned must not greet the
  // next one.
  it("drops a settled refusal when the reader signs out", async () => {
    useDesktopAuthMock.mockReturnValue({
      state: { status: DesktopAuthStatus.Authenticated, userId: "user-a" },
      beginSignIn: vi.fn(async () => ({ ok: true })),
    });
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: { openGitHubConnect: vi.fn(async () => ({ ok: false })) },
    });

    const { result, rerender } = renderHook(
      () => useDesktopGitHubConnect("/branches"),
      { wrapper: connectWrapper(new QueryClient(), new QueryClient()) }
    );
    await act(() => result.current.connectGitHub());
    expect(result.current.connectState).toBe(DesktopGitHubConnectState.Failed);

    useDesktopAuthMock.mockReturnValue({
      state: { status: DesktopAuthStatus.SignedOut, userId: null },
      beginSignIn: vi.fn(async () => ({ ok: true })),
    });
    rerender();
    useDesktopAuthMock.mockReturnValue({
      state: { status: DesktopAuthStatus.Authenticated, userId: "user-b" },
      beginSignIn: vi.fn(async () => ({ ok: true })),
    });
    rerender();

    expect(result.current.connectState).toBe(DesktopGitHubConnectState.Idle);
  });

  // The sign-in leg CHANGES the identity mid-flight, so the reset must not eat
  // the outcome of the very attempt that signed this reader in.
  it("keeps the refusal that the sign-in leg's own account earned", async () => {
    const beginSignIn = vi.fn(() => {
      useDesktopAuthMock.mockReturnValue({
        state: { status: DesktopAuthStatus.Authenticated, userId: "user-b" },
        beginSignIn,
      });
      return Promise.resolve({ ok: true });
    });
    useDesktopAuthMock.mockReturnValue({
      state: { status: DesktopAuthStatus.SignedOut, userId: null },
      beginSignIn,
    });
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: { openGitHubConnect: vi.fn(async () => ({ ok: false })) },
    });

    const { result, rerender } = renderHook(
      () => useDesktopGitHubConnect("/branches"),
      { wrapper: connectWrapper(new QueryClient(), new QueryClient()) }
    );
    await act(() => result.current.connectGitHub());
    rerender();

    expect(result.current.connectState).toBe(DesktopGitHubConnectState.Failed);
  });

  // Only first-time onboarding asks main to bring Desktop forward after the
  // browser connect; every other surface keeps the request it always sent.
  it.each([
    [undefined, { returnTo: "/dashboard" }],
    [true, { returnTo: "/dashboard", returnToDesktop: true }],
  ])("returnToDesktop %s sends %j", async (returnToDesktop, expected) => {
    useDesktopAuthMock.mockReturnValue({
      state: { status: DesktopAuthStatus.Authenticated },
      beginSignIn: vi.fn(async () => ({ ok: true })),
    });
    const openGitHubConnect = vi.fn(async () => ({ ok: true }));
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: { openGitHubConnect },
    });

    const { result } = renderHook(
      () =>
        useDesktopGitHubConnect({ returnTo: "/dashboard", returnToDesktop }),
      { wrapper: connectWrapper(new QueryClient(), new QueryClient()) }
    );
    await act(() => result.current.connectGitHub());

    expect(openGitHubConnect).toHaveBeenCalledWith(expected);
  });
});

function connectWrapper(appClient: QueryClient, branchesClient: QueryClient) {
  return ({ children }: Readonly<{ children: ReactNode }>) => (
    <QueryClientProvider client={appClient}>
      <BranchesDataSourceProvider
        dataSource={{ scope: "test" } as unknown as BranchesDataSource}
        queryClient={branchesClient}
      >
        {children}
      </BranchesDataSourceProvider>
    </QueryClientProvider>
  );
}
