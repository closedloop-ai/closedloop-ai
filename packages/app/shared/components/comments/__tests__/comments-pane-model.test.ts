import { ThreadSource, ThreadStatus } from "@repo/api/src/types/comment";
import { CommentAnchorState } from "@repo/api/src/types/comment-anchor";
import { CommentAnchorKind } from "@repo/api/src/types/comment-anchor-kind";
import { CommentSyncStatus } from "@repo/api/src/types/comment-thread-dto";
import { describe, expect, it } from "vitest";
import {
  ALL_PERMISSIONS,
  desktopSync,
  FULL_CAPABILITIES,
  githubThread,
  makeComment,
  makeThread,
  NO_PERMISSIONS,
  traceAnchor,
} from "../comments-pane.fixtures";
import {
  clampCommentsRailWidth,
  commentAffordances,
  commentsPaneCountLabel,
  commentsPaneFilters,
  isAnchorRevealable,
  isSameAnchor,
  threadAffordances,
  threadInBranchScope,
  threadMatchesFilter,
} from "../comments-pane-model";

describe("comments pane affordances", () => {
  it("needs the collection capability AND the item permission", () => {
    const thread = makeThread({ id: "t" });
    const granted = threadAffordances(FULL_CAPABILITIES, thread);
    expect(granted.resolve).toBe(true);

    expect(
      threadAffordances({ ...FULL_CAPABILITIES, resolve: false }, thread)
        .resolve
    ).toBe(false);
    expect(
      threadAffordances(
        FULL_CAPABILITIES,
        makeThread({ id: "t", permissions: NO_PERMISSIONS })
      ).resolve
    ).toBe(false);

    const comment = makeComment({ body: "b", permissions: ALL_PERMISSIONS });
    expect(commentAffordances(FULL_CAPABILITIES, comment)).toEqual({
      delete: true,
      edit: true,
    });
    expect(
      commentAffordances(FULL_CAPABILITIES, {
        ...comment,
        permissions: { ...ALL_PERMISSIONS, canEdit: false },
      }).edit
    ).toBe(false);
  });

  it("offers resolve on an open thread and reopen on a resolved one, never both", () => {
    const open = threadAffordances(FULL_CAPABILITIES, makeThread({ id: "o" }));
    const resolved = threadAffordances(
      FULL_CAPABILITIES,
      makeThread({ id: "r", status: ThreadStatus.Resolved })
    );
    expect([open.resolve, open.reopen, open.reply]).toEqual([
      true,
      false,
      true,
    ]);
    expect([resolved.resolve, resolved.reopen, resolved.reply]).toEqual([
      false,
      true,
      false,
    ]);
  });

  it("offers retry only on a failed or abandoned sync", () => {
    const retry = (state: CommentSyncStatus) =>
      threadAffordances(
        FULL_CAPABILITIES,
        makeThread({ id: "s", sync: desktopSync(state) })
      ).retrySync;
    expect(retry(CommentSyncStatus.Failed)).toBe(true);
    expect(retry(CommentSyncStatus.Abandoned)).toBe(true);
    expect(retry(CommentSyncStatus.Pending)).toBe(false);
    expect(retry(CommentSyncStatus.Synced)).toBe(false);
  });

  it("offers retry only to the author, matching the notice's author wording", () => {
    const failed = (canEdit: boolean) =>
      makeThread({
        comments: [
          makeComment({
            body: "b",
            permissions: { ...ALL_PERMISSIONS, canEdit },
            threadId: "s",
          }),
        ],
        id: "s",
        sync: desktopSync(CommentSyncStatus.Failed),
      });
    expect(threadAffordances(FULL_CAPABILITIES, failed(true)).retrySync).toBe(
      true
    );
    expect(threadAffordances(FULL_CAPABILITIES, failed(false)).retrySync).toBe(
      false
    );
  });

  it("links out only when the capability and a provider link both exist", () => {
    const thread = githubThread("gh");
    expect(threadAffordances(FULL_CAPABILITIES, thread).linkOut).toBe(
      thread.provider.linkOut
    );
    expect(
      threadAffordances({ ...FULL_CAPABILITIES, linkOut: false }, thread)
        .linkOut
    ).toBeNull();
  });
});

describe("comments pane anchors", () => {
  const trace = [CommentAnchorKind.Trace];

  it.each([
    [CommentAnchorState.Anchored, true],
    [CommentAnchorState.Moved, true],
    [CommentAnchorState.Outdated, false],
    [CommentAnchorState.Orphaned, false],
  ])("reveals a %s trace anchor: %s", (anchorState, expected) => {
    expect(
      isAnchorRevealable(makeThread({ anchorState, id: "a" }), trace)
    ).toBe(expected);
  });

  it("never reveals a kind the surface cannot show, or an artifact-wide thread", () => {
    expect(isAnchorRevealable(githubThread("gh"), trace)).toBe(false);
    expect(
      isAnchorRevealable(
        makeThread({ anchor: { kind: CommentAnchorKind.Artifact }, id: "w" }),
        [CommentAnchorKind.Artifact]
      )
    ).toBe(false);
  });
});

describe("comments pane count", () => {
  it("never shows a failed or in-flight read as zero comments", () => {
    expect(commentsPaneCountLabel({ status: "error" }, 0)).toBe("Unavailable");
    expect(commentsPaneCountLabel({ status: "loading" }, 0)).toBeNull();
    expect(commentsPaneCountLabel({ status: "partial" }, 3)).toBe("3 shown");
    expect(commentsPaneCountLabel({ status: "ready" }, 0)).toBe(0);
  });
});

describe("comments pane Branch scope", () => {
  const scope = {
    renderedSessionIds: ["session-a"],
    selectedPullRequestKey: null,
    tab: "sessions" as const,
  };

  it("keeps trace threads only from rendered Sessions", () => {
    expect(threadInBranchScope(makeThread({ id: "a" }), scope)).toBe(true);
    expect(
      threadInBranchScope(
        makeThread({
          anchor: traceAnchor("x", { sessionId: "session-b" }),
          id: "b",
        }),
        scope
      )
    ).toBe(false);
  });

  it("shows provider threads only on Details with a selected PR", () => {
    const thread = githubThread("gh");
    expect(thread.source).toBe(ThreadSource.Github);
    expect(threadInBranchScope(thread, scope)).toBe(false);
    expect(
      threadInBranchScope(thread, {
        ...scope,
        selectedPullRequestKey: "repo#1",
        tab: "details",
      })
    ).toBe(true);
    // Each condition alone is not enough.
    expect(
      threadInBranchScope(thread, {
        ...scope,
        selectedPullRequestKey: "repo#1",
      })
    ).toBe(false);
    expect(threadInBranchScope(thread, { ...scope, tab: "details" })).toBe(
      false
    );
  });

  it("keeps a provider thread to the selected PR when it names one", () => {
    const details = {
      ...scope,
      selectedPullRequestKey: "owner/repo#1",
      tab: "details" as const,
    };
    const onFirst = githubThread("gh-1", {
      provider: { pullRequestNumber: 1 },
    });
    const onEleventh = githubThread("gh-11", {
      provider: { pullRequestNumber: 11 },
    });
    const unnamed = githubThread("gh-old-server", { provider: {} });

    expect(threadInBranchScope(onFirst, details)).toBe(true);
    expect(threadInBranchScope(onEleventh, details)).toBe(false);
    expect(threadInBranchScope(unnamed, details)).toBe(true);
    expect(
      threadInBranchScope(onEleventh, {
        ...details,
        selectedPullRequestKey: "owner/repo#11",
      })
    ).toBe(true);
  });

  it("keeps a provider thread to the selected PR's repository when two share its number", () => {
    const details = {
      ...scope,
      selectedPullRequestKey: "acme/web#7",
      tab: "details" as const,
    };
    const onWeb = githubThread("gh-web", {
      provider: { pullRequestNumber: 7, repositoryFullName: "acme/web" },
    });
    const onApi = githubThread("gh-api", {
      provider: { pullRequestNumber: 7, repositoryFullName: "acme/api" },
    });
    const onWebOtherCase = githubThread("gh-web-case", {
      provider: { pullRequestNumber: 7, repositoryFullName: "Acme/Web" },
    });

    expect(threadInBranchScope(onWeb, details)).toBe(true);
    expect(threadInBranchScope(onApi, details)).toBe(false);
    expect(threadInBranchScope(onWebOtherCase, details)).toBe(true);
    const onApiSelected = { ...details, selectedPullRequestKey: "acme/api#7" };
    expect(threadInBranchScope(onWeb, onApiSelected)).toBe(false);
    expect(threadInBranchScope(onApi, onApiSelected)).toBe(true);
  });

  it("scopes a thread from a server that names only the PR number by that number", () => {
    const details = {
      ...scope,
      selectedPullRequestKey: "acme/web#7",
      tab: "details" as const,
    };

    expect(
      threadInBranchScope(
        githubThread("gh-7", { provider: { pullRequestNumber: 7 } }),
        details
      )
    ).toBe(true);
    expect(
      threadInBranchScope(
        githubThread("gh-8", { provider: { pullRequestNumber: 8 } }),
        details
      )
    ).toBe(false);
  });
});

describe("comments pane filters", () => {
  it("offers anchor-kind filters only when the source mixes kinds", () => {
    expect(
      commentsPaneFilters({
        ...FULL_CAPABILITIES,
        anchorKinds: [CommentAnchorKind.Trace],
      })
    ).toEqual(["all", "open"]);
    expect(commentsPaneFilters(FULL_CAPABILITIES)).toEqual([
      "all",
      "open",
      ...FULL_CAPABILITIES.anchorKinds,
    ]);
  });

  it("matches by status for Open and by anchor kind for a kind", () => {
    const open = makeThread({ id: "o" });
    const resolved = makeThread({ id: "r", status: ThreadStatus.Resolved });
    const wide = makeThread({
      anchor: { kind: CommentAnchorKind.Artifact },
      id: "w",
    });
    const unanchored = makeThread({ anchor: null, id: "n" });

    expect(threadMatchesFilter(resolved, "all")).toBe(true);
    expect(threadMatchesFilter(open, "open")).toBe(true);
    expect(threadMatchesFilter(resolved, "open")).toBe(false);
    expect(threadMatchesFilter(open, CommentAnchorKind.Trace)).toBe(true);
    expect(threadMatchesFilter(wide, CommentAnchorKind.Trace)).toBe(false);
    expect(threadMatchesFilter(unanchored, CommentAnchorKind.Artifact)).toBe(
      true
    );
  });
});

describe("comments pane anchor identity", () => {
  it("compares kind identity fields, not key order or display text", () => {
    const anchor = traceAnchor("x");
    const reordered = JSON.parse(
      JSON.stringify(anchor, Object.keys(anchor).reverse())
    );
    expect(isSameAnchor(anchor, reordered)).toBe(true);
    expect(isSameAnchor(anchor, { ...anchor, selectedText: "y" })).toBe(true);
    expect(isSameAnchor(anchor, { ...anchor, row: 99 })).toBe(false);
    expect(isSameAnchor(anchor, null)).toBe(false);
  });
});

describe("comments pane width", () => {
  it("clamps the rail to 280-560, and to a narrower container", () => {
    expect(clampCommentsRailWidth(100)).toBe(280);
    expect(clampCommentsRailWidth(900)).toBe(560);
    expect(clampCommentsRailWidth(400, 300)).toBe(300);
    expect(clampCommentsRailWidth(100, 200)).toBe(200);
  });
});
