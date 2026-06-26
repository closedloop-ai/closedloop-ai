// @vitest-environment jsdom
import { PRReviewCommentState } from "@repo/api/src/types/branch-view";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BranchViewProvider } from "../../branch-view-context";
import { PrFilterTab } from "../pr-comment-types";
import { PrFilterControl } from "../pr-filter-control";
import { makeBranchViewContextValue, makeComment } from "./test-utils";

describe("PrFilterControl", () => {
  it("counts resolved and pending tabs from route resolved state only", () => {
    const onChange = vi.fn();
    render(
      <BranchViewProvider
        value={makeBranchViewContextValue({
          comments: [
            makeComment({
              id: "legacy-addressed",
              githubCommentId: "1",
              state: PRReviewCommentState.Addressed,
              resolved: false,
            }),
            makeComment({
              id: "route-resolved",
              githubCommentId: "2",
              state: PRReviewCommentState.Pending,
              resolved: true,
            }),
          ],
        })}
      >
        <PrFilterControl onChange={onChange} state={{ tab: PrFilterTab.All }} />
      </BranchViewProvider>
    );

    expect(screen.getByText("All (2)")).toBeTruthy();
    expect(screen.getByText("Pending (1)")).toBeTruthy();
    expect(screen.getByText("Resolved (1)")).toBeTruthy();
  });

  it("does not expose a second visible comments sync button in the feed filter", () => {
    const refreshComments = vi.fn();
    render(
      <BranchViewProvider
        value={makeBranchViewContextValue({
          comments: [],
          syncControl: { refreshComments },
        })}
      >
        <PrFilterControl onChange={vi.fn()} state={{ tab: PrFilterTab.All }} />
      </BranchViewProvider>
    );

    expect(
      screen.queryByRole("button", { name: "Sync comments from GitHub" })
    ).not.toBeInTheDocument();
    expect(refreshComments).not.toHaveBeenCalled();
  });

  it("keeps the comments sync button hidden while a comments refresh is pending", () => {
    const refreshComments = vi.fn();
    render(
      <BranchViewProvider
        value={makeBranchViewContextValue({
          comments: [],
          syncControl: {
            isCommentsSyncPending: true,
            refreshComments,
          },
        })}
      >
        <PrFilterControl onChange={vi.fn()} state={{ tab: PrFilterTab.All }} />
      </BranchViewProvider>
    );

    expect(
      screen.queryByRole("button", { name: "Sync comments from GitHub" })
    ).not.toBeInTheDocument();
    expect(refreshComments).not.toHaveBeenCalled();
  });
});
