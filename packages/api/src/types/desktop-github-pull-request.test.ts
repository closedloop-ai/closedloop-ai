import { describe, expect, it } from "vitest";
import {
  DesktopGithubPullRequestApiMaxDurationSeconds,
  DesktopGithubPullRequestApiPath,
  DesktopGithubPullRequestApiTimeoutMs,
  DesktopGithubPullRequestBodyMaxLength,
  DesktopGithubPullRequestContractVersion,
  DesktopGithubPullRequestErrorCode,
  DesktopGithubPullRequestMode,
  DesktopGithubPullRequestReason,
  DesktopGithubPullRequestStage,
  DesktopGithubPullRequestStatus,
  DesktopGithubPullRequestSuccessMode,
  desktopGithubPullRequestFailureSchema,
  desktopGithubPullRequestRequestSchema,
  desktopGithubPullRequestResponseSchema,
  desktopGithubPullRequestUpdateRequestSchema,
  labelResponseFields,
} from "./desktop-github-pull-request.ts";
import { GitHubAccessDenialReason } from "./github.ts";
import { PullRequestLabelLimit } from "./pull-request-label.ts";

describe("Desktop GitHub pull request contract", () => {
  it("pins the server-backed route and mode literals", () => {
    expect(DesktopGithubPullRequestApiPath.PullRequest).toBe(
      "/desktop/github/pull-request"
    );
    expect(DesktopGithubPullRequestApiPath.LegacyGatewayPullRequest).toBe(
      "/api/gateway/git/pr"
    );
    expect(DesktopGithubPullRequestApiPath.LegacyGatewayGitUser).toBe(
      "/api/gateway/git/user"
    );
    expect(DesktopGithubPullRequestMode.Preflight).toBe("preflight");
    expect(DesktopGithubPullRequestMode.Create).toBe("create");
    expect(DesktopGithubPullRequestContractVersion).toBe(1);
    expect(DesktopGithubPullRequestApiMaxDurationSeconds).toBe(30);
    expect(DesktopGithubPullRequestApiTimeoutMs).toBe(30_000);
  });

  it("accepts the preflight request shape without create-only fields", () => {
    const parsed = desktopGithubPullRequestRequestSchema.parse({
      contractVersion: DesktopGithubPullRequestContractVersion,
      mode: DesktopGithubPullRequestMode.Preflight,
      repoFullName: "closedloop-ai/closedloop-ai",
      headRepoFullName: "daveth/closedloop-ai",
    });

    expect(parsed).toEqual({
      contractVersion: DesktopGithubPullRequestContractVersion,
      mode: DesktopGithubPullRequestMode.Preflight,
      repoFullName: "closedloop-ai/closedloop-ai",
      headRepoFullName: "daveth/closedloop-ai",
    });
  });

  it("rejects unknown request fields at the API trust boundary", () => {
    expect(
      desktopGithubPullRequestRequestSchema.safeParse({
        contractVersion: DesktopGithubPullRequestContractVersion,
        mode: DesktopGithubPullRequestMode.Preflight,
        repoFullName: "closedloop-ai/closedloop-ai",
        headBranch: "feature/no-gh-pr-create",
      }).success
    ).toBe(false);
    expect(
      desktopGithubPullRequestRequestSchema.safeParse({
        contractVersion: DesktopGithubPullRequestContractVersion,
        mode: DesktopGithubPullRequestMode.Create,
        repoFullName: "closedloop-ai/closedloop-ai",
        headBranch: "feature/no-gh-pr-create",
        title: "Retire gh",
        body: "Use server-backed PR creation",
        pushed: true,
      }).success
    ).toBe(false);
  });

  it("requires create mode to carry the title and body", () => {
    const result = desktopGithubPullRequestRequestSchema.safeParse({
      contractVersion: DesktopGithubPullRequestContractVersion,
      mode: DesktopGithubPullRequestMode.Create,
      repoFullName: "closedloop-ai/closedloop-ai",
      headBranch: "feature/no-gh-pr-create",
    });

    expect(result.success).toBe(false);
  });

  it("bounds create and update PR body length", () => {
    const oversizedBody = "x".repeat(DesktopGithubPullRequestBodyMaxLength + 1);

    expect(
      desktopGithubPullRequestRequestSchema.safeParse({
        contractVersion: DesktopGithubPullRequestContractVersion,
        mode: DesktopGithubPullRequestMode.Create,
        repoFullName: "closedloop-ai/closedloop-ai",
        headBranch: "feature/no-gh-pr-create",
        title: "Retire gh",
        body: oversizedBody,
      }).success
    ).toBe(false);
    expect(
      desktopGithubPullRequestUpdateRequestSchema.safeParse({
        contractVersion: DesktopGithubPullRequestContractVersion,
        repoFullName: "closedloop-ai/closedloop-ai",
        body: oversizedBody,
      }).success
    ).toBe(false);
  });

  it("bounds direct create and update label lists", () => {
    const tooManyLabels = labelSpecs(
      PullRequestLabelLimit.MaxLabelsPerPullRequest + 1
    );
    const maxLabels = labelSpecs(PullRequestLabelLimit.MaxLabelsPerPullRequest);

    expect(
      desktopGithubPullRequestRequestSchema.safeParse({
        contractVersion: DesktopGithubPullRequestContractVersion,
        mode: DesktopGithubPullRequestMode.Create,
        repoFullName: "closedloop-ai/closedloop-ai",
        headBranch: "feature/no-gh-pr-create",
        title: "Retire gh",
        body: "Use server-backed PR creation",
        labels: tooManyLabels,
      }).success
    ).toBe(false);
    expect(
      desktopGithubPullRequestRequestSchema.safeParse({
        contractVersion: DesktopGithubPullRequestContractVersion,
        mode: DesktopGithubPullRequestMode.Create,
        repoFullName: "closedloop-ai/closedloop-ai",
        headBranch: "feature/no-gh-pr-create",
        title: "Retire gh",
        body: "Use server-backed PR creation",
        labels: maxLabels,
      }).success
    ).toBe(true);
    expect(
      desktopGithubPullRequestUpdateRequestSchema.safeParse({
        contractVersion: DesktopGithubPullRequestContractVersion,
        repoFullName: "closedloop-ai/closedloop-ai",
        labels: tooManyLabels,
      }).success
    ).toBe(false);
  });

  it("rejects unknown contract versions and malformed repositories", () => {
    expect(
      desktopGithubPullRequestRequestSchema.safeParse({
        contractVersion: 2,
        mode: DesktopGithubPullRequestMode.Preflight,
        repoFullName: "closedloop-ai/closedloop-ai",
      }).success
    ).toBe(false);
    expect(
      desktopGithubPullRequestRequestSchema.safeParse({
        contractVersion: DesktopGithubPullRequestContractVersion,
        mode: DesktopGithubPullRequestMode.Preflight,
        repoFullName: "not-a-full-name",
      }).success
    ).toBe(false);
  });

  it("requires update requests to carry at least one change", () => {
    expect(
      desktopGithubPullRequestUpdateRequestSchema.safeParse({
        contractVersion: DesktopGithubPullRequestContractVersion,
        repoFullName: "closedloop-ai/closedloop-ai",
      }).success
    ).toBe(false);
    expect(
      desktopGithubPullRequestUpdateRequestSchema.safeParse({
        contractVersion: DesktopGithubPullRequestContractVersion,
        repoFullName: "closedloop-ai/closedloop-ai",
        title: "Updated title",
      }).success
    ).toBe(true);
    expect(
      desktopGithubPullRequestUpdateRequestSchema.safeParse({
        contractVersion: DesktopGithubPullRequestContractVersion,
        repoFullName: "closedloop-ai/closedloop-ai",
        labels: [],
      }).success
    ).toBe(false);
    expect(
      desktopGithubPullRequestUpdateRequestSchema.safeParse({
        contractVersion: DesktopGithubPullRequestContractVersion,
        repoFullName: "closedloop-ai/closedloop-ai",
        labels: [{ name: "ISS-8637", color: "0366d6" }],
      }).success
    ).toBe(true);
  });

  it("pins the API-incompatible fail-closed response fields", () => {
    const parsed = desktopGithubPullRequestFailureSchema.parse({
      success: false,
      error: "Desktop pull request API is incompatible",
      code: DesktopGithubPullRequestErrorCode.ApiIncompatible,
      reason: DesktopGithubPullRequestReason.ApiIncompatible,
      stage: DesktopGithubPullRequestStage.ApiPreflight,
      retryable: false,
      burnRetryBudget: false,
    });

    expect(parsed).toEqual({
      success: false,
      error: "Desktop pull request API is incompatible",
      code: DesktopGithubPullRequestErrorCode.ApiIncompatible,
      reason: DesktopGithubPullRequestReason.ApiIncompatible,
      stage: DesktopGithubPullRequestStage.ApiPreflight,
      retryable: false,
      burnRetryBudget: false,
    });
  });

  it("carries existing GitHub denial reasons on credential failures", () => {
    expect(
      desktopGithubPullRequestFailureSchema.safeParse({
        success: false,
        error: "GitHub authentication is required",
        code: DesktopGithubPullRequestErrorCode.AuthenticationRequired,
        reason: DesktopGithubPullRequestReason.AuthenticationRequired,
        denial: GitHubAccessDenialReason.NotConnected,
        stage: DesktopGithubPullRequestStage.ApiPreflight,
        retryable: false,
        burnRetryBudget: false,
      }).success
    ).toBe(true);
  });

  it("accepts successful PR responses with legacy label fields", () => {
    expect(
      desktopGithubPullRequestResponseSchema.safeParse({
        success: true,
        contractVersion: DesktopGithubPullRequestContractVersion,
        mode: DesktopGithubPullRequestSuccessMode.Create,
        status: DesktopGithubPullRequestStatus.Created,
        pullRequest: {
          url: "https://github.com/closedloop-ai/closedloop-ai/pull/7001",
          number: 7001,
          headBranch: "feature/no-gh-pr-create",
          baseBranch: "main",
        },
        labels: {
          appliedLabels: ["ISS-8637"],
          labelsApplied: true,
        },
      }).success
    ).toBe(true);
  });

  it("maps applied and dropped label names without serializing empty optionals", () => {
    expect(
      labelResponseFields(
        [
          { name: "ISS-8637", color: "0366d6" },
          { name: "PRD-570", color: "0e8a16" },
        ],
        [],
        ["ISS-8637"]
      )
    ).toEqual({
      labelsApplied: false,
      appliedLabels: ["ISS-8637"],
      unappliedLabels: ["PRD-570"],
    });
    expect(labelResponseFields([], [], [])).toBeUndefined();
  });
});

function labelSpecs(count: number) {
  return Array.from({ length: count }, (_value, index) => ({
    name: `label-${index}`,
    color: "0366d6",
  }));
}
