// The shell's trace mounts a ResizeObserver; this suite declares no setupFiles.
import "../../../../../../../packages/typescript-config/vitest-jsdom-setup";
import {
  BRANCH_DETAIL_TAB_PARAM,
  BranchDetailTabParam,
} from "@repo/api/src/types/notification-routes";
import {
  completeSessionsTrace,
  sessionsPanelDetail,
} from "@repo/app/branches/components/detail/branch-sessions-panel-fixtures";
import { BRANCH_TRACE_SESSION_LINKS_LABEL } from "@repo/app/branches/components/detail/branch-trace-session-links";
import { BranchBackLabel } from "@repo/app/branches/lib/branch-back-href";
import type { ApiAdapter } from "@repo/app/shared/api/api-adapter";
import { ApiAdapterProvider } from "@repo/app/shared/api/provider";
import { AuthAdapterProvider } from "@repo/app/shared/auth/provider";
import { createStaticAuthAdapter } from "@repo/app/shared/auth/static-auth-adapter";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { ARTIFACT_DETAIL_SHELL_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BranchDetailView } from "../branch-detail-view";

const SESSIONS_COUNT_RE = /sessions/;

vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: () => ({
    state: { status: "signed-out", userId: null, organizationId: null },
    beginSignIn: vi.fn(),
  }),
}));

const inertApiAdapter: ApiAdapter = {
  resolveApiOrigin: () => "http://test.local",
  fetch: () => Promise.reject(new Error("no remote REST API in tests")),
};

// Ids `sessionDetailHref` must encode, so a generic `/sessions/${id}` builder
// anywhere between this host and the link yields a different href.
const ENCODED_IDS: Readonly<Record<string, string>> = {
  s1: "ses/1",
  s2: "ses/2",
};
const rename = (id: string) => ENCODED_IDS[id] ?? id;

const hostDetail = {
  ...sessionsPanelDetail,
  sessionIds: sessionsPanelDetail.sessionIds.map(rename),
  sessions: sessionsPanelDetail.sessions.map((session) => ({
    ...session,
    sessionId: rename(session.sessionId),
  })),
  mergedTrace: sessionsPanelDetail.mergedTrace.map((item) => ({
    ...item,
    sessionId: rename(item.sessionId),
  })),
};

const hostTrace = {
  ...completeSessionsTrace,
  items: completeSessionsTrace.items.map((item) => ({
    ...item,
    sessionId: rename(item.sessionId),
  })),
  sessions: completeSessionsTrace.sessions.map((session) => ({
    ...session,
    identity: {
      ...session.identity,
      artifactId: rename(session.identity.artifactId),
    },
  })),
};

function installDesktopApi() {
  Object.defineProperty(globalThis, "desktopApi", {
    configurable: true,
    value: {
      branchesApi: {
        detail: vi.fn(() => Promise.resolve(hostDetail)),
        trace: vi.fn(() => Promise.resolve(hostTrace)),
        list: vi.fn(() =>
          Promise.resolve({ items: [], total: 0, viewerScope: "self" })
        ),
        usage: vi.fn(() => Promise.resolve({})),
        analytics: vi.fn(() => Promise.resolve({})),
      },
    },
  });
}

function renderDesktopHost(enabledFlags: readonly string[]) {
  const navigation = createMemoryNavigation({
    initialPath: `/branches/${sessionsPanelDetail.id}?${BRANCH_DETAIL_TAB_PARAM}=${BranchDetailTabParam.SessionsTimeline}`,
  });
  return render(
    <NavigationProvider adapter={navigation.adapter}>
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <AuthAdapterProvider adapter={createStaticAuthAdapter()}>
          <ApiAdapterProvider adapter={inertApiAdapter}>
            <FeatureFlagAdapterProvider
              adapter={createStaticFeatureFlagAdapter({
                enabledFlags: [...enabledFlags],
              })}
            >
              <BranchDetailView
                backHref="/branches"
                backLabel={BranchBackLabel.Branches}
                branchId={sessionsPanelDetail.id}
              />
            </FeatureFlagAdapterProvider>
          </ApiAdapterProvider>
        </AuthAdapterProvider>
      </QueryClientProvider>
    </NavigationProvider>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, "desktopApi");
});

/**
 * ISS-12210 — the DESKTOP host, unmocked from `BranchDetailView` down: its own
 * `getSessionHref` (`sessionDetailHref`) reaches the Sessions tab's trace
 * heading through the shared shell. Web twin:
 * `apps/app/app/(authenticated)/[orgSlug]/branches/[branchId]/__tests__/branch-session-links-mounted.test.tsx`.
 */
describe("desktop Branch Sessions tab session links", () => {
  it("links each Session name to the desktop Session route", async () => {
    installDesktopApi();
    renderDesktopHost([ARTIFACT_DETAIL_SHELL_FEATURE_FLAG_KEY]);
    // ISS-12448: the links open from the heading's session count.
    fireEvent.click(
      await screen.findByRole("button", {
        expanded: false,
        name: SESSIONS_COUNT_RE,
      })
    );

    const nav = await screen.findByRole("navigation", {
      name: BRANCH_TRACE_SESSION_LINKS_LABEL,
    });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((link) => [link.textContent, link.getAttribute("href")])
    ).toEqual([
      ["Fixture: Implement Branch Details", "/sessions/ses%2F1"],
      ["Fixture: Review Branch Details", "/sessions/ses%2F2"],
    ]);
  });

  it("renders no Session links on the legacy page with the shell off", async () => {
    installDesktopApi();
    renderDesktopHost([]);

    expect(
      await screen.findByText("Combined session trace", { exact: false })
    ).toBeDefined();
    expect(
      screen.queryByRole("navigation", {
        name: BRANCH_TRACE_SESSION_LINKS_LABEL,
      })
    ).toBeNull();
  });
});
