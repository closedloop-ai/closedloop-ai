import { TRACE_COMMENT_SELECTION_GUIDANCE } from "@repo/app/shared/components/comments/comments-pane-model";
import { screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BRANCH_COMMENTS_READ_FAILED } from "../branch-comments-model";
import { BranchCommentsWorkspace } from "../branch-comments-workspace";
import {
  makeProps,
  renderWorkspace,
  stubMatchMedia,
} from "./branch-comments-workspace.test-fixtures";

beforeEach(() => {
  stubMatchMedia(() => false);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BranchCommentsWorkspace read failure (ISS-12597)", () => {
  it("withholds creation and names the read failure when the read failed outright (ISS-12597)", () => {
    const { rerender } = renderWorkspace({
      comments: [],
      composerTarget: null,
      hasError: true,
      readFailed: true,
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      BRANCH_COMMENTS_READ_FAILED
    );
    expect(
      screen.queryByText(TRACE_COMMENT_SELECTION_GUIDANCE)
    ).not.toBeInTheDocument();

    rerender(
      <BranchCommentsWorkspace
        {...makeProps({ comments: [], hasError: true, readFailed: true })}
      />
    );
    expect(
      screen.queryByRole("textbox", { name: "Comment on line 42" })
    ).not.toBeInTheDocument();

    rerender(
      <BranchCommentsWorkspace
        {...makeProps({ comments: [], composerTarget: null })}
      />
    );
    expect(
      screen.getByText(TRACE_COMMENT_SELECTION_GUIDANCE)
    ).toBeInTheDocument();
  });

  it("withholds creation when the read failed but cached comments remain, until it recovers (ISS-12597)", () => {
    const { rerender } = renderWorkspace({ readFailed: true });
    expect(screen.getAllByText("Native root").length).toBeGreaterThan(0);
    expect(
      screen.queryByRole("textbox", { name: "Comment on line 42" })
    ).not.toBeInTheDocument();

    rerender(
      <BranchCommentsWorkspace
        {...makeProps({ composerTarget: null, readFailed: true })}
      />
    );
    expect(
      screen.queryByText(TRACE_COMMENT_SELECTION_GUIDANCE)
    ).not.toBeInTheDocument();

    rerender(<BranchCommentsWorkspace {...makeProps()} />);
    expect(
      screen.getByRole("textbox", { name: "Comment on line 42" })
    ).toBeInTheDocument();
  });

  it("keeps the composer and the existing notice on a partial read failure (ISS-12597)", () => {
    renderWorkspace({ comments: [], hasError: true });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Comments are unavailable in this view."
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent(
      BRANCH_COMMENTS_READ_FAILED
    );
    expect(
      screen.getByRole("textbox", { name: "Comment on line 42" })
    ).toBeInTheDocument();
  });
});
