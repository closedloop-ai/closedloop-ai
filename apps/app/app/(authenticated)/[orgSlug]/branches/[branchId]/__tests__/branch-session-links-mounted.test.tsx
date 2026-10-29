// The shell's trace mounts a ResizeObserver, which this app's setup does not shim.
import "../../../../../../../../packages/typescript-config/vitest-jsdom-setup";
import {
  BRANCH_DETAIL_TAB_PARAM,
  BranchDetailTabParam,
} from "@repo/api/src/types/notification-routes";
import {
  completeSessionsTrace,
  sessionsPanelDetail,
} from "@repo/app/branches/components/detail/branch-sessions-panel-fixtures";
import { BRANCH_TRACE_SESSION_LINKS_LABEL } from "@repo/app/branches/components/detail/branch-trace-session-links";
import type { BranchesDataSource } from "@repo/app/branches/data-source/branches-data-source";
import { BranchesDataSourceProvider } from "@repo/app/branches/data-source/provider";
import { ARTIFACT_DETAIL_SHELL_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import BranchDetailRoutePage from "../page";

const SESSIONS_COUNT_RE = /sessions/;

const ORG_SLUG = "acme";

vi.mock("@/hooks/use-org-slug", () => ({ useOrgSlug: () => ORG_SLUG }));
// This app's vitest setup routes the navigation port to next/navigation.
vi.mock("next/navigation", () => {
  const router = {
    back: vi.fn(),
    forward: vi.fn(),
    push: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
  };
  const searchParams = new URLSearchParams({
    [BRANCH_DETAIL_TAB_PARAM]: BranchDetailTabParam.SessionsTimeline,
  });
  return {
    useParams: () => ({ branchId: "sessions-panel-branch", orgSlug: "acme" }),
    usePathname: () => "/acme/branches/sessions-panel-branch",
    useRouter: () => router,
    useSearchParams: () => searchParams,
  };
});
vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

const fixtureBranchesSource: BranchesDataSource = {
  scope: "branch-session-links-mounted",
  analytics: () => Promise.reject(new Error("analytics unused")),
  comments: () => Promise.reject(new Error("comments unused")),
  detail: () => Promise.resolve(sessionsPanelDetail),
  list: () => Promise.reject(new Error("list unused")),
  pageData: () => Promise.reject(new Error("pageData unused")),
  trace: () => Promise.resolve(completeSessionsTrace),
  usage: () => Promise.reject(new Error("usage unused")),
};

function renderWebHost(enabledFlags: readonly string[]) {
  return render(
    <AppCoreStoryProviders enabledFlags={enabledFlags}>
      <BranchesDataSourceProvider dataSource={fixtureBranchesSource}>
        <BranchDetailRoutePage />
      </BranchesDataSourceProvider>
    </AppCoreStoryProviders>
  );
}

/**
 * ISS-12210 — the WEB host from the route page down (only `@repo/navigation/link`
 * is the setup's plain `<a>` shim): its own org-scoped `getSessionHref` reaches
 * the Sessions tab's trace heading through the shared shell. Desktop twin:
 * `apps/desktop/src/renderer/components/branches/__tests__/branch-detail-session-links.test.tsx`.
 */
describe("web Branch Sessions tab session links", () => {
  it("links each Session name to the org-scoped Session route", async () => {
    renderWebHost([ARTIFACT_DETAIL_SHELL_FEATURE_FLAG_KEY]);
    // ISS-12448: the links open from the heading's session count.
    await userEvent.click(
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
      ["Fixture: Implement Branch Details", `/${ORG_SLUG}/sessions/s1`],
      ["Fixture: Review Branch Details", `/${ORG_SLUG}/sessions/s2`],
    ]);
  });

  it("renders no Session links on the legacy page with the shell off", async () => {
    renderWebHost([]);

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
