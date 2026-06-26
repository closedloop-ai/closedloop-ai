import { BranchViewCommentWriteIdentityStatus } from "@repo/api/src/types/branch-view";
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  BranchViewCommentIdentityBlockerProvider,
  useBranchViewCommentIdentityBlockers,
} from "../branch-view-comment-identity-blocker-store";

describe("BranchViewCommentIdentityBlockerProvider", () => {
  it("builds canonical connect hrefs and lets local blockers override GET eligibility", () => {
    function Probe() {
      const blockers = useBranchViewCommentIdentityBlockers();
      const prompt = blockers.getCreatePrompt("createConversation", {
        prompt: true,
        identityBlocker: {
          status: BranchViewCommentWriteIdentityStatus.Expired,
        },
      });
      return (
        <>
          <output data-testid="status">
            {prompt?.identityBlocker.status ?? "none"}
          </output>
          <output data-testid="href">{prompt?.connectHref ?? ""}</output>
          <button
            onClick={() =>
              blockers.recordIdentityBlocker({
                surface: "createConversation",
                identityBlocker: {
                  status: BranchViewCommentWriteIdentityStatus.Missing,
                },
              })
            }
            type="button"
          >
            record
          </button>
        </>
      );
    }

    render(
      <BranchViewCommentIdentityBlockerProvider
        buildId="branch-artifact-1"
        orgSlug="acme"
      >
        <Probe />
      </BranchViewCommentIdentityBlockerProvider>
    );

    expect(screen.getByTestId("status")).toHaveTextContent("expired");
    expect(screen.getByTestId("href")).toHaveTextContent(
      "/api/integrations/github?returnTo=%2Facme%2Fbuild%2Fbranch-artifact-1"
    );

    act(() => screen.getByRole("button", { name: "record" }).click());

    expect(screen.getByTestId("status")).toHaveTextContent("missing");
  });

  it("starts from projected eligibility again after the connected callback remounts the provider", () => {
    function Probe() {
      const blockers = useBranchViewCommentIdentityBlockers();
      const prompt = blockers.getCreatePrompt("createConversation", {
        prompt: true,
        identityBlocker: {
          status: BranchViewCommentWriteIdentityStatus.Expired,
        },
      });
      return (
        <>
          <output data-testid="status">
            {prompt?.identityBlocker.status ?? "none"}
          </output>
          <button
            onClick={() =>
              blockers.recordIdentityBlocker({
                surface: "createConversation",
                identityBlocker: {
                  status: BranchViewCommentWriteIdentityStatus.Missing,
                },
              })
            }
            type="button"
          >
            record
          </button>
        </>
      );
    }

    const { unmount } = render(
      <BranchViewCommentIdentityBlockerProvider
        buildId="branch-artifact-1"
        orgSlug="acme"
      >
        <Probe />
      </BranchViewCommentIdentityBlockerProvider>
    );
    act(() => screen.getByRole("button", { name: "record" }).click());
    expect(screen.getByTestId("status")).toHaveTextContent("missing");

    unmount();
    globalThis.history.pushState(
      null,
      "",
      "/acme/build/branch-artifact-1?github=connected"
    );
    render(
      <BranchViewCommentIdentityBlockerProvider
        buildId="branch-artifact-1"
        orgSlug="acme"
      >
        <Probe />
      </BranchViewCommentIdentityBlockerProvider>
    );

    expect(screen.getByTestId("status")).toHaveTextContent("expired");
  });
});
