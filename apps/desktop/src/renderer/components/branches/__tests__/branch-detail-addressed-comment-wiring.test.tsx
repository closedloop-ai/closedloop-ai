import type { BranchDetailPageProps } from "@repo/app/branches/components/branch-detail-page";
import { BranchBackLabel } from "@repo/app/branches/lib/branch-back-href";
import type { ApiAdapter } from "@repo/app/shared/api/api-adapter";
import { ApiAdapterProvider } from "@repo/app/shared/api/provider";
import { AuthAdapterProvider } from "@repo/app/shared/auth/provider";
import { createStaticAuthAdapter } from "@repo/app/shared/auth/static-auth-adapter";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BranchDetailView } from "../branch-detail-view";

/**
 * @description ISS-10980 — the PRODUCTION WIRING of the Branch Activity tab's
 * comment link on the desktop shell: this shell owns the URL, so it is what
 * reads `?comment=` and forwards it to the shared Branch body.
 *
 * The rest of the chain is graded elsewhere: the param codec
 * (`packages/app/shared/lib/__tests__/artifact-comment-href`), the shell
 * handing it to the pane (`packages/app/.../branch-shell-view`), the pane's
 * open-and-select (`packages/app/.../branch-comments-pane`), and the web
 * shell's own read (`apps/app/.../branches/[branchId]/__tests__/page.test.tsx`).
 * All of those stay green if THIS shell stops reading the param or forwards it
 * to the wrong prop, which is the one thing only this file can fail on.
 *
 * The no-address case is load-bearing: a shell that hard-coded an id would
 * pass the first case alone.
 */
const { bodyMock, useDesktopAuthMock } = vi.hoisted(() => ({
  bodyMock: vi.fn(),
  useDesktopAuthMock: vi.fn(),
}));

vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: useDesktopAuthMock,
}));

vi.mock(
  "@repo/app/branches/components/branch-detail-page",
  async (original) => ({
    ...(await original<
      typeof import("@repo/app/branches/components/branch-detail-page")
    >()),
    BranchDetailPage: (props: BranchDetailPageProps) => {
      bodyMock(props);
      return <div data-testid="branch-detail-body" />;
    },
  })
);

const inertApiAdapter: ApiAdapter = {
  fetch: () => Promise.reject(new Error("no remote REST API in tests")),
  resolveApiOrigin: () => "http://test.local",
};

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

beforeEach(() => {
  bodyMock.mockClear();
  useDesktopAuthMock.mockReturnValue({
    beginSignIn: vi.fn(),
    state: {
      organizationId: "org-1",
      status: "authenticated",
      userId: "user-1",
    },
  });
  installDesktopApi();
});

afterEach(() => {
  cleanup();
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
  vi.restoreAllMocks();
});

describe("Desktop branch detail addressed comment (ISS-10980)", () => {
  it("forwards the comment the URL addresses", () => {
    renderView("/branches/b-1?comment=thread-7");

    expect(bodyMock).toHaveBeenCalledWith(
      expect.objectContaining({ selectedThreadId: "thread-7" })
    );
  });

  it("forwards no addressed comment when the URL names none", () => {
    renderView("/branches/b-1");

    expect(bodyMock).toHaveBeenCalledWith(
      expect.objectContaining({ selectedThreadId: null })
    );
  });
});

function renderView(initialPath: string) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  return render(
    <NavigationProvider
      adapter={createMemoryNavigation({ initialPath }).adapter}
    >
      <QueryClientProvider client={queryClient}>
        <AuthAdapterProvider adapter={createStaticAuthAdapter()}>
          <ApiAdapterProvider adapter={inertApiAdapter}>
            <FeatureFlagAdapterProvider
              adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
            >
              <BranchDetailView
                backHref="/branches"
                backLabel={BranchBackLabel.Branches}
                branchId="b-1"
              />
            </FeatureFlagAdapterProvider>
          </ApiAdapterProvider>
        </AuthAdapterProvider>
      </QueryClientProvider>
    </NavigationProvider>
  );
}

/** The local Branches source and the db-change subscription this view mounts. */
function installDesktopApi(): void {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      branchesApi: {
        analytics: vi.fn(() => Promise.resolve({})),
        detail: vi.fn(() => new Promise(() => undefined)),
        list: vi.fn(() =>
          Promise.resolve({ items: [], total: 0, viewerScope: "self" })
        ),
        trace: vi.fn(() => Promise.resolve([])),
        usage: vi.fn(() => Promise.resolve({})),
      },
      onDbChanged: vi.fn(() => () => undefined),
    },
  });
}
