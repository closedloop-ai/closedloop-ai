import {
  SelectedPullRequestEvidenceAvailability,
  SelectedPullRequestEvidenceUnavailableReason,
} from "@repo/api/src/types/selected-pull-request-evidence";
import { describe, expect, it } from "vitest";
import {
  classifySelectedPullRequestProviderError,
  classifySelectedPullRequestProviderFailure,
  SelectedPullRequestProviderOperation,
} from "../selected-pull-request-provider-failure";

/**
 * ISS-6655: the classifier every Branches provider failure flows through. Every
 * branch returns the same `{status, reason}` shape, so these assert the `reason`
 * discriminant per input — a `status === Unavailable` assertion is satisfied by
 * all of them and by a bug collapsing 401 into the generic `ProviderFailure`.
 */

const PROVIDER_SECRET = "ghs_supersecrettokenvalue";

function abortError(): Error {
  const error = new Error(`aborted while reading ${PROVIDER_SECRET}`);
  error.name = "AbortError";
  return error;
}

type ClassifierCase = {
  name: string;
  error: unknown;
  operation: SelectedPullRequestProviderOperation;
  reason: SelectedPullRequestEvidenceUnavailableReason;
};

const REASON_CASES: ClassifierCase[] = [
  {
    name: "an aborted read (error.name)",
    error: abortError(),
    operation: SelectedPullRequestProviderOperation.PullRequest,
    reason: SelectedPullRequestEvidenceUnavailableReason.ProviderTimedOut,
  },
  {
    name: "a 401 on the error itself",
    error: { status: 401, message: PROVIDER_SECRET },
    operation: SelectedPullRequestProviderOperation.PullRequest,
    reason: SelectedPullRequestEvidenceUnavailableReason.CredentialUnauthorized,
  },
  {
    name: "a 401 nested under response",
    error: { response: { status: 401 }, message: PROVIDER_SECRET },
    operation: SelectedPullRequestProviderOperation.SelectedRevision,
    reason: SelectedPullRequestEvidenceUnavailableReason.CredentialUnauthorized,
  },
  {
    name: "a 401 whose provider text also mentions a rate limit",
    error: {
      status: 401,
      message: `Bad credentials. You have exceeded a secondary rate limit ${PROVIDER_SECRET}`,
    },
    operation: SelectedPullRequestProviderOperation.PullRequest,
    reason: SelectedPullRequestEvidenceUnavailableReason.CredentialUnauthorized,
  },
  {
    name: "a nested 401 carrying both Retry-After and rate-limit text",
    error: {
      response: { status: 401, headers: { "retry-after": "42" } },
      message: `rate limit exceeded ${PROVIDER_SECRET}`,
    },
    operation: SelectedPullRequestProviderOperation.SelectedRevision,
    reason: SelectedPullRequestEvidenceUnavailableReason.CredentialUnauthorized,
  },
  {
    name: "a 401 carrying a structured RATE_LIMITED error entry",
    error: {
      status: 401,
      errors: [{ type: "RATE_LIMITED", message: PROVIDER_SECRET }],
    },
    operation: SelectedPullRequestProviderOperation.PullRequest,
    reason: SelectedPullRequestEvidenceUnavailableReason.CredentialUnauthorized,
  },
  {
    name: "a non-rate-limited 403",
    error: {
      status: 403,
      message: `Resource not accessible ${PROVIDER_SECRET}`,
    },
    operation: SelectedPullRequestProviderOperation.PullRequest,
    reason:
      SelectedPullRequestEvidenceUnavailableReason.CredentialInsufficientScope,
  },
  {
    name: "a 404 on the pull-request read",
    error: { status: 404, message: PROVIDER_SECRET },
    operation: SelectedPullRequestProviderOperation.PullRequest,
    reason:
      SelectedPullRequestEvidenceUnavailableReason.PullRequestMissingOrInaccessible,
  },
  {
    name: "a 404 on the selected-revision read",
    error: { status: 404, message: PROVIDER_SECRET },
    operation: SelectedPullRequestProviderOperation.SelectedRevision,
    reason:
      SelectedPullRequestEvidenceUnavailableReason.SelectedRevisionMissingOrInaccessible,
  },
  {
    name: "a 500",
    error: { status: 500, message: PROVIDER_SECRET },
    operation: SelectedPullRequestProviderOperation.PullRequest,
    reason: SelectedPullRequestEvidenceUnavailableReason.ProviderUnavailable,
  },
  {
    name: "a 503 nested under response",
    error: { response: { status: 503 }, message: PROVIDER_SECRET },
    operation: SelectedPullRequestProviderOperation.SelectedRevision,
    reason: SelectedPullRequestEvidenceUnavailableReason.ProviderUnavailable,
  },
  {
    name: "a 499 just below the server-error floor",
    error: { status: 499, message: PROVIDER_SECRET },
    operation: SelectedPullRequestProviderOperation.PullRequest,
    reason: SelectedPullRequestEvidenceUnavailableReason.ProviderFailure,
  },
  {
    name: "an unparseable string throw",
    error: `boom ${PROVIDER_SECRET}`,
    operation: SelectedPullRequestProviderOperation.PullRequest,
    reason: SelectedPullRequestEvidenceUnavailableReason.ProviderFailure,
  },
  {
    name: "a non-numeric status the schema rejects",
    error: { status: "429", detail: PROVIDER_SECRET },
    operation: SelectedPullRequestProviderOperation.SelectedRevision,
    reason: SelectedPullRequestEvidenceUnavailableReason.ProviderFailure,
  },
];

const RATE_LIMIT_CASES: {
  name: string;
  error: unknown;
  retry: number | null;
}[] = [
  {
    name: "a 429 carrying Retry-After",
    error: {
      status: 429,
      headers: { "retry-after": "37" },
      message: PROVIDER_SECRET,
    },
    retry: 37,
  },
  {
    name: "a 429 whose Retry-After header was dropped",
    error: { status: 429, message: PROVIDER_SECRET },
    retry: null,
  },
  {
    name: "a 403 that is really a secondary rate limit",
    error: {
      status: 403,
      headers: { "retry-after": "12" },
      message: PROVIDER_SECRET,
    },
    retry: 12,
  },
  {
    name: "a bare Error whose text is the only rate-limit evidence",
    error: new Error("You have exceeded a secondary rate limit"),
    retry: null,
  },
];

describe("classifySelectedPullRequestProviderError", () => {
  it.each(REASON_CASES)(
    "classifies $name",
    ({ error, operation, reason }: ClassifierCase) => {
      expect(
        classifySelectedPullRequestProviderError(error, operation)
      ).toEqual({
        reason,
      });
    }
  );

  it("flips only the 404 reason on the operation, leaving every other branch fixed", () => {
    const errors = [
      { status: 404 },
      { status: 401 },
      { status: 403 },
      { status: 500 },
      { status: 499 },
    ];
    const flipped = errors.filter(
      (error) =>
        classifySelectedPullRequestProviderError(
          error,
          SelectedPullRequestProviderOperation.PullRequest
        ).reason !==
        classifySelectedPullRequestProviderError(
          error,
          SelectedPullRequestProviderOperation.SelectedRevision
        ).reason
    );

    expect(flipped).toEqual([{ status: 404 }]);
  });

  it("keys the timeout branch on error.name, not on message text or a plain object", () => {
    expect(
      classifySelectedPullRequestProviderError(
        abortError(),
        SelectedPullRequestProviderOperation.PullRequest
      ).reason
    ).toBe(SelectedPullRequestEvidenceUnavailableReason.ProviderTimedOut);

    expect(
      classifySelectedPullRequestProviderError(
        new Error("AbortError"),
        SelectedPullRequestProviderOperation.PullRequest
      ).reason
    ).toBe(SelectedPullRequestEvidenceUnavailableReason.ProviderFailure);

    expect(
      classifySelectedPullRequestProviderError(
        { name: "AbortError" },
        SelectedPullRequestProviderOperation.PullRequest
      ).reason
    ).toBe(SelectedPullRequestEvidenceUnavailableReason.ProviderFailure);
  });

  /**
   * An authoritative 401 is the provider's verdict on the credential; rate-limit
   * evidence is a heuristic over message text. Reading the heuristic first told
   * consumers to back off and retry a credential that will never succeed again,
   * instead of prompting reauthentication. 403 is the opposite case: GitHub
   * really does report secondary rate limits as 403, so there the heuristic must
   * still win over the insufficient-scope reading.
   */
  it("lets an authoritative 401 outrank rate-limit evidence, while a 403 still yields to it", () => {
    const rateLimitEvidence = {
      headers: { "retry-after": "12" },
      message: "You have exceeded a secondary rate limit",
    };

    expect(
      classifySelectedPullRequestProviderError(
        { ...rateLimitEvidence, status: 401 },
        SelectedPullRequestProviderOperation.PullRequest
      )
    ).toEqual({
      reason:
        SelectedPullRequestEvidenceUnavailableReason.CredentialUnauthorized,
    });

    expect(
      classifySelectedPullRequestProviderError(
        { ...rateLimitEvidence, status: 403 },
        SelectedPullRequestProviderOperation.PullRequest
      )
    ).toEqual({
      reason: SelectedPullRequestEvidenceUnavailableReason.ProviderRateLimited,
      retryAfterSeconds: 12,
    });
  });

  it.each(RATE_LIMIT_CASES)(
    "preserves retry metadata as a present key for $name",
    ({ error, retry }) => {
      const result = classifySelectedPullRequestProviderError(
        error,
        SelectedPullRequestProviderOperation.PullRequest
      );

      // `failure()` omits `retryAfterSeconds` when undefined, so
      // `toBeUndefined()` would also pass for a non-rate-limited failure and for
      // a rate limit whose retry metadata was dropped. Assert the key exists.
      expect(Object.keys(result).sort()).toEqual([
        "reason",
        "retryAfterSeconds",
      ]);
      expect(result).toEqual({
        reason:
          SelectedPullRequestEvidenceUnavailableReason.ProviderRateLimited,
        retryAfterSeconds: retry,
      });
    }
  );

  it("omits the retry key entirely on every non-rate-limited branch", () => {
    for (const { error, operation } of REASON_CASES) {
      expect(
        Object.hasOwn(
          classifySelectedPullRequestProviderError(error, operation),
          "retryAfterSeconds"
        )
      ).toBe(false);
    }
  });

  it("never returns provider response text", () => {
    for (const { error, operation } of [
      ...REASON_CASES,
      ...RATE_LIMIT_CASES.map((rateLimitCase) => ({
        error: rateLimitCase.error,
        operation: SelectedPullRequestProviderOperation.PullRequest,
      })),
    ]) {
      const serialized = JSON.stringify(
        classifySelectedPullRequestProviderError(error, operation)
      );

      expect(serialized).not.toContain(PROVIDER_SECRET);
      expect(serialized).not.toContain("rate limit");
    }
  });
});

describe("classifySelectedPullRequestProviderFailure", () => {
  it("wraps the pull-request-scoped classification as an unavailable evidence result", () => {
    expect(classifySelectedPullRequestProviderFailure({ status: 404 })).toEqual(
      {
        status: SelectedPullRequestEvidenceAvailability.Unavailable,
        reason:
          SelectedPullRequestEvidenceUnavailableReason.PullRequestMissingOrInaccessible,
      }
    );
  });

  it("cannot reach the selected-revision reason, because it pins the operation", () => {
    const reasons = REASON_CASES.map(
      ({ error }) => classifySelectedPullRequestProviderFailure(error).reason
    );

    expect(reasons).not.toContain(
      SelectedPullRequestEvidenceUnavailableReason.SelectedRevisionMissingOrInaccessible
    );
    expect(reasons).toContain(
      SelectedPullRequestEvidenceUnavailableReason.PullRequestMissingOrInaccessible
    );
  });

  it("carries rate-limit retry metadata through the wrapper", () => {
    expect(
      classifySelectedPullRequestProviderFailure({
        status: 429,
        headers: { "retry-after": "37" },
      })
    ).toEqual({
      status: SelectedPullRequestEvidenceAvailability.Unavailable,
      reason: SelectedPullRequestEvidenceUnavailableReason.ProviderRateLimited,
      retryAfterSeconds: 37,
    });
  });
});
