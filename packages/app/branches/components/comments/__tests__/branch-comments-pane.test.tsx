import type { BranchSelectedPullRequestIdentity } from "@repo/api/src/types/branch-associated-pull-request";
import {
  CommentSurface,
  CommentTargetType,
  type TraceTextAnchor,
} from "@repo/api/src/types/comment";
import { traceTextAnchorToCommentAnchor } from "@repo/api/src/types/comment-anchor";
import { CommentPolicyKey } from "@repo/api/src/types/comment-capabilities";
import type {
  ArtifactCommentsResponse,
  CommentThreadDto,
} from "@repo/api/src/types/comment-thread-dto";
import {
  CommentsPaneOpenKey,
  CommentsPaneWidthKey,
  showCommentsPaneTransiently,
} from "@repo/app/shared/components/comments/use-comments-pane-state";
import { ArtifactDetailTab } from "@repo/app/shared/lib/artifact-detail-tab";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fakeCommentsSource,
  ORG_ID,
} from "../../../../shared/comments/__tests__/comments-test-source";
import type { CommentsDataSource } from "../../../../shared/comments/comments-data-source";
import {
  capabilitiesFor,
  FULL_CAPABILITIES,
  githubThread,
  makeComment,
  makeThread,
  NO_PERMISSIONS,
  traceAnchor,
} from "../../../../shared/components/comments/comments-pane.fixtures";
import { CommentsPaneLoadStatus } from "../../../../shared/components/comments/comments-pane-model";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import { DEFAULT_COMMENTS_WIDTH } from "../branch-comments-model";
import {
  BranchCommentsPaneContent,
  type BranchCommentsPaneProps,
  mergeBranchComments,
} from "../branch-comments-pane";
import type { BranchSessionComments } from "../branch-session-comments-sources";

/** The pane's heading carries its count, so it is matched by its leading word. */
const COMMENTS_HEADING = /^Comments/;

const BRANCH = "branch-artifact";
const SESSION = "session-a";
const SESSION_ARTIFACT = "session-a-artifact";
const SESSION_ROW = 7;
const SESSION_PASSAGE = "Ran the focused suite";

const GITHUB = githubThread("gh-1", { artifactId: BRANCH });
const BRANCH_DETAIL = makeThread({
  artifactId: BRANCH,
  id: "branch-detail-1",
  surface: CommentSurface.BranchDetail,
});
const BRANCH_TIMELINE = makeThread({
  anchor: traceAnchor("Timeline passage", { row: 2, sessionId: "elsewhere" }),
  artifactId: BRANCH,
  id: "branch-timeline-1",
  surface: CommentSurface.BranchTimeline,
});
const SESSION_THREAD = makeThread({
  anchor: traceAnchor(SESSION_PASSAGE, {
    row: SESSION_ROW,
    sessionId: SESSION,
  }),
  artifactId: SESSION_ARTIFACT,
  id: "session-thread-1",
});

const SELECTION: TraceTextAnchor = {
  endOffset: 3,
  row: SESSION_ROW,
  selectedText: "Ran",
  sessionId: SESSION,
  sourceText: "Ran",
  startOffset: 0,
  traceId: "trace-1",
  turnId: "turn-7",
};

function page(
  artifactId: string,
  threads: CommentThreadDto[]
): Promise<ArtifactCommentsResponse> {
  return Promise.resolve({
    artifactId,
    capabilities: FULL_CAPABILITIES,
    nextCursor: null,
    threads,
  });
}

/** The server's reads: the Branch with or without a surface, and one Session. */
function branchSource() {
  const source = fakeCommentsSource();
  source.list.mockImplementation((targetId, options = {}) => {
    if (targetId !== BRANCH) {
      return page(SESSION_ARTIFACT, [SESSION_THREAD]);
    }
    return options.surface === CommentSurface.BranchTimeline
      ? page(BRANCH, [BRANCH_TIMELINE])
      : page(BRANCH, [GITHUB, BRANCH_DETAIL, BRANCH_TIMELINE]);
  });
  source.createThread.mockImplementation((artifactId, request) =>
    Promise.resolve(
      makeThread({ anchor: request.anchor, artifactId, id: "created" })
    )
  );
  return source;
}

function renderPane(
  overrides: Partial<BranchCommentsPaneProps> = {},
  source: CommentsDataSource = branchSource()
) {
  const order: string[] = [];
  const props: BranchCommentsPaneProps = {
    activeTab: ArtifactDetailTab.Sessions,
    branchArtifactId: BRANCH,
    composerTarget: null,
    onRevealTraceAnchor: vi.fn((anchor) => order.push(`jump:${anchor.row}`)),
    renderedSessions: { coverageNote: null, sessionIds: [SESSION] },
    selectTabThenReveal: vi.fn((tab, reveal) => {
      order.push(`select:${tab}`);
      reveal();
    }),
    selectedPullRequestKey: "closedloop-ai/closedloop-ai#1",
    ...overrides,
  };
  const pane = (next: Partial<BranchCommentsPaneProps> = {}) => (
    <AppCoreStoryProviders>
      <BranchCommentsPaneContent
        {...props}
        {...next}
        dataSource={source}
        organizationId={ORG_ID}
      />
    </AppCoreStoryProviders>
  );
  const { rerender, unmount } = render(pane());
  return {
    order,
    rerender: (next: Partial<BranchCommentsPaneProps>) => rerender(pane(next)),
    source,
    unmount,
  };
}

describe("BranchCommentsPaneContent (PLN-2162 M6.2)", () => {
  afterEach(() => {
    globalThis.localStorage.clear();
  });

  /**
   * ISS-10980: the Branch Activity tab's comment rows link with `?comment=`,
   * and the reader must land ON the thread, as they do from the Session tab.
   * The shared pane marks the selected card `aria-current` and scrolls to it,
   * so selecting it is the whole contract this pane owes.
   */
  it("selects the addressed thread once it is listed", async () => {
    renderPane({
      activeTab: ArtifactDetailTab.Artifact,
      addressedThreadId: BRANCH_DETAIL.id,
    });

    await waitFor(() =>
      expect(
        document.querySelector(`[data-thread-id="${BRANCH_DETAIL.id}"]`)
      ).toBeInTheDocument()
    );
    const addressed = document
      .querySelector(`[data-thread-id="${BRANCH_DETAIL.id}"]`)
      ?.querySelector('[aria-current="true"]');
    expect(addressed).not.toBeNull();
  });

  /** A thread the address does not name must not be marked. */
  it("marks only the addressed thread", async () => {
    renderPane({
      activeTab: ArtifactDetailTab.Artifact,
      addressedThreadId: BRANCH_DETAIL.id,
    });

    await waitFor(() =>
      expect(
        document.querySelector(`[data-thread-id="${GITHUB.id}"]`)
      ).toBeInTheDocument()
    );
    expect(
      document
        .querySelector(`[data-thread-id="${GITHUB.id}"]`)
        ?.querySelector('[aria-current="true"]')
    ).toBeNull();
  });

  /**
   * The pane reads nothing while closed, so an address has to open it first or
   * it would deadlock: closed means no read, and not-listed would mean no
   * reveal. This is the arm that breaks that cycle. The reader followed a link
   * and did not ask for the pane, so the saved hidden state stands (ISS-12300
   * D6).
   */
  it("opens a closed pane for an addressed thread without saving it open", async () => {
    globalThis.localStorage.setItem(
      CommentsPaneOpenKey.BranchArtifact,
      "false"
    );
    renderPane({
      activeTab: ArtifactDetailTab.Artifact,
      addressedThreadId: BRANCH_DETAIL.id,
    });

    expect(
      await screen.findByRole("heading", { name: COMMENTS_HEADING })
    ).toBeVisible();
    await waitFor(() => expect(isMarked(BRANCH_DETAIL.id)).toBe(true));
    expect(
      globalThis.localStorage.getItem(CommentsPaneOpenKey.BranchArtifact)
    ).toBe("false");
  });

  /**
   * The reveal is keyed on the address, so a reader who hides the pane after
   * landing is not fought on a later render.
   */
  it("leaves a pane the reader hid after an addressed reveal hidden", async () => {
    const user = userEvent.setup();
    const pane = renderPane({
      activeTab: ArtifactDetailTab.Artifact,
      addressedThreadId: BRANCH_DETAIL.id,
    });
    await user.click(
      await screen.findByRole("button", { name: "Close comments" })
    );

    pane.rerender({ selectedPullRequestKey: OTHER_PR_KEY });

    expect(
      screen.queryByRole("heading", { name: COMMENTS_HEADING })
    ).toBeNull();
  });

  /**
   * Details and Activity have no collection (`scopeForTab` returns null), so
   * an address cannot be shown there and must not drag the pane open. Without
   * this the Activity tab's own link would open a pane showing the previous
   * tab's threads and mark nothing. Moving to Branch details afterwards shows
   * the saved hidden pane, which a reveal on the earlier tab would have shown.
   */
  it.each([ArtifactDetailTab.Details, ArtifactDetailTab.Activity])(
    "ignores an address on %s, which has no collection",
    (activeTab) => {
      globalThis.localStorage.setItem(
        CommentsPaneOpenKey.BranchArtifact,
        "false"
      );
      const pane = renderPane({
        activeTab,
        addressedThreadId: BRANCH_DETAIL.id,
      });

      pane.rerender({
        activeTab: ArtifactDetailTab.Artifact,
        addressedThreadId: null,
      });

      expect(
        screen.queryByRole("heading", { name: COMMENTS_HEADING })
      ).toBeNull();
    }
  );

  /**
   * whitlockk, #8619: the pane lists only the selected pull request's GitHub
   * threads, so an address naming a thread on ANOTHER pull request must switch
   * the selection to that pull request first, or the link opens a pane showing
   * a different PR's comments. Driven through a host that owns the selection,
   * so the case fails unless the switch actually brings the thread on screen.
   */
  it("switches to an addressed GitHub thread's own pull request, then marks it", async () => {
    const onSelectPullRequest = vi.fn();
    render(
      <AppCoreStoryProviders>
        <SelectedPullRequestHost
          onSelectPullRequest={onSelectPullRequest}
          source={otherPullRequestSource()}
        />
      </AppCoreStoryProviders>
    );

    await waitFor(() => expect(isMarked(GITHUB_OTHER_PR.id)).toBe(true));
    expect(onSelectPullRequest).toHaveBeenCalledTimes(1);
    expect(onSelectPullRequest).toHaveBeenCalledWith({
      pullRequestNumber: OTHER_PR_NUMBER,
      repositoryFullName: PR_REPOSITORY,
    });
  });

  /** A thread already on the selected pull request needs no switch. */
  it("leaves the selection alone for a GitHub thread on the selected pull request", async () => {
    const onSelectPullRequest = vi.fn();
    renderPane(
      {
        activeTab: ArtifactDetailTab.Artifact,
        addressedThreadId: GITHUB_OTHER_PR.id,
        onSelectPullRequest,
        selectedPullRequestKey: OTHER_PR_KEY,
      },
      otherPullRequestSource()
    );

    await waitFor(() => expect(isMarked(GITHUB_OTHER_PR.id)).toBe(true));
    expect(onSelectPullRequest).not.toHaveBeenCalled();
  });

  /**
   * Until Branch details reports its selection there is nothing to compare
   * against, and switching then would turn the default pull request into an
   * explicit pick for a thread that was already on it.
   */
  it("does not switch before Branch details reports a selected pull request", async () => {
    const onSelectPullRequest = vi.fn();
    const { source } = renderPane(
      {
        activeTab: ArtifactDetailTab.Artifact,
        addressedThreadId: GITHUB_OTHER_PR.id,
        onSelectPullRequest,
        selectedPullRequestKey: null,
      },
      otherPullRequestSource()
    );

    await waitFor(() => expect(source.list).toHaveBeenCalled());
    await screen.findByText(`Body of ${BRANCH_DETAIL.id}`);
    expect(onSelectPullRequest).not.toHaveBeenCalled();
  });

  it("shows GitHub and Branch-details threads on Branch details, not the timeline's", async () => {
    renderPane({ activeTab: ArtifactDetailTab.Artifact });

    expect(
      await screen.findByText(`Body of ${BRANCH_DETAIL.id}`)
    ).toBeVisible();
    expect(
      screen.getByText("Should this guard the empty anchor case too?")
    ).toBeVisible();
    expect(screen.queryByText(`Body of ${BRANCH_TIMELINE.id}`)).toBeNull();
  });

  it("selects the Sessions tab before it scrolls to a rendered Session's thread", async () => {
    const user = userEvent.setup();
    const { order, source } = renderPane();

    await user.click(
      await screen.findByRole("button", { name: `Jump to ${SESSION_PASSAGE}` })
    );

    expect(order).toEqual([
      `select:${ArtifactDetailTab.Sessions}`,
      `jump:${SESSION_ROW}`,
    ]);
    expect(source.list).toHaveBeenCalledWith(
      BRANCH,
      expect.objectContaining({ surface: CommentSurface.BranchTimeline })
    );
    expect(source.list).toHaveBeenCalledWith(SESSION, expect.anything());
  });

  it("writes a thread on a rendered Session's selection to that Session's artifact", async () => {
    const user = userEvent.setup();
    const { source } = renderPane({
      composerTarget: {
        anchor: { id: "selection", label: "Ran", trace: SELECTION },
        target: { id: SESSION, type: CommentTargetType.Session },
      },
    });
    await screen.findByText(`Body of ${SESSION_THREAD.id}`);

    await user.type(
      screen.getByRole("textbox", { name: "Comment on Ran" }),
      "Flaky?"
    );
    await user.click(screen.getByRole("button", { name: "Comment" }));

    await waitFor(() =>
      expect(source.createThread).toHaveBeenCalledExactlyOnceWith(
        SESSION_ARTIFACT,
        expect.objectContaining({
          anchor: traceTextAnchorToCommentAnchor(SELECTION),
          body: "Flaky?",
        })
      )
    );
  });

  it("writes a thread on an unrendered Session's selection to the Branch timeline", async () => {
    const user = userEvent.setup();
    const { source } = renderPane({
      composerTarget: {
        anchor: { id: "selection", label: "Ran", trace: SELECTION },
        target: { id: BRANCH, type: CommentTargetType.Branch },
      },
    });
    await screen.findByText(`Body of ${SESSION_THREAD.id}`);

    await user.type(
      screen.getByRole("textbox", { name: "Comment on Ran" }),
      "Flaky?"
    );
    await user.click(screen.getByRole("button", { name: "Comment" }));

    await waitFor(() =>
      expect(source.createThread).toHaveBeenCalledExactlyOnceWith(
        BRANCH,
        expect.objectContaining({
          body: "Flaky?",
          surface: CommentSurface.BranchTimeline,
        })
      )
    );
  });

  it("reads at most four rendered Sessions at once and starts the next as one lands", async () => {
    const source = branchSource();
    const pending = new Map<string, () => void>();
    source.list.mockImplementation((targetId) => {
      if (targetId === BRANCH) {
        return page(BRANCH, []);
      }
      return new Promise((resolve) => {
        pending.set(targetId, () =>
          resolve({
            artifactId: `${targetId}-artifact`,
            capabilities: FULL_CAPABILITIES,
            nextCursor: null,
            threads: [],
          })
        );
      });
    });
    const sessionIds = ["s-1", "s-2", "s-3", "s-4", "s-5", "s-6"];
    renderPane(
      { renderedSessions: { coverageNote: null, sessionIds } },
      source
    );

    await waitFor(() => expect(pending.size).toBe(4));
    expect([...pending.keys()]).toEqual(["s-1", "s-2", "s-3", "s-4"]);

    pending.get("s-1")?.();
    await waitFor(() => expect(pending.has("s-5")).toBe(true));
    expect(pending.has("s-6")).toBe(false);
  });

  it("gives a GitHub thread its own source's capabilities: a link out and no reply", async () => {
    const { github, native } = await renderGithubDetails();

    expect(
      within(native).getByRole("button", { name: "Reply to comment" })
    ).toBeVisible();
    expect(
      within(github).queryByRole("button", { name: "Reply to comment" })
    ).toBeNull();
    expect(
      within(github)
        .getAllByRole("link")
        .map((link) => link.getAttribute("href"))
    ).toContain(GITHUB_MARKDOWN.provider.linkOut);
  });

  it("gives a rendered Session's thread its Session's capabilities: resolve, which the timeline's thread lacks (ISS-12516)", async () => {
    // On the rendered Session's trace, so the Sessions tab lists it.
    const timeline = makeThread({
      anchor: traceAnchor("Timeline passage", { row: 3, sessionId: SESSION }),
      artifactId: BRANCH,
      id: "branch-timeline-on-session",
      surface: CommentSurface.BranchTimeline,
    });
    const source = branchSource();
    source.list.mockImplementation((targetId) =>
      Promise.resolve(
        targetId === BRANCH
          ? {
              artifactId: BRANCH,
              capabilities: capabilitiesFor(CommentPolicyKey.NativeBranch),
              nextCursor: null,
              threads: [timeline],
            }
          : {
              artifactId: SESSION_ARTIFACT,
              capabilities: capabilitiesFor(CommentPolicyKey.NativeSession),
              nextCursor: null,
              threads: [SESSION_THREAD],
            }
      )
    );
    renderPane({}, source);
    await screen.findByText(`Body of ${SESSION_THREAD.id}`);
    await screen.findByText(`Body of ${timeline.id}`);

    expect(
      within(threadCard(SESSION_THREAD.id)).getByRole("button", {
        name: "Resolve comment",
      })
    ).toBeVisible();
    expect(
      within(threadCard(timeline.id)).queryByRole("button", {
        name: "Resolve comment",
      })
    ).toBeNull();
  });

  it("renders a GitHub thread's body as the PR comment Markdown the legacy rail did", async () => {
    const { github } = await renderGithubDetails();

    expect(
      within(github).getByRole("link", { name: "the guide" })
    ).toHaveAttribute("href", "https://example.com/guide");
    expect(github).toHaveTextContent("const guarded = true;");
    expect(github).not.toHaveTextContent("```");
  });
  it("shows a failed Session read with nothing to show as the pane's failed read, and retries it", async () => {
    const user = userEvent.setup();
    const source = branchSource();
    let sessionReads = 0;
    source.list.mockImplementation((targetId) => {
      if (targetId === BRANCH) {
        return page(BRANCH, []);
      }
      sessionReads += 1;
      return Promise.reject(new Error("session read failed"));
    });
    renderPane({}, source);

    const alert = await screen.findByRole("alert");
    await user.click(within(alert).getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(sessionReads).toBeGreaterThan(1));
  });

  it("renders nothing on Details or Activity", async () => {
    const { source } = renderPane({ activeTab: ArtifactDetailTab.Details });

    await waitFor(() => expect(source.list).toHaveBeenCalled());
    expect(
      screen.queryByRole("heading", { name: COMMENTS_HEADING })
    ).toBeNull();
  });

  describe("per-tab state (ISS-12300 D1/D2)", () => {
    it("hides on one tab only, and carries that to the next Branch", async () => {
      const user = userEvent.setup();
      const first = renderPane({ activeTab: ArtifactDetailTab.Artifact });
      await user.click(
        await screen.findByRole("button", { name: "Close comments" })
      );
      expect(
        globalThis.localStorage.getItem(CommentsPaneOpenKey.BranchArtifact)
      ).toBe("false");
      expect(
        globalThis.localStorage.getItem(CommentsPaneOpenKey.BranchSessions)
      ).toBeNull();
      first.unmount();

      renderPane({ activeTab: ArtifactDetailTab.Sessions });
      expect(
        await screen.findByRole("heading", { name: COMMENTS_HEADING })
      ).toBeVisible();
      cleanup();

      const { source } = renderPane({
        activeTab: ArtifactDetailTab.Artifact,
        branchArtifactId: "another-branch",
      });
      await waitFor(() =>
        expect(source.list).not.toHaveBeenCalledWith(
          "another-branch",
          expect.anything()
        )
      );
      expect(
        screen.queryByRole("heading", { name: COMMENTS_HEADING })
      ).toBeNull();
    });

    it("ends a transient reveal with its Branch and keeps the saved hidden pane", async () => {
      globalThis.localStorage.setItem(
        CommentsPaneOpenKey.BranchSessions,
        "false"
      );
      const pane = renderPane({ activeTab: ArtifactDetailTab.Sessions });
      expect(
        screen.queryByRole("heading", { name: COMMENTS_HEADING })
      ).toBeNull();

      act(() =>
        showCommentsPaneTransiently(CommentsPaneOpenKey.BranchSessions)
      );
      expect(
        await screen.findByRole("heading", { name: COMMENTS_HEADING })
      ).toBeVisible();

      pane.rerender({ branchArtifactId: "another-branch" });
      expect(
        screen.queryByRole("heading", { name: COMMENTS_HEADING })
      ).toBeNull();
      expect(
        globalThis.localStorage.getItem(CommentsPaneOpenKey.BranchSessions)
      ).toBe("false");
    });

    it("keeps a width per tab", async () => {
      const first = renderPane({ activeTab: ArtifactDetailTab.Sessions });
      fireEvent.keyDown(
        await screen.findByRole("separator", { name: RESIZE }),
        { key: "End" }
      );
      expect(
        globalThis.localStorage.getItem(CommentsPaneWidthKey.BranchSessions)
      ).toBe("560");
      first.unmount();

      renderPane({ activeTab: ArtifactDetailTab.Artifact });
      expect(
        await screen.findByRole("separator", { name: RESIZE })
      ).toHaveAttribute("aria-valuenow", String(DEFAULT_COMMENTS_WIDTH));
      expect(
        globalThis.localStorage.getItem(CommentsPaneWidthKey.BranchArtifact)
      ).toBeNull();
    });
  });
});

const RESIZE = "Resize comments rail";

describe("mergeBranchComments", () => {
  const branch = {
    loadState: { status: CommentsPaneLoadStatus.Ready },
    pendingDraftKeys: [],
    threads: [BRANCH_TIMELINE],
  } as const;
  const session = (
    status: CommentsPaneLoadStatus,
    threads: CommentThreadDto[] = []
  ): BranchSessionComments => ({
    capabilities: null,
    pendingDraftKeys: [],
    retry: vi.fn(),
    status,
    threads,
    writes: fakeWrites(),
  });

  it("is partial, never empty, while a rendered Session's read has not landed", () => {
    expect(
      mergeBranchComments({
        branch,
        hasArtifact: true,
        scope: "sessions",
        sessionCount: 2,
        sessions: [session(CommentsPaneLoadStatus.Ready, [SESSION_THREAD])],
      })
    ).toEqual({
      pendingDraftKeys: [],
      status: CommentsPaneLoadStatus.Partial,
      threads: [BRANCH_TIMELINE, SESSION_THREAD],
    });
    expect(
      mergeBranchComments({
        branch,
        hasArtifact: true,
        scope: "sessions",
        sessionCount: 1,
        sessions: [session(CommentsPaneLoadStatus.Error)],
      }).status
    ).toBe(CommentsPaneLoadStatus.Partial);
  });

  it("is the failed read, not a blank list, once every read has landed with one failed and nothing to show", () => {
    const empty = { ...branch, threads: [] };
    expect(
      mergeBranchComments({
        branch: empty,
        hasArtifact: true,
        scope: "sessions",
        sessionCount: 2,
        sessions: [
          session(CommentsPaneLoadStatus.Error),
          session(CommentsPaneLoadStatus.Ready),
        ],
      }).status
    ).toBe(CommentsPaneLoadStatus.Error);
    expect(
      mergeBranchComments({
        branch: empty,
        hasArtifact: true,
        scope: "sessions",
        sessionCount: 2,
        sessions: [
          session(CommentsPaneLoadStatus.Error),
          session(CommentsPaneLoadStatus.Loading),
        ],
      }).status
    ).toBe(CommentsPaneLoadStatus.Partial);
  });

  it("is an error, not an empty list, for a Branch with no artifact to address", () => {
    expect(
      mergeBranchComments({
        branch,
        hasArtifact: false,
        scope: "details",
        sessionCount: 0,
        sessions: [],
      }).status
    ).toBe(CommentsPaneLoadStatus.Error);
  });
});

const GITHUB_MARKDOWN = githubThread("gh-md", {
  artifactId: BRANCH,
  comments: [
    makeComment({
      body: "See [the guide](https://example.com/guide)\n\n```ts\nconst guarded = true;\n```",
      permissions: NO_PERMISSIONS,
      threadId: "gh-md",
    }),
  ],
});

/** Branch details as the server lists it: the native policy names the collection. */
async function renderGithubDetails() {
  const source = branchSource();
  source.list.mockImplementation(() =>
    Promise.resolve({
      artifactId: BRANCH,
      capabilities: capabilitiesFor(CommentPolicyKey.NativeBranch),
      nextCursor: null,
      threads: [GITHUB_MARKDOWN, BRANCH_DETAIL],
    })
  );
  renderPane({ activeTab: ArtifactDetailTab.Artifact }, source);
  await screen.findByText(`Body of ${BRANCH_DETAIL.id}`);
  return {
    github: threadCard(GITHUB_MARKDOWN.id),
    native: threadCard(BRANCH_DETAIL.id),
  };
}

function threadCard(id: string): HTMLElement {
  const element = globalThis.document.querySelector<HTMLElement>(
    `[data-thread-id="${id}"]`
  );
  if (!element) {
    throw new Error(`No card for ${id}`);
  }
  return element;
}

function fakeWrites(): BranchSessionComments["writes"] {
  const write = () => Promise.resolve();
  return {
    onCreateThread: write,
    onDelete: write,
    onEdit: write,
    onReopen: write,
    onReply: write,
    onResolve: write,
    onRetrySync: write,
  };
}

const PR_REPOSITORY = "closedloop-ai/closedloop-ai";
const OTHER_PR_NUMBER = 2;
const OTHER_PR_KEY = `${PR_REPOSITORY}#${OTHER_PR_NUMBER}`;
const GITHUB_OTHER_PR = githubThread("gh-other-pr", {
  artifactId: BRANCH,
  provider: {
    pullRequestNumber: OTHER_PR_NUMBER,
    repositoryFullName: PR_REPOSITORY,
  },
});

const noop = () => undefined;

/** Whether the pane renders `threadId`'s card AND marks it selected. */
function isMarked(threadId: string): boolean {
  return (
    document
      .querySelector(`[data-thread-id="${threadId}"]`)
      ?.querySelector('[aria-current="true"]') != null
  );
}

/** The Branch details read with a GitHub thread on pull request #2. */
function otherPullRequestSource() {
  const source = fakeCommentsSource();
  source.list.mockImplementation(() =>
    page(BRANCH, [GITHUB_OTHER_PR, BRANCH_DETAIL])
  );
  return source;
}

/**
 * Owns the selected pull request the way `BranchShellView` does, starting on
 * #1, so a switch the pane asks for reaches the pane's own scope.
 */
function SelectedPullRequestHost({
  onSelectPullRequest,
  source,
}: {
  onSelectPullRequest: (selection: BranchSelectedPullRequestIdentity) => void;
  source: CommentsDataSource;
}) {
  const [selectedPullRequestKey, setSelectedPullRequestKey] = useState(
    `${PR_REPOSITORY}#1`
  );
  return (
    <BranchCommentsPaneContent
      activeTab={ArtifactDetailTab.Artifact}
      addressedThreadId={GITHUB_OTHER_PR.id}
      branchArtifactId={BRANCH}
      composerTarget={null}
      dataSource={source}
      onRevealTraceAnchor={noop}
      onSelectPullRequest={(selection) => {
        onSelectPullRequest(selection);
        setSelectedPullRequestKey(
          `${selection.repositoryFullName}#${selection.pullRequestNumber}`
        );
      }}
      organizationId={ORG_ID}
      renderedSessions={{ coverageNote: null, sessionIds: [] }}
      selectedPullRequestKey={selectedPullRequestKey}
      selectTabThenReveal={noop}
    />
  );
}
