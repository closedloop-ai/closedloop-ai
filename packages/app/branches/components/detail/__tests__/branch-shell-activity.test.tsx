import { ArtifactActivityAction } from "@repo/api/src/types/artifact-activity";
import {
  ActivityFeedActorKind,
  ActivityFeedItemSource,
  ARTIFACT_ACTIVITY_FEED_DEFAULT_LIMIT,
  type ArtifactActivityFeedItem,
  type ArtifactActivityFeedResult,
} from "@repo/api/src/types/artifact-activity-feed";
import { CommentSurface } from "@repo/api/src/types/comment";
import { ArtifactDetailTab } from "@repo/app/shared/lib/artifact-detail-tab";
import {
  ARTIFACT_COMMENT_PARAM,
  DEFAULT_TAB_PARAM,
} from "@repo/app/shared/lib/detail-route-params";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestQueryClient,
  createWrapper,
  createWrapperWithClient,
} from "../../../../shared/test-utils";
import {
  type BranchesDataSource,
  createHttpBranchesDataSource,
} from "../../../data-source/branches-data-source";
import { BranchesDataSourceProvider } from "../../../data-source/provider";
import {
  branchActivityQueryKey,
  branchRowQueryKeys,
} from "../../../hooks/branch-query-keys";
import { BranchShellActivity } from "../branch-shell-activity";

const { source } = vi.hoisted(() => ({
  source: { current: null as BranchesDataSource | null },
}));

vi.mock("../../../data-source/provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../data-source/provider")>()),
  useBranchesDataSource: () => source.current,
}));

const SETTLED_EMPTY_QUERY = {
  data: [],
  isPending: false,
  isError: false,
  fetchStatus: "idle",
};
vi.mock("@repo/app/users/hooks/use-users", () => ({
  useOrganizationUsers: () => SETTLED_EMPTY_QUERY,
}));
vi.mock("@repo/app/projects/hooks/use-projects", () => ({
  useProjects: () => SETTLED_EMPTY_QUERY,
}));
// The activity row names a tag through the org-tag directory (ISS-12117),
// whose hook needs the auth adapter this suite does not mount.
vi.mock("@repo/app/tags/hooks/use-tags", () => ({
  useTags: () => SETTLED_EMPTY_QUERY,
}));

const BRANCH_ID = "66666666-6666-4666-8666-666666666661";
const BRANCH_PATH = `/acme/branches/${BRANCH_ID}`;
const NEWER_NAME = "feat/activity-tab";
const OLDER_NAME = "feat/activity";

function renameEvent(
  id: string,
  createdAt: string,
  before: string,
  after: string
): ArtifactActivityFeedItem {
  return {
    id: `event:${id}`,
    source: ActivityFeedItemSource.Event,
    action: ArtifactActivityAction.FieldChange,
    actor: { kind: ActivityFeedActorKind.System, id: null },
    before: { name: before },
    after: { name: after },
    payload: null,
    createdAt: new Date(createdAt),
  };
}

/** A projected comment thread, with whatever surface the case is about. */
function commentItem(
  payload: ArtifactActivityFeedItem["payload"]
): ArtifactActivityFeedItem {
  return {
    id: "comment:thread-7",
    source: ActivityFeedItemSource.Comment,
    action: null,
    actor: { id: "user-2", kind: ActivityFeedActorKind.Human },
    before: null,
    after: null,
    payload,
    createdAt: new Date("2026-10-02T00:00:00.000Z"),
  };
}

const FIRST_PAGE: ArtifactActivityFeedResult = {
  items: [renameEvent("2", "2026-10-02T00:00:00Z", OLDER_NAME, NEWER_NAME)],
  nextCursor: "cursor-1",
};
const SECOND_PAGE: ArtifactActivityFeedResult = {
  items: [renameEvent("1", "2026-10-01T00:00:00Z", "Untitled", OLDER_NAME)],
  nextCursor: null,
};

function httpSource(
  get: Parameters<typeof createHttpBranchesDataSource>[0]["get"]
) {
  return createHttpBranchesDataSource({ get });
}

function renderPanel() {
  return render(<BranchShellActivity branchId={BRANCH_ID} />, {
    wrapper: withNavigation(createWrapper()),
  });
}

function activityPathOf(call: unknown[]) {
  return new URL(String(call[0]), "https://api.example.test");
}

beforeEach(() => {
  source.current = null;
});

describe("BranchShellActivity", () => {
  it("renders the branch's activity from the read API and pages older rows on Load more", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(FIRST_PAGE)
      .mockResolvedValueOnce(SECOND_PAGE);
    source.current = httpSource(get);

    renderPanel();

    const list = await screen.findByRole("list", { name: "Activity" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    const first = activityPathOf(get.mock.calls[0]);
    expect(first.pathname).toBe(`/branches/${BRANCH_ID}/activity`);
    expect(first.searchParams.get("cursor")).toBeNull();
    expect(first.searchParams.get("limit")).toBe(
      String(ARTIFACT_ACTIVITY_FEED_DEFAULT_LIMIT)
    );

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    await waitFor(() =>
      expect(within(list).getAllByRole("listitem")).toHaveLength(2)
    );
    expect(activityPathOf(get.mock.calls[1]).searchParams.get("cursor")).toBe(
      "cursor-1"
    );
    expect(
      screen.queryByRole("button", { name: "Load more" })
    ).not.toBeInTheDocument();
  });

  /**
   * ISS-11004 projects comments into the Branch read too, so a comment item
   * arrives like any other row and renders as the read-only pointer the V1
   * design calls for.
   */
  it("renders a comment item as a row addressing its thread on this route", async () => {
    source.current = httpSource(
      vi.fn().mockResolvedValue({
        items: [commentItem({ threadId: "thread-7" })],
        nextCursor: null,
      })
    );

    renderPanel();

    const link = await screen.findByRole("link", { name: "View comment" });
    const href = new URL(
      link.getAttribute("href") ?? "",
      "https://app.example.test"
    );
    expect(href.pathname).toBe(BRANCH_PATH);
    expect(href.searchParams.get(ARTIFACT_COMMENT_PARAM)).toBe("thread-7");
    expect(screen.queryByText("No activity yet")).toBeNull();
  });

  /**
   * ISS-10963's approved design puts the Branch comments rail beside Artifact
   * and Sessions "and no others", so the address must select one of those —
   * leaving the reader on Activity would point at a tab with no rail to open
   * the thread. WHICH of the two is the thread's own surface (operator,
   * 2026-10-08): the rail reads a different collection per tab, so a timeline
   * thread is only in the Sessions rail.
   *
   * The reader starts on Activity in every case, so a tab that merely survived
   * would be `activity` and fail both arms.
   */
  it.each([
    [CommentSurface.BranchTimeline, ArtifactDetailTab.Sessions],
    [CommentSurface.BranchDetail, ArtifactDetailTab.Artifact],
  ])("sends a %s comment to the %s tab", async (surface, expectedTab) => {
    source.current = httpSource(
      vi.fn().mockResolvedValue({
        items: [commentItem({ surface, threadId: "thread-7" })],
        nextCursor: null,
      })
    );

    render(<BranchShellActivity branchId={BRANCH_ID} />, {
      wrapper: withNavigation(
        createWrapper(),
        `${BRANCH_PATH}?${DEFAULT_TAB_PARAM}=${ArtifactDetailTab.Activity}`
      ),
    });

    const link = await screen.findByRole("link", { name: "View comment" });
    const href = new URL(
      link.getAttribute("href") ?? "",
      "https://app.example.test"
    );
    expect(href.searchParams.get(DEFAULT_TAB_PARAM)).toBe(expectedTab);
    expect(href.searchParams.get(ARTIFACT_COMMENT_PARAM)).toBe("thread-7");
  });

  /**
   * A thread whose surface the feed could not state still has to go somewhere
   * a rail exists; Artifact is the branch's own comments tab.
   */
  it("sends a comment with no stated surface to the Artifact tab", async () => {
    source.current = httpSource(
      vi.fn().mockResolvedValue({
        items: [commentItem({ threadId: "thread-7" })],
        nextCursor: null,
      })
    );

    render(<BranchShellActivity branchId={BRANCH_ID} />, {
      wrapper: withNavigation(
        createWrapper(),
        `${BRANCH_PATH}?${DEFAULT_TAB_PARAM}=${ArtifactDetailTab.Activity}`
      ),
    });

    const link = await screen.findByRole("link", { name: "View comment" });
    const href = new URL(
      link.getAttribute("href") ?? "",
      "https://app.example.test"
    );
    expect(href.searchParams.get(DEFAULT_TAB_PARAM)).toBe(
      ArtifactDetailTab.Artifact
    );
  });

  it("shows loading while the first page is in flight", () => {
    source.current = httpSource(
      vi.fn().mockReturnValue(new Promise(() => undefined))
    );

    renderPanel();

    expect(
      screen.getByRole("status", { name: "Loading activity" })
    ).toBeInTheDocument();
  });

  it("shows a first-load failure as an error with retry, never as an empty history", async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ ...FIRST_PAGE, nextCursor: null });
    source.current = httpSource(get);

    renderPanel();

    expect(
      await screen.findByText("Couldn't load activity")
    ).toBeInTheDocument();
    expect(screen.queryByText("No activity yet")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    const list = await screen.findByRole("list", { name: "Activity" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("keeps loaded rows when the next page fails (partial)", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(FIRST_PAGE)
      .mockRejectedValueOnce(new Error("boom"));
    source.current = httpSource(get);

    renderPanel();

    const list = await screen.findByRole("list", { name: "Activity" });
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    expect(
      await screen.findByText("Couldn't load more activity")
    ).toBeInTheDocument();
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(
      screen.queryByText("Couldn't load activity")
    ).not.toBeInTheDocument();
  });

  it("surfaces a failed background refresh of a cached feed and retries", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ ...FIRST_PAGE, nextCursor: null })
      .mockRejectedValueOnce(new Error("refresh failed"))
      .mockResolvedValueOnce({ ...FIRST_PAGE, nextCursor: null });
    source.current = httpSource(get);
    const scope = source.current.scope;
    const client = createTestQueryClient();
    render(<BranchShellActivity branchId={BRANCH_ID} />, {
      wrapper: withNavigation(createWrapperWithClient(client)),
    });
    await waitFor(() => expect(client.isFetching()).toBe(0));

    await act(async () => {
      await client.invalidateQueries({
        queryKey: branchActivityQueryKey(scope, undefined, BRANCH_ID),
      });
    });

    expect(await screen.findByText("Couldn't load activity")).toBeVisible();
    expect(screen.queryByText("No activity yet")).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("list", { name: "Activity" })).getAllByRole(
        "listitem"
      )
    ).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.queryByText("Couldn't load activity")).toBeNull()
    );
    expect(get).toHaveBeenCalledTimes(3);
    client.clear();
  });

  /**
   * PR #8601 review: desktop re-namespaces the Branch client on an account
   * switch, so the feed must cache there under the identity scope, never in
   * the ambient client under a key with no identity segment.
   */
  it("caches the feed in the Branch query client under its identity scope", async () => {
    source.current = httpSource(
      vi.fn().mockResolvedValue({ ...FIRST_PAGE, nextCursor: null })
    );
    const scope = source.current.scope;
    const ambientClient = createTestQueryClient();
    const branchClient = createTestQueryClient();
    const identity = { cacheScope: "desktop-cloud:account-a" };
    const AmbientWrapper = createWrapperWithClient(ambientClient);
    const dataSource = source.current;
    const withBranchClient = ({ children }: { children: ReactNode }) => (
      <AmbientWrapper>
        <BranchesDataSourceProvider
          dataSource={dataSource}
          queryClient={branchClient}
          queryIdentity={identity}
        >
          {children}
        </BranchesDataSourceProvider>
      </AmbientWrapper>
    );
    render(<BranchShellActivity branchId={BRANCH_ID} />, {
      wrapper: withNavigation(withBranchClient),
    });

    await screen.findByRole("list", { name: "Activity" });
    expect(
      branchClient.getQueryData(
        branchActivityQueryKey(scope, identity, BRANCH_ID)
      )
    ).toBeDefined();
    expect(
      branchClient.getQueryData(
        branchActivityQueryKey(scope, undefined, BRANCH_ID)
      )
    ).toBeUndefined();
    expect(
      ambientClient
        .getQueryCache()
        .findAll({ queryKey: branchRowQueryKeys.all })
    ).toHaveLength(0);
    ambientClient.clear();
    branchClient.clear();
  });

  it("shows the empty state when the branch has no activity", async () => {
    source.current = httpSource(
      vi.fn().mockResolvedValue({ items: [], nextCursor: null })
    );

    renderPanel();

    expect(await screen.findByText("No activity yet")).toBeInTheDocument();
  });

  /**
   * The port's `activityPage` is optional, and a source without it must read
   * as "this source serves no activity", not as a failed read. The name says
   * exactly that and no more: whether a reader can actually REACH such a
   * source on this surface is a separate question, raised on the PR — the
   * desktop local source is the one that omits the method, and the shell above
   * it is gated on a PostHog key that a signed-out desktop cannot resolve.
   */
  it("shows the empty state without reading when the source serves no activity", () => {
    const get = vi.fn();
    const { activityPage: _omitted, ...localLike } = httpSource(get);
    source.current = localLike;

    renderPanel();

    expect(screen.getByText("No activity yet")).toBeInTheDocument();
    expect(
      screen.queryByRole("status", { name: "Loading activity" })
    ).not.toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });
});

/**
 * This panel reads the navigation port for the comment address, so every case
 * needs an adapter — unlike the Session panel, which takes its link builder
 * from its host and can mount bare.
 */
function withNavigation(
  Wrapper: ({ children }: { children: ReactNode }) => ReactElement,
  initialPath = BRANCH_PATH
) {
  return ({ children }: { children: ReactNode }) => (
    <Wrapper>
      <NavigationProvider
        adapter={createMemoryNavigation({ initialPath }).adapter}
      >
        {children}
      </NavigationProvider>
    </Wrapper>
  );
}
