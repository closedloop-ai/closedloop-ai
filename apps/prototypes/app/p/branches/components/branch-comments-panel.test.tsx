// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  type PrComment,
  PrCommentProviderKind,
  PrCommentsState,
} from "../mock";
import { BranchCommentsPanel } from "./branch-comments-panel";

const REVIEW_COMMENT_METADATA = /Review comment · Unresolved/;
const REVIEW_REPLY_METADATA = /Review reply · Resolved/;
const GITHUB_LINK_NAME = /on GitHub/;
const REPLY_ACTION_NAME = /reply/i;

describe("BranchCommentsPanel provider evidence", () => {
  it("renders synchronized root, reply, and simultaneous bounded states read-only", () => {
    render(
      <BranchCommentsPanel
        availability={{
          bodyTruncatedCount: 2,
          mixedProjection: true,
          omittedComments: 3,
          providerTruncated: true,
          responseTruncated: true,
          stale: true,
          state: PrCommentsState.StaleMixed,
        }}
        comments={[providerRoot()]}
        emptyDescription="No provider comments"
        placeholder="Unavailable"
        readOnly
        title="PR comments"
      />
    );

    expect(screen.getByText("Root Reviewer · @root-reviewer")).toBeTruthy();
    expect(screen.getByText("@reply-reviewer")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "PR comments 2 shown" })
    ).toBeTruthy();
    expect(screen.getByRole("complementary").className).toContain(
      "max-lg:fixed"
    );
    expect(screen.getByText(REVIEW_COMMENT_METADATA)).toBeTruthy();
    expect(screen.getByText(REVIEW_REPLY_METADATA)).toBeTruthy();
    expect(screen.getAllByText("Stale · Body truncated")).toHaveLength(2);
    expect(
      screen.getAllByRole("link", { name: GITHUB_LINK_NAME })
    ).toHaveLength(2);
    expect(screen.getByText("GitHub comments may be stale.")).toBeTruthy();
    expect(
      screen.getByText(
        "3 GitHub comments are omitted from this bounded result."
      )
    ).toBeTruthy();
    expect(
      screen.getByText("2 GitHub comment bodies are shortened.")
    ).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(
      screen.queryByRole("button", { name: REPLY_ACTION_NAME })
    ).toBeNull();
  });

  it("renders the neutral over-limit disclosure without a cap source", () => {
    render(
      <BranchCommentsPanel
        availability={{
          bodyTruncatedCount: 0,
          mixedProjection: false,
          omittedComments: 0,
          providerTruncated: false,
          responseTruncated: false,
          stale: false,
          state: PrCommentsState.OverLimitTruncated,
        }}
        comments={[]}
        emptyDescription="No provider comments"
        placeholder="Unavailable"
        readOnly
        title="PR comments"
      />
    );

    expect(
      screen.getByText("Provider comment coverage is truncated.")
    ).toBeTruthy();
  });
});

function providerRoot(): PrComment {
  return {
    at: "1h ago",
    author: "Root Reviewer",
    body: "Root body",
    id: "root-1",
    provider: {
      bodyTruncated: true,
      kind: PrCommentProviderKind.Review,
      line: 42,
      login: "root-reviewer",
      path: "packages/app/root.tsx",
      providerUrl:
        "https://github.com/closedloop-ai/symphony-alpha/pull/42#discussion_r1",
      resolved: false,
      stale: true,
    },
    replies: [
      {
        at: "55m ago",
        author: "reply-reviewer",
        body: "Reply body",
        id: "reply-1",
        provider: {
          bodyTruncated: true,
          kind: PrCommentProviderKind.ReviewReply,
          line: 43,
          login: "reply-reviewer",
          path: "packages/app/root.tsx",
          providerUrl:
            "https://github.com/closedloop-ai/symphony-alpha/pull/42#discussion_r2",
          resolved: true,
          stale: true,
        },
      },
    ],
  };
}
