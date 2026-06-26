// @vitest-environment jsdom
import { PRReviewCommentState } from "@repo/api/src/types/branch-view";
import { FeedItemKind } from "@repo/app/documents/components/feed-sidebar/feed-item";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BranchViewProvider } from "../../branch-view-context";
import { prCommentSource } from "../pr-comment-source";
import {
  type PrCommentItem,
  type PrFilterState,
  PrFilterTab,
} from "../pr-comment-types";
import { makeBranchViewContextValue, makeComment } from "./test-utils";

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

function Probe({
  capture,
}: Readonly<{
  capture: (items: readonly PrCommentItem[]) => void;
}>) {
  const result = prCommentSource.useItems();
  capture(result.items);
  return null;
}

function renderItems(input: {
  comments: Parameters<typeof makeBranchViewContextValue>[0]["comments"];
  committedFiles?: Parameters<
    typeof makeBranchViewContextValue
  >[0]["committedFiles"];
  capture: (items: readonly PrCommentItem[]) => void;
}) {
  return render(
    <BranchViewProvider
      value={makeBranchViewContextValue({
        comments: input.comments,
        committedFiles: input.committedFiles,
      })}
    >
      <Probe capture={input.capture} />
    </BranchViewProvider>
  );
}

function makeItem(overrides: Partial<PrCommentItem>): PrCommentItem {
  const root = makeComment({});
  return {
    id: root.id,
    kind: FeedItemKind.PrComment,
    sourceId: "pr-comment",
    createdAt: new Date(root.createdAt),
    threadId: root.id,
    root,
    replies: [],
    finding: null,
    findingAnchor: null,
    commentFileTarget: null,
    ...overrides,
  } as PrCommentItem;
}

describe("prCommentSource", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("useItems", () => {
    it("emits one item per thread root with createdAt as Date", () => {
      const captured: PrCommentItem[][] = [];
      renderItems({
        capture: (items) => captured.push([...items]),
        comments: [
          makeComment({
            id: "c_a",
            githubCommentId: "11",
            createdAt: "2026-01-01T00:00:00Z",
          }),
          makeComment({
            id: "c_b",
            githubCommentId: "12",
            createdAt: "2026-01-02T00:00:00Z",
          }),
        ],
      });
      const last = captured.at(-1) ?? [];
      expect(last).toHaveLength(2);
      for (const item of last) {
        expect(item.createdAt).toBeInstanceOf(Date);
      }
    });

    it("attaches replies to their root", () => {
      const captured: PrCommentItem[][] = [];
      const root = makeComment({
        id: "root_1",
        threadId: "thread_1",
        githubCommentId: "10",
      });
      const reply = makeComment({
        id: "reply_1",
        threadId: "thread_1",
        githubCommentId: "11",
        inReplyToId: "10",
      });
      renderItems({
        capture: (items) => captured.push([...items]),
        comments: [root, reply],
      });
      const last = captured.at(-1) ?? [];
      expect(last).toHaveLength(1);
      expect(last[0]?.replies).toHaveLength(1);
    });
  });

  describe("applyFilter", () => {
    it("returns all items for the All tab", () => {
      const items = [makeItem({ id: "a" }), makeItem({ id: "b" })];
      const result = prCommentSource.applyFilter(items, {
        tab: PrFilterTab.All,
      } satisfies PrFilterState);
      expect(result).toHaveLength(2);
    });

    it("returns only pending comments for the Pending tab", () => {
      const items = [
        makeItem({
          id: "a",
          root: makeComment({
            id: "a",
            state: PRReviewCommentState.Pending,
          }),
        }),
        makeItem({
          id: "b",
          root: makeComment({
            id: "b",
            state: PRReviewCommentState.Addressed,
          }),
        }),
      ];
      const result = prCommentSource.applyFilter(items, {
        tab: PrFilterTab.Pending,
      });
      expect(result.map((i) => i.id)).toEqual(["a", "b"]);
    });

    it("returns items with parsed findings for the Findings tab", () => {
      const items = [
        makeItem({ id: "a", finding: null }),
        makeItem({
          id: "b",
          finding: {
            id: "b",
            comment: makeComment({}),
            priority: null,
            severity: "info",
            title: "x",
            suggestion: null,
            confidence: null,
            locSavings: null,
            isMetadataTruncated: false,
          } as PrCommentItem["finding"],
        }),
      ];
      const result = prCommentSource.applyFilter(items, {
        tab: PrFilterTab.Findings,
      });
      expect(result.map((i) => i.id)).toEqual(["b"]);
    });

    it("returns only resolved comments for the Resolved tab", () => {
      const items = [
        makeItem({
          id: "a",
          root: makeComment({ id: "a", state: PRReviewCommentState.Pending }),
        }),
        makeItem({
          id: "b",
          root: makeComment({
            id: "b",
            state: PRReviewCommentState.Dismissed,
          }),
        }),
        makeItem({
          id: "c",
          root: makeComment({
            id: "c",
            state: PRReviewCommentState.Pending,
            resolved: true,
          }),
        }),
      ];
      const result = prCommentSource.applyFilter(items, {
        tab: PrFilterTab.Resolved,
      });
      expect(result.map((i) => i.id)).toEqual(["c"]);
    });
  });

  describe("isFiltered", () => {
    it("returns false for the All tab", () => {
      expect(prCommentSource.isFiltered({ tab: PrFilterTab.All })).toBe(false);
    });

    it("returns true for any other tab", () => {
      expect(prCommentSource.isFiltered({ tab: PrFilterTab.Pending })).toBe(
        true
      );
      expect(prCommentSource.isFiltered({ tab: PrFilterTab.Findings })).toBe(
        true
      );
      expect(prCommentSource.isFiltered({ tab: PrFilterTab.Resolved })).toBe(
        true
      );
    });
  });
});
