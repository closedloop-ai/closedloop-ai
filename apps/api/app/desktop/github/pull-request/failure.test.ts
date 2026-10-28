/**
 * `credentialFailure` and `providerFailure` translate a GitHub credential
 * denial or a thrown provider error into the wire-shaped
 * `DesktopGithubPullRequestServiceFailure` the desktop client renders. No
 * existing test covered this file; these pin every reason/stage/status
 * combination the two functions branch on.
 */
import {
  DesktopGithubPullRequestErrorCode,
  DesktopGithubPullRequestReason,
  DesktopGithubPullRequestStage,
} from "@repo/api/src/types/desktop-github-pull-request";
import { GitHubAccessDenialReason } from "@repo/api/src/types/github";
import { describe, expect, it } from "vitest";
import { credentialFailure, providerFailure } from "./failure";

const NOW = new Date("2024-01-01T00:00:00.000Z");

describe("credentialFailure", () => {
  it("maps NotConnected to a non-retryable 401 authentication failure", () => {
    const result = credentialFailure(
      GitHubAccessDenialReason.NotConnected,
      DesktopGithubPullRequestStage.GitPush
    );

    expect(result).toEqual({
      success: false,
      error:
        "GitHub authentication is required for this pull request operation.",
      code: DesktopGithubPullRequestErrorCode.AuthenticationRequired,
      reason: DesktopGithubPullRequestReason.AuthenticationRequired,
      stage: DesktopGithubPullRequestStage.GitPush,
      retryable: false,
      burnRetryBudget: false,
      status: 401,
      denial: GitHubAccessDenialReason.NotConnected,
    });
  });

  it("maps Revoked to the same 401 authentication failure, defaulting the stage", () => {
    const result = credentialFailure(GitHubAccessDenialReason.Revoked);

    expect(result).toEqual({
      success: false,
      error:
        "GitHub authentication is required for this pull request operation.",
      code: DesktopGithubPullRequestErrorCode.AuthenticationRequired,
      reason: DesktopGithubPullRequestReason.AuthenticationRequired,
      stage: DesktopGithubPullRequestStage.ApiPreflight,
      retryable: false,
      burnRetryBudget: false,
      status: 401,
      denial: GitHubAccessDenialReason.Revoked,
    });
  });

  it("maps InsufficientScope to a non-retryable 403 authorization failure", () => {
    const result = credentialFailure(
      GitHubAccessDenialReason.InsufficientScope,
      DesktopGithubPullRequestStage.ApiCreate
    );

    expect(result).toEqual({
      success: false,
      error: "GitHub authorization does not allow this pull request operation.",
      code: DesktopGithubPullRequestErrorCode.AuthorizationDenied,
      reason: DesktopGithubPullRequestReason.AuthorizationDenied,
      stage: DesktopGithubPullRequestStage.ApiCreate,
      retryable: false,
      burnRetryBudget: false,
      status: 403,
      denial: GitHubAccessDenialReason.InsufficientScope,
    });
  });

  it("maps OrgRestricted to the same 403 authorization failure", () => {
    const result = credentialFailure(GitHubAccessDenialReason.OrgRestricted);

    expect(result.status).toBe(403);
    expect(result.code).toBe(
      DesktopGithubPullRequestErrorCode.AuthorizationDenied
    );
    expect(result.denial).toBe(GitHubAccessDenialReason.OrgRestricted);
  });

  it("maps NoInstallation to the same 403 authorization failure", () => {
    const result = credentialFailure(GitHubAccessDenialReason.NoInstallation);

    expect(result.status).toBe(403);
    expect(result.code).toBe(
      DesktopGithubPullRequestErrorCode.AuthorizationDenied
    );
    expect(result.denial).toBe(GitHubAccessDenialReason.NoInstallation);
  });

  it("maps RateLimited to a retryable 429 provider-rate-limited failure", () => {
    const result = credentialFailure(GitHubAccessDenialReason.RateLimited);

    expect(result).toEqual({
      success: false,
      error: "GitHub is rate limited for pull request creation.",
      code: DesktopGithubPullRequestErrorCode.ProviderRateLimited,
      reason: DesktopGithubPullRequestReason.ProviderRateLimited,
      stage: DesktopGithubPullRequestStage.ApiPreflight,
      retryable: true,
      burnRetryBudget: false,
      status: 429,
      denial: GitHubAccessDenialReason.RateLimited,
    });
  });

  it("falls back to a retryable 503 transient failure for every other denial reason", () => {
    // Covers the implicit else of all three denial checks at once: Unavailable
    // matches none of NotConnected/Revoked, InsufficientScope/OrgRestricted/
    // NoInstallation, or RateLimited.
    const result = credentialFailure(GitHubAccessDenialReason.Unavailable);

    expect(result).toEqual({
      success: false,
      error: "GitHub credentials are temporarily unavailable.",
      code: DesktopGithubPullRequestErrorCode.TransientUnavailable,
      reason: DesktopGithubPullRequestReason.TransientUnavailable,
      stage: DesktopGithubPullRequestStage.ApiPreflight,
      retryable: true,
      burnRetryBudget: false,
      status: 503,
      denial: GitHubAccessDenialReason.Unavailable,
    });
  });
});

describe("providerFailure", () => {
  it("maps a 401 status to a non-retryable authentication failure", () => {
    const result = providerFailure(
      { status: 401 },
      DesktopGithubPullRequestStage.Provider,
      NOW
    );

    expect(result).toEqual({
      success: false,
      error: "GitHub rejected the authenticated user token.",
      code: DesktopGithubPullRequestErrorCode.AuthenticationRequired,
      reason: DesktopGithubPullRequestReason.AuthenticationRequired,
      stage: DesktopGithubPullRequestStage.Provider,
      retryable: false,
      burnRetryBudget: false,
      status: 401,
    });
    // `toEqual` alone treats a `denial: undefined` / `retryAfterSeconds:
    // undefined` own property as equal to the key being absent, so it cannot
    // tell "the optional-field spread was skipped" apart from "the spread ran
    // and produced undefined". `providerFailure` never passes either field to
    // `serviceFailure`, so both keys must be genuinely absent, not merely
    // undefined-valued.
    expect(result).not.toHaveProperty("denial");
    expect(result).not.toHaveProperty("retryAfterSeconds");
  });

  it("maps a 404 at the update stage to pull-request-unavailable, not repository-unavailable", () => {
    const result = providerFailure(
      { status: 404 },
      DesktopGithubPullRequestStage.ApiUpdate,
      NOW
    );

    expect(result).toEqual({
      success: false,
      error: "GitHub pull request is unavailable to the authenticated user.",
      code: DesktopGithubPullRequestErrorCode.PullRequestUnavailable,
      reason: DesktopGithubPullRequestReason.PullRequestUnavailable,
      stage: DesktopGithubPullRequestStage.ApiUpdate,
      retryable: false,
      burnRetryBudget: false,
      status: 404,
    });
  });

  it("maps a 404 at any other stage to repository-unavailable", () => {
    const result = providerFailure(
      { status: 404 },
      DesktopGithubPullRequestStage.ApiCreate,
      NOW
    );

    expect(result).toEqual({
      success: false,
      error: "GitHub repository is unavailable to the authenticated user.",
      code: DesktopGithubPullRequestErrorCode.RepositoryUnavailable,
      reason: DesktopGithubPullRequestReason.RepositoryUnavailable,
      stage: DesktopGithubPullRequestStage.ApiCreate,
      retryable: false,
      burnRetryBudget: false,
      status: 404,
    });
  });

  it("maps a 409 at the create stage to pull-request-already-exists", () => {
    const result = providerFailure(
      { status: 409 },
      DesktopGithubPullRequestStage.ApiCreate,
      NOW
    );

    expect(result).toEqual({
      success: false,
      error:
        "GitHub reported an existing or ambiguous pull request for this branch.",
      code: DesktopGithubPullRequestErrorCode.PullRequestAlreadyExists,
      reason: DesktopGithubPullRequestReason.PullRequestAlreadyExists,
      stage: DesktopGithubPullRequestStage.ApiCreate,
      retryable: false,
      burnRetryBudget: false,
      status: 409,
    });
  });

  it("maps a 409 at any other stage to a generic provider-rejected failure", () => {
    const result = providerFailure(
      { status: 409 },
      DesktopGithubPullRequestStage.ApiUpdate,
      NOW
    );

    expect(result).toEqual({
      success: false,
      error: "GitHub returned ambiguous pull request state.",
      code: DesktopGithubPullRequestErrorCode.ProviderRejected,
      reason: DesktopGithubPullRequestReason.ProviderRejected,
      stage: DesktopGithubPullRequestStage.ApiUpdate,
      retryable: false,
      burnRetryBudget: false,
      status: 409,
    });
  });

  it("maps a 422 at the create stage with a usable provider message to pull-request-already-exists", () => {
    // pins current behavior; looks odd because a 422 is reported to the
    // caller as HTTP 409 — this branch treats "unprocessable" as the same
    // ambiguous-conflict signal as an actual 409 on pull request creation.
    const result = providerFailure(
      {
        status: 422,
        response: { data: { message: "A pull request already exists" } },
      },
      DesktopGithubPullRequestStage.ApiCreate,
      NOW
    );

    expect(result).toEqual({
      success: false,
      error:
        "GitHub rejected pull request creation: A pull request already exists",
      code: DesktopGithubPullRequestErrorCode.PullRequestAlreadyExists,
      reason: DesktopGithubPullRequestReason.PullRequestAlreadyExists,
      stage: DesktopGithubPullRequestStage.ApiCreate,
      retryable: false,
      burnRetryBudget: false,
      status: 409,
    });
  });

  it("maps a 422 at any other stage with a usable provider message to a message-carrying provider-rejected failure", () => {
    const result = providerFailure(
      {
        status: 422,
        response: { data: { message: "Validation failed: title too long" } },
      },
      DesktopGithubPullRequestStage.ApiUpdate,
      NOW
    );

    expect(result).toEqual({
      success: false,
      error:
        "GitHub rejected the pull request request: Validation failed: title too long",
      code: DesktopGithubPullRequestErrorCode.ProviderRejected,
      reason: DesktopGithubPullRequestReason.ProviderRejected,
      stage: DesktopGithubPullRequestStage.ApiUpdate,
      retryable: false,
      burnRetryBudget: false,
      status: 409,
    });
  });

  it("falls back to the default rejection message when the provider payload does not match the expected error shape", () => {
    const result = providerFailure(
      // `response` is not an object, so the outer provider-error schema fails
      // to parse and no message can be extracted from it.
      { status: 422, response: "not-an-object" },
      DesktopGithubPullRequestStage.ApiUpdate,
      NOW
    );

    expect(result).toEqual({
      success: false,
      error: "GitHub rejected the pull request request.",
      code: DesktopGithubPullRequestErrorCode.ProviderRejected,
      reason: DesktopGithubPullRequestReason.ProviderRejected,
      stage: DesktopGithubPullRequestStage.ApiUpdate,
      retryable: false,
      burnRetryBudget: false,
      status: 409,
    });
  });

  it("falls back to the default already-exists message when the provider payload carries no errors or message", () => {
    const result = providerFailure(
      { status: 422, response: { data: {} } },
      DesktopGithubPullRequestStage.ApiCreate,
      NOW
    );

    expect(result).toEqual({
      success: false,
      error:
        "GitHub reported that this pull request already exists or cannot be created from the pushed branch.",
      code: DesktopGithubPullRequestErrorCode.PullRequestAlreadyExists,
      reason: DesktopGithubPullRequestReason.PullRequestAlreadyExists,
      stage: DesktopGithubPullRequestStage.ApiCreate,
      retryable: false,
      burnRetryBudget: false,
      status: 409,
    });
  });

  it("treats a whitespace-only provider message as absent and falls back to the default rejection message", () => {
    // pins current behavior: `sanitizeProviderText` is not exported, and its
    // only caller only ever branches on the TRUTHINESS of its return value
    // (`if (sanitized) { return sanitized; }`), never on whether that value is
    // `null` versus `""`. A whitespace-only message sanitizes to `""` either
    // way it is produced, so there is no test reachable through the exported
    // functions that can tell "returned null early" apart from "fell through
    // and returned the empty string" for this input — both are falsy and both
    // fall back to the same default message.
    const result = providerFailure(
      { status: 422, response: { data: { message: "   " } } },
      DesktopGithubPullRequestStage.ApiUpdate,
      NOW
    );

    expect(result.error).toBe("GitHub rejected the pull request request.");
    expect(result.code).toBe(
      DesktopGithubPullRequestErrorCode.ProviderRejected
    );
  });

  it("skips an earlier message that sanitizes to nothing and uses a later usable one", () => {
    const result = providerFailure(
      {
        status: 422,
        response: {
          data: {
            errors: [{ message: "   " }],
            message: "Validation failed: title too long",
          },
        },
      },
      DesktopGithubPullRequestStage.ApiUpdate,
      NOW
    );

    expect(result.error).toBe(
      "GitHub rejected the pull request request: Validation failed: title too long"
    );
  });

  it("falls back to the default rejection message when the provider payload's message field is not a string", () => {
    const result = providerFailure(
      // The outer shape parses (an unknown `data` is always accepted), but the
      // inner error-data schema rejects a non-string `message`.
      { status: 422, response: { data: { message: 123 } } },
      DesktopGithubPullRequestStage.ApiUpdate,
      NOW
    );

    expect(result.error).toBe("GitHub rejected the pull request request.");
    expect(result.code).toBe(
      DesktopGithubPullRequestErrorCode.ProviderRejected
    );
  });

  it("strips control characters out of the provider message instead of surfacing them", () => {
    const result = providerFailure(
      { status: 422, response: { data: { message: "Bad\u0007Byte" } } },
      DesktopGithubPullRequestStage.ApiUpdate,
      NOW
    );

    expect(result.error).toBe(
      "GitHub rejected the pull request request: Bad Byte"
    );
  });

  it("truncates a provider message longer than 300 characters instead of passing it through whole", () => {
    const longMessage = "x".repeat(310);

    const result = providerFailure(
      { status: 422, response: { data: { message: longMessage } } },
      DesktopGithubPullRequestStage.ApiUpdate,
      NOW
    );

    const truncated = `${"x".repeat(297)}...`;
    expect(result.error).toBe(
      `GitHub rejected the pull request request: ${truncated}`
    );
    expect(truncated).toHaveLength(300);
  });

  it("passes a message of exactly 300 characters through whole, with no truncation marker", () => {
    // The boundary itself: 300 is the max length that must NOT be truncated.
    // A test at 310 characters cannot distinguish `<=` from `<` here, since
    // both reject a message that far over the limit the same way.
    const exactLengthMessage = "x".repeat(300);

    const result = providerFailure(
      { status: 422, response: { data: { message: exactLengthMessage } } },
      DesktopGithubPullRequestStage.ApiUpdate,
      NOW
    );

    expect(result.error).toBe(
      `GitHub rejected the pull request request: ${exactLengthMessage}`
    );
  });

  it("maps a rate-limited provider error to a retryable failure carrying the retry-after seconds", () => {
    const result = providerFailure(
      { status: 429, headers: { "Retry-After": "30" } },
      DesktopGithubPullRequestStage.Provider,
      NOW
    );

    expect(result).toEqual({
      success: false,
      error: "GitHub rate limited pull request creation.",
      code: DesktopGithubPullRequestErrorCode.ProviderRateLimited,
      reason: DesktopGithubPullRequestReason.ProviderRateLimited,
      stage: DesktopGithubPullRequestStage.Provider,
      retryable: true,
      burnRetryBudget: false,
      status: 429,
      retryAfterSeconds: 30,
    });
  });

  it("maps a permission-filtered provider error to a non-retryable authorization failure", () => {
    const result = providerFailure(
      { status: 403 },
      DesktopGithubPullRequestStage.ApiCreate,
      NOW
    );

    expect(result).toEqual({
      success: false,
      error: "GitHub authorization does not allow creating this pull request.",
      code: DesktopGithubPullRequestErrorCode.AuthorizationDenied,
      reason: DesktopGithubPullRequestReason.AuthorizationDenied,
      stage: DesktopGithubPullRequestStage.ApiCreate,
      retryable: false,
      burnRetryBudget: false,
      status: 403,
    });
  });

  it("falls back to a retryable transient failure for an unclassified provider error", () => {
    const result = providerFailure(
      { status: 500 },
      DesktopGithubPullRequestStage.GitPush,
      NOW
    );

    expect(result).toEqual({
      success: false,
      error: "GitHub pull request service is temporarily unavailable.",
      code: DesktopGithubPullRequestErrorCode.TransientUnavailable,
      reason: DesktopGithubPullRequestReason.TransientUnavailable,
      stage: DesktopGithubPullRequestStage.GitPush,
      retryable: true,
      burnRetryBudget: false,
      status: 503,
    });
  });
});
