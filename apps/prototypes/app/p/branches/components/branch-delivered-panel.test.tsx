// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { type BranchDetail, branchRows, PrState } from "../mock";
import { buildBranchDetail } from "../mock-detail";
import { BranchDeliveredPanel } from "./detail-panels";

const SHOW_FULL_DESCRIPTION = "Show full description";
const SHOW_LESS = "Show less";
const SELECTED_BODY = "Selected pull request body";
const FALLBACK_BODY = "Compatibility fallback body";
const OPEN_PULL_REQUEST_NAME = /Open pull request/;

describe("BranchDeliveredPanel", () => {
  it("renders one atomic selected PR identity and body", () => {
    const detail = makeDetail({
      prNumber: 11,
      prTitle: "Compatibility title",
      prUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/11",
      prState: PrState.Closed,
      prBody: FALLBACK_BODY,
      selectedPullRequest: {
        number: 22,
        title: "Selected title",
        url: "https://github.com/closedloop-ai/symphony-alpha/pull/22",
        state: PrState.Open,
        body: SELECTED_BODY,
      },
    });

    render(<BranchDeliveredPanel detail={detail} />);

    expect(screen.getByText("#22")).not.toBeNull();
    expect(screen.getByText("Selected title")).not.toBeNull();
    expect(screen.getByText(SELECTED_BODY)).not.toBeNull();
    expect(screen.queryByText("Compatibility title")).toBeNull();
    expect(screen.queryByText(FALLBACK_BODY)).toBeNull();
    expect(
      screen
        .getByRole("link", { name: "Open pull request #22" })
        .getAttribute("href")
    ).toBe("https://github.com/closedloop-ai/symphony-alpha/pull/22");
  });

  it("falls back only when the selected body is null", () => {
    const detail = makeDetail({
      prBody: FALLBACK_BODY,
      selectedPullRequest: {
        number: 22,
        title: "Selected title",
        url: null,
        state: PrState.Open,
        body: null,
      },
    });

    render(<BranchDeliveredPanel detail={detail} />);

    expect(screen.getByText(FALLBACK_BODY)).not.toBeNull();
    expect(screen.getByText("#22")).not.toBeNull();
  });

  it("does not mix compatibility metadata into a selected PR identity", () => {
    const detail = makeDetail({
      prNumber: 11,
      prTitle: "Compatibility title",
      prUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/11",
      prState: PrState.Closed,
      selectedPullRequest: {
        number: 22,
        title: null,
        url: null,
        state: null,
        body: SELECTED_BODY,
      },
    });

    render(<BranchDeliveredPanel detail={detail} />);

    expect(screen.getByText("#22")).not.toBeNull();
    expect(screen.queryByText("Compatibility title")).toBeNull();
    expect(screen.queryByText(PrState.Closed)).toBeNull();
    expect(
      screen.queryByRole("link", { name: OPEN_PULL_REQUEST_NAME })
    ).toBeNull();
  });

  it("does not leak the fallback body when the selected body is whitespace", () => {
    const detail = makeDetail({
      prBody: FALLBACK_BODY,
      selectedPullRequest: {
        number: 22,
        title: "Selected title",
        url: null,
        state: PrState.Open,
        body: "   ",
      },
    });

    render(<BranchDeliveredPanel detail={detail} />);

    expect(screen.getByText("No PR description yet.")).not.toBeNull();
    expect(screen.queryByText(FALLBACK_BODY)).toBeNull();
    expect(
      screen.queryByRole("button", { name: SHOW_FULL_DESCRIPTION })
    ).toBeNull();
  });

  it("preserves artifact placement and the collapsed disclosure contract", () => {
    const detail = makeDetail({
      deliveredArtifacts: [{ slug: "ISS-4783" }],
      prBody: FALLBACK_BODY,
      selectedPullRequest: null,
    });

    const { container } = render(<BranchDeliveredPanel detail={detail} />);
    const artifact = screen.getByText("ISS-4783");
    const pullRequest = screen.getByText("Pull request");
    const artifactContainer = artifact.closest("div.mb-2");
    const pullRequestContainer = pullRequest.closest("div.rounded-md");
    const description = screen.getByText(FALLBACK_BODY).closest("div[inert]");
    const toggle = screen.getByRole("button", {
      name: SHOW_FULL_DESCRIPTION,
    });

    expect(artifactContainer?.nextElementSibling).toBe(pullRequestContainer);
    expect(description?.classList.contains("max-h-[5.75rem]")).toBe(true);
    expect(description?.classList.contains("overflow-hidden")).toBe(true);
    expect(description?.hasAttribute("inert")).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    toggle.focus();
    fireEvent.keyDown(toggle, { key: "Enter" });
    fireEvent.click(toggle, { detail: 0 });
    fireEvent.keyUp(toggle, { key: "Enter" });

    const expandedToggle = screen.getByRole("button", { name: SHOW_LESS });
    const expandedDescription = screen
      .getByText(FALLBACK_BODY)
      .closest("div.mt-2");
    expect(expandedDescription?.hasAttribute("inert")).toBe(false);
    expect(expandedDescription?.classList.contains("max-h-[5.75rem]")).toBe(
      false
    );
    expect(expandedToggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(expandedToggle);

    fireEvent.click(expandedToggle);

    expect(
      screen
        .getByRole("button", { name: SHOW_FULL_DESCRIPTION })
        .getAttribute("aria-expanded")
    ).toBe("false");
    expect(container.querySelector("div[inert]")).not.toBeNull();
  });
});

function makeDetail(overrides: Partial<BranchDetail>): BranchDetail {
  const row = branchRows.find(({ id }) => id === "br_1284");
  if (!row) {
    throw new Error("Expected the synthetic seed branch fixture");
  }
  return { ...buildBranchDetail(row), ...overrides };
}
