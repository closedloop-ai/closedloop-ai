import {
  BranchCommentsFailureReason,
  BranchCommentsState,
  BranchPrCommentKind,
  type BranchPrCommentsResponse,
} from "@repo/api/src/types/branch";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PrCommentsPanel } from "../pr-comments-panel";

const WRITE_AFFORDANCE_TEXT_REGEX = /reply|resolve|edit|delete/i;
const RAW_MARKDOWN_HEADING_REGEX = /## Code Review Summary/;
const HELLO_TEXT_REGEX = /Hello/;
const DISPLAY_BUDGET_REGEX = /truncated to the display budget/i;
const SCREENSHOT_LINK_REGEX = /screenshot/;
const PRIORITY_COMMENT_REGEX = /P1 Badge Move private service internals/;

describe("PrCommentsPanel", () => {
  it.each([
    [
      BranchCommentsState.UnsyncedUnknown,
      "Comments not synced",
      "No synced comment projection or current provider proof is available yet.",
    ],
    [
      BranchCommentsState.ProviderError,
      "Comment provider unavailable",
      "GitHub rate-limited the comments read. Refresh later to retry.",
    ],
    [
      BranchCommentsState.SyncedEmpty,
      "No PR comments",
      "GitHub was checked for this request and returned no comments.",
    ],
    [
      BranchCommentsState.StaleMixed,
      "Comments may be stale",
      "Existing projection rows include legacy freshness evidence, so they are shown conservatively.",
    ],
    [
      BranchCommentsState.OverLimitTruncated,
      "Comment display is truncated",
      "The response exceeded the display budget and was reduced before rendering.",
    ],
    [
      BranchCommentsState.ForbiddenMismatch,
      "Branch and PR do not match",
      "The requested pull request identity does not belong to this branch.",
    ],
  ])("renders %s state copy", (state, title, description) => {
    render(
      <PrCommentsPanel
        comments={makeCommentsResponse({
          state,
          failureReason:
            state === BranchCommentsState.ProviderError
              ? BranchCommentsFailureReason.RateLimit
              : undefined,
        })}
        isError={false}
        isLoading={false}
      />
    );

    expect(screen.getByText(title)).toBeInTheDocument();
    expect(screen.getByText(description)).toBeInTheDocument();
  });

  it("renders populated comments without write affordance text", () => {
    render(
      <PrCommentsPanel
        comments={makeCommentsResponse({
          state: BranchCommentsState.Populated,
          comments: [
            {
              id: "comment-1",
              providerNodeId: "IC_1",
              providerCommentId: "101",
              kind: BranchPrCommentKind.Issue,
              threadId: null,
              inReplyToId: null,
              path: null,
              line: null,
              resolved: null,
              author: {
                login: "reviewer",
                displayName: null,
                avatarUrl: null,
                profileUrl: null,
              },
              body: "Looks good",
              createdAt: "2026-07-03T12:00:00.000Z",
              updatedAt: "2026-07-03T12:00:00.000Z",
              providerUrl:
                "https://github.com/octo/repo/pull/42#issuecomment-101",
              stale: false,
              bodyTruncated: false,
            },
          ],
        })}
        isError={false}
        isLoading={false}
      />
    );

    expect(screen.getByText("Looks good")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(
      screen.queryByText(WRITE_AFFORDANCE_TEXT_REGEX)
    ).not.toBeInTheDocument();
  });

  it("renders a markdown comment body as formatted HTML", () => {
    render(
      <PrCommentsPanel
        comments={makeCommentsResponse({
          state: BranchCommentsState.Populated,
          comments: [
            makeComment({
              body: [
                "## Code Review Summary",
                "",
                "**Status:** Approved",
                "",
                "- first finding",
                "- second finding",
                "",
                "See [the PR](https://github.com/octo/repo/pull/42) and `inlineCode`.",
              ].join("\n"),
            }),
          ],
        })}
        isError={false}
        isLoading={false}
      />
    );

    // Heading rendered as a real heading element, not literal "## " text.
    // Demoted below the panel's own h2 so a comment heading never ties with
    // the "Pull request comments" section title.
    const heading = screen.getByRole("heading", {
      name: "Code Review Summary",
    });
    expect(heading.tagName).toBe("H4");

    // Bold rendered as <strong>, not literal asterisks.
    const strong = screen.getByText("Status:");
    expect(strong.tagName).toBe("STRONG");

    // List rendered as list items.
    expect(screen.getAllByRole("listitem")).toHaveLength(2);

    // Link rendered as an anchor.
    const link = screen.getByRole("link", { name: "the PR" });
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/octo/repo/pull/42"
    );

    // Inline code rendered as <code>.
    const code = screen.getByText("inlineCode");
    expect(code.tagName).toBe("CODE");

    // Raw markdown source must NOT appear verbatim.
    expect(
      screen.queryByText(RAW_MARKDOWN_HEADING_REGEX)
    ).not.toBeInTheDocument();
  });

  it("renders a GitHub-flavored markdown table from a comment body", () => {
    render(
      <PrCommentsPanel
        comments={makeCommentsResponse({
          state: BranchCommentsState.Populated,
          comments: [
            makeComment({
              body: [
                "| Severity | Count |",
                "| -------- | ----- |",
                "| High     | 2     |",
              ].join("\n"),
            }),
          ],
        })}
        isError={false}
        isLoading={false}
      />
    );

    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "Severity" })
    ).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "High" })).toBeInTheDocument();
  });

  it("removes GitHub subscript and superscript wrappers without losing their text", () => {
    const { container } = render(
      <PrCommentsPanel
        comments={makeCommentsResponse({
          state: BranchCommentsState.Populated,
          comments: [
            makeComment({
              body: [
                "<sub><sub>P1 Badge</sub></sub> Move private service internals",
                "<sup>beta</sup>",
              ].join("\n"),
            }),
          ],
        })}
        isError={false}
        isLoading={false}
      />
    );

    expect(screen.getByText(PRIORITY_COMMENT_REGEX)).toBeInTheDocument();
    expect(container).toHaveTextContent("beta");
    expect(container).not.toHaveTextContent("<sub>");
    expect(container).not.toHaveTextContent("</sub>");
    expect(container).not.toHaveTextContent("<sup>");
    expect(container).not.toHaveTextContent("</sup>");
    expect(container.querySelector("sub")).toBeNull();
    expect(container.querySelector("sup")).toBeNull();
  });

  it("preserves subscript wrapper spellings inside inline code", () => {
    render(
      <PrCommentsPanel
        comments={makeCommentsResponse({
          state: BranchCommentsState.Populated,
          comments: [
            makeComment({
              body: "`<sub>literal</sub>` and `<sup>literal</sup>`",
            }),
          ],
        })}
        isError={false}
        isLoading={false}
      />
    );

    expect(screen.getByText("<sub>literal</sub>").tagName).toBe("CODE");
    expect(screen.getByText("<sup>literal</sup>").tagName).toBe("CODE");
  });

  it("keeps near-match wrapper HTML visible and inert", () => {
    const { container } = render(
      <PrCommentsPanel
        comments={makeCommentsResponse({
          state: BranchCommentsState.Populated,
          comments: [
            makeComment({
              body: '<sub class="priority">P1</sub> and <SUB>P2</SUB>',
            }),
          ],
        })}
        isError={false}
        isLoading={false}
      />
    );

    expect(container).toHaveTextContent('<sub class="priority">P1');
    expect(container).toHaveTextContent("<SUB>P2</SUB>");
    expect(container.querySelector("sub")).toBeNull();
  });

  it("preserves superscript wrapper spellings inside fenced code", () => {
    const { container } = render(
      <PrCommentsPanel
        comments={makeCommentsResponse({
          state: BranchCommentsState.Populated,
          comments: [
            makeComment({
              body: ["```html", "<sup>fenced</sup>", "```"].join("\n"),
            }),
          ],
        })}
        isError={false}
        isLoading={false}
      />
    );

    const code = container.querySelector("code");
    expect(code).not.toBeNull();
    expect(code).toHaveTextContent("<sup>fenced</sup>");
  });

  it("does not execute or inject raw HTML embedded in a comment body", () => {
    render(
      <PrCommentsPanel
        comments={makeCommentsResponse({
          state: BranchCommentsState.Populated,
          comments: [
            makeComment({
              body: '<img src=x onerror="alert(1)"><script>alert(2)</script>Hello',
            }),
          ],
        })}
        isError={false}
        isLoading={false}
      />
    );

    // No raw <img>/<script> nodes are injected — react-markdown does not
    // render raw HTML (no rehype-raw), so external content is safe.
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
    // The surrounding text still renders.
    expect(screen.getByText(HELLO_TEXT_REGEX)).toBeInTheDocument();
  });

  it("renders a markdown image as an external link, never an img tag", () => {
    render(
      <PrCommentsPanel
        comments={makeCommentsResponse({
          state: BranchCommentsState.Populated,
          comments: [
            makeComment({
              body: "![screenshot](https://evil.example.com/track.png)",
            }),
          ],
        })}
        isError={false}
        isLoading={false}
      />
    );

    // The author-controlled host is never fetched: no <img> is emitted.
    expect(document.querySelector("img")).toBeNull();
    // The image renders as an explicit external link instead.
    const link = screen.getByRole("link", { name: SCREENSHOT_LINK_REGEX });
    expect(link).toHaveAttribute("href", "https://evil.example.com/track.png");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer noopener");
  });

  it("opens rendered comment links in an external target", () => {
    render(
      <PrCommentsPanel
        comments={makeCommentsResponse({
          state: BranchCommentsState.Populated,
          comments: [
            makeComment({
              body: "See [the PR](https://github.com/octo/repo/pull/42).",
            }),
          ],
        })}
        isError={false}
        isLoading={false}
      />
    );

    // Electron cancels in-renderer navigation, so links must open externally.
    const link = screen.getByRole("link", { name: "the PR" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer noopener");
  });

  it("renders single newlines as line breaks", () => {
    render(
      <PrCommentsPanel
        comments={makeCommentsResponse({
          state: BranchCommentsState.Populated,
          comments: [
            makeComment({
              body: ["line one", "line two", "line three"].join("\n"),
            }),
          ],
        })}
        isError={false}
        isLoading={false}
      />
    );

    // remark-breaks turns each soft newline into a <br>, matching GitHub.
    expect(document.querySelectorAll("br").length).toBeGreaterThanOrEqual(2);
  });

  it("links truncated comments to the full comment on GitHub", () => {
    render(
      <PrCommentsPanel
        comments={makeCommentsResponse({
          state: BranchCommentsState.OverLimitTruncated,
          comments: [
            makeComment({
              body: "## Summary\n\ntruncated body",
              bodyTruncated: true,
              providerUrl:
                "https://github.com/octo/repo/pull/42#issuecomment-101",
            }),
          ],
        })}
        isError={false}
        isLoading={false}
      />
    );

    const link = screen.getByRole("link", {
      name: "Read the full comment on GitHub.",
    });
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/octo/repo/pull/42#issuecomment-101"
    );
    // Engineer "display budget" copy is gone.
    expect(screen.queryByText(DISPLAY_BUDGET_REGEX)).not.toBeInTheDocument();
  });

  it("renders a stale badge for stale comments", () => {
    render(
      <PrCommentsPanel
        comments={makeCommentsResponse({
          state: BranchCommentsState.StaleMixed,
          comments: [
            {
              id: "comment-1",
              providerNodeId: "IC_1",
              providerCommentId: "101",
              kind: BranchPrCommentKind.Issue,
              threadId: null,
              inReplyToId: null,
              path: null,
              line: null,
              resolved: null,
              author: {
                login: "reviewer",
                displayName: null,
                avatarUrl: null,
                profileUrl: null,
              },
              body: "Looks good",
              createdAt: "2026-07-03T12:00:00.000Z",
              updatedAt: "2026-07-03T12:00:00.000Z",
              providerUrl:
                "https://github.com/octo/repo/pull/42#issuecomment-101",
              stale: true,
              bodyTruncated: false,
            },
          ],
        })}
        isError={false}
        isLoading={false}
      />
    );

    expect(screen.getByText("stale")).toBeInTheDocument();
  });
});

function makeComment(
  overrides: Partial<BranchPrCommentsResponse["comments"][number]> = {}
): BranchPrCommentsResponse["comments"][number] {
  return {
    id: "comment-1",
    providerNodeId: "IC_1",
    providerCommentId: "101",
    kind: BranchPrCommentKind.Issue,
    threadId: null,
    inReplyToId: null,
    path: null,
    line: null,
    resolved: null,
    author: {
      login: "reviewer",
      displayName: null,
      avatarUrl: null,
      profileUrl: null,
    },
    body: "Looks good",
    createdAt: "2026-07-03T12:00:00.000Z",
    updatedAt: "2026-07-03T12:00:00.000Z",
    providerUrl: "https://github.com/octo/repo/pull/42#issuecomment-101",
    stale: false,
    bodyTruncated: false,
    ...overrides,
  };
}

function makeCommentsResponse(
  overrides: Partial<BranchPrCommentsResponse> = {}
): BranchPrCommentsResponse {
  return {
    branchId: "branch-1",
    state: BranchCommentsState.UnsyncedUnknown,
    comments: [],
    budget: {
      maxComments: 100,
      pageSize: 50,
      maxBodyBytes: 16 * 1024,
      maxResponseBytes: 512 * 1024,
      providerTruncated: false,
      responseTruncated: false,
      omittedComments: 0,
      bodyTruncatedCount: 0,
    },
    providerProofedAt: null,
    stale: false,
    mixedProjection: false,
    prNumber: 42,
    prUrl: "https://github.com/octo/repo/pull/42",
    ...overrides,
  };
}
