// @vitest-environment jsdom
import { BranchViewCommentWriteIdentityStatus } from "@repo/api/src/types/branch-view";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { BranchCommentWriteIdentityPrompt } from "../branch-comment-write-identity-prompt";
import { BranchViewCommentIdentityBlockerProvider } from "../branch-view-comment-identity-blocker-store";

const CONNECT_GITHUB_LINK_NAME = /Connect GitHub/u;
const CONNECTING_LINK_NAME = /Connecting\.\.\./u;

vi.mock("next/link", () => ({
  default: () => {
    throw new Error("GitHub OAuth CTA must use a browser-managed anchor");
  },
}));

function renderWithIdentityPromptProvider(children: ReactNode) {
  return render(
    <BranchViewCommentIdentityBlockerProvider
      buildId="branch-artifact-1"
      orgSlug="acme"
    >
      {children}
    </BranchViewCommentIdentityBlockerProvider>
  );
}

describe("BranchCommentWriteIdentityPrompt", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("renders the GitHub OAuth CTA as a browser-managed anchor", () => {
    renderWithIdentityPromptProvider(
      <BranchCommentWriteIdentityPrompt
        prompt={{
          connectHref:
            "/api/integrations/github?returnTo=%2Facme%2Fbuild%2Fbranch-artifact-1",
          identityBlocker: {
            status: BranchViewCommentWriteIdentityStatus.Missing,
          },
        }}
      />
    );

    expect(
      screen.getByRole("link", { name: CONNECT_GITHUB_LINK_NAME })
    ).toHaveAttribute(
      "href",
      "/api/integrations/github?returnTo=%2Facme%2Fbuild%2Fbranch-artifact-1"
    );
  });

  test("marks only the clicked GitHub OAuth CTA as connecting", () => {
    vi.useFakeTimers();
    renderWithIdentityPromptProvider(
      <>
        <BranchCommentWriteIdentityPrompt
          prompt={{
            connectHref:
              "/api/integrations/github?returnTo=%2Facme%2Fbuild%2Fbranch-artifact-1",
            identityBlocker: {
              status: BranchViewCommentWriteIdentityStatus.Missing,
            },
          }}
        />
        <BranchCommentWriteIdentityPrompt
          prompt={{
            connectHref:
              "/api/integrations/github?returnTo=%2Facme%2Fbuild%2Fbranch-artifact-2",
            identityBlocker: {
              status: BranchViewCommentWriteIdentityStatus.Missing,
            },
          }}
        />
      </>
    );

    const [clickedLink, untouchedLink] = screen.getAllByRole("link", {
      name: CONNECT_GITHUB_LINK_NAME,
    });
    clickedLink.addEventListener("click", (event) => event.preventDefault());

    fireEvent.click(clickedLink);

    expect(
      screen.getByRole("link", { name: CONNECTING_LINK_NAME })
    ).toHaveAttribute("aria-busy", "true");
    expect(untouchedLink).toHaveTextContent("Connect GitHub");
    expect(untouchedLink).toHaveAttribute("aria-busy", "false");
    expect(untouchedLink).toHaveAttribute("aria-disabled", "true");
    expect(fireEvent.click(untouchedLink)).toBe(false);

    act(() => vi.advanceTimersByTime(15_000));

    expect(
      screen.queryByRole("link", { name: CONNECTING_LINK_NAME })
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("link", { name: CONNECT_GITHUB_LINK_NAME })
    ).toHaveLength(2);
  });
});
