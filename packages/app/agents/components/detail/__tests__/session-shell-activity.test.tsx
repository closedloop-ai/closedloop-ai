import { ArtifactActivityAction } from "@repo/api/src/types/artifact-activity";
import {
  ActivityFeedActorKind,
  ActivityFeedItemSource,
  ARTIFACT_ACTIVITY_FEED_DEFAULT_LIMIT,
  type ArtifactActivityFeedItem,
  type ArtifactActivityFeedResult,
} from "@repo/api/src/types/artifact-activity-feed";
import type { ArtifactCommentAddress } from "@repo/app/documents/components/artifact-activity/artifact-activity-rows";
import { ArtifactDetailTab } from "@repo/app/shared/lib/artifact-detail-tab";
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
  type AgentSessionsDataSource,
  createHttpAgentSessionsDataSource,
} from "../../../data-source/agent-sessions-data-source";
import { agentSessionKeys } from "../../../hooks/agent-session-keys";
import { SessionShellActivity } from "../session-shell-activity";

/**
 * The host's link builder, as the production host passes one. A Session has
 * ONE comments rail, in its Sessions panel, so the host ignores the address's
 * surface and names that tab for every thread.
 */
const commentHref = ({ threadId }: ArtifactCommentAddress) =>
  `/sessions/${SESSION_ID}?tab=${ArtifactDetailTab.Sessions}&comment=${threadId}`;

const { source } = vi.hoisted(() => ({
  source: { current: null as AgentSessionsDataSource | null },
}));

vi.mock("../../../data-source/provider", () => ({
  useAgentSessionsDataSource: () => source.current,
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
// The activity row names a tag through the org-tag directory (ISS-12117).
vi.mock("@repo/app/tags/hooks/use-tags", () => ({
  useTags: () => SETTLED_EMPTY_QUERY,
}));

const SESSION_ID = "55555555-5555-4555-8555-555555555551";
const NEWER_NAME = "Activity card: lighter timeline row";
const OLDER_NAME = "Refactor the activity card";

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

const FIRST_PAGE: ArtifactActivityFeedResult = {
  items: [renameEvent("2", "2026-10-02T00:00:00Z", OLDER_NAME, NEWER_NAME)],
  nextCursor: "cursor-1",
};
const SECOND_PAGE: ArtifactActivityFeedResult = {
  items: [renameEvent("1", "2026-10-01T00:00:00Z", "Untitled", OLDER_NAME)],
  nextCursor: null,
};

function httpSource(
  get: Parameters<typeof createHttpAgentSessionsDataSource>[0]["get"]
) {
  return createHttpAgentSessionsDataSource({ get });
}

function renderPanel() {
  return render(
    <SessionShellActivity
      buildCommentHref={commentHref}
      sessionId={SESSION_ID}
    />,
    {
      wrapper: createWrapper(),
    }
  );
}

function activityPathOf(call: unknown[]) {
  return new URL(String(call[0]), "https://api.example.test");
}

beforeEach(() => {
  source.current = null;
});

describe("SessionShellActivity", () => {
  /**
   * ISS-11004: the read API projects comments into this feed, so a comment
   * item arrives like any other row and renders as the read-only pointer the
   * V1 design calls for, linking to its thread.
   */
  it("renders a comment item from the feed as a row linking to its thread", async () => {
    source.current = httpSource(
      vi.fn().mockResolvedValue({
        items: [
          {
            action: null,
            actor: { id: "user-2", kind: ActivityFeedActorKind.Human },
            after: null,
            before: null,
            createdAt: new Date("2026-10-02T00:00:00.000Z"),
            id: "comment:thread-7",
            payload: { threadId: "thread-7" },
            source: ActivityFeedItemSource.Comment,
          },
        ],
        nextCursor: null,
      })
    );

    render(
      <SessionShellActivity
        buildCommentHref={commentHref}
        sessionId={SESSION_ID}
      />,
      { wrapper: withNavigation(createWrapper()) }
    );

    const link = await screen.findByRole("link", { name: "View comment" });
    expect(link).toHaveAttribute(
      "href",
      commentHref({ surface: null, threadId: "thread-7" })
    );
    expect(screen.queryByText("No activity yet")).toBeNull();
  });

  it("refreshes fresh cached activity when the tab is reopened", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ items: [], nextCursor: null })
      .mockResolvedValueOnce({ ...FIRST_PAGE, nextCursor: null });
    source.current = httpSource(get);
    const client = createTestQueryClient();
    client.setQueryDefaults(
      agentSessionKeys.activity(source.current.scope, SESSION_ID),
      { gcTime: Number.POSITIVE_INFINITY }
    );
    const wrapper = createWrapperWithClient(client);
    const first = render(
      <SessionShellActivity
        buildCommentHref={commentHref}
        sessionId={SESSION_ID}
      />,
      {
        wrapper,
      }
    );
    expect(await screen.findByText("No activity yet")).toBeInTheDocument();
    first.unmount();

    render(
      <SessionShellActivity
        buildCommentHref={commentHref}
        sessionId={SESSION_ID}
      />,
      {
        wrapper,
      }
    );

    expect(await screen.findByRole("list", { name: "Activity" })).toBeVisible();
    expect(get).toHaveBeenCalledTimes(2);
    client.clear();
  });

  it.each([
    ["populated", { ...FIRST_PAGE, nextCursor: null }],
    ["empty", { items: [], nextCursor: null }],
  ] as const)(
    "surfaces a failed background refresh of a cached %s feed and retries",
    async (_label, page) => {
      const get = vi
        .fn()
        .mockResolvedValueOnce(page)
        .mockRejectedValueOnce(new Error("refresh failed"))
        .mockResolvedValueOnce(page);
      source.current = httpSource(get);
      const scope = source.current.scope;
      const client = createTestQueryClient();
      render(
        <SessionShellActivity
          buildCommentHref={commentHref}
          sessionId={SESSION_ID}
        />,
        {
          wrapper: createWrapperWithClient(client),
        }
      );
      await waitFor(() => expect(client.isFetching()).toBe(0));

      await act(async () => {
        await client.invalidateQueries({
          queryKey: agentSessionKeys.activity(scope, SESSION_ID),
        });
      });

      expect(await screen.findByText("Couldn't load activity")).toBeVisible();
      expect(screen.queryByText("No activity yet")).not.toBeInTheDocument();
      if (page.items.length > 0) {
        expect(
          within(screen.getByRole("list", { name: "Activity" })).getAllByRole(
            "listitem"
          )
        ).toHaveLength(1);
      }

      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() =>
        expect(screen.queryByText("Couldn't load activity")).toBeNull()
      );
      expect(get).toHaveBeenCalledTimes(3);
      client.clear();
    }
  );

  it("renders the session's activity from the read API and pages older rows on Load more", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(FIRST_PAGE)
      .mockResolvedValueOnce(SECOND_PAGE);
    source.current = httpSource(get);

    renderPanel();

    const list = await screen.findByRole("list", { name: "Activity" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    const first = activityPathOf(get.mock.calls[0]);
    expect(first.pathname).toBe(`/agent-sessions/${SESSION_ID}/activity`);
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

  it("shows the empty state when the session has no activity", async () => {
    source.current = httpSource(
      vi.fn().mockResolvedValue({ items: [], nextCursor: null })
    );

    renderPanel();

    expect(await screen.findByText("No activity yet")).toBeInTheDocument();
  });

  it("shows the empty state without reading when the source serves no activity (desktop Local mode)", () => {
    const get = vi.fn();
    const {
      activityPage: _activityPage,
      capabilitiesForSession: _capabilitiesForSession,
      ...localLike
    } = httpSource(get);
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
 * The comment row's "View comment" link is a `@repo/navigation` Link, which
 * needs a navigation adapter; the activity rows beside it do not, which is why
 * only this case composes one around the suite's query wrapper.
 */
function withNavigation(
  Wrapper: ({ children }: { children: ReactNode }) => ReactElement
) {
  return ({ children }: { children: ReactNode }) => (
    <Wrapper>
      <NavigationProvider
        adapter={createMemoryNavigation({ initialPath: "/sessions" }).adapter}
      >
        {children}
      </NavigationProvider>
    </Wrapper>
  );
}
