import type { BranchesDataSource } from "@repo/app/branches/data-source/branches-data-source";
import { BranchesDataSourceProvider } from "@repo/app/branches/data-source/provider";
import { branchesKeys } from "@repo/app/branches/hooks/use-branches";
import { githubKeys } from "@repo/app/github/hooks/use-github-integration";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { useDesktopGitHubConnect } from "../use-desktop-github-connect";

const { useDesktopAuthMock } = vi.hoisted(() => ({
  useDesktopAuthMock: vi.fn(),
}));

vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: useDesktopAuthMock,
}));

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

describe("useDesktopGitHubConnect", () => {
  afterEach(() => {
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
