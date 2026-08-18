/**
 * Cross-query auth-rejection signal (FEA-3940, narrowed by ISS-5095). The shared
 * boundary must trip the web shell's re-auth surface on a Closedloop-session
 * failure from ANY query — a 401, or a 403 the server explicitly tagged
 * session-level — while NOT tripping on:
 *   - a BARE 403 — "this resource isn't yours", not "your session is dead"
 *     (ISS-5095: a membership-gated repo pool blanked the whole workspace with a
 *     false "Your session expired");
 *   - errors from other transports that merely carry a 401/403 (the Branches
 *     gateway's LivePrOverlayError = "not connected", not a session failure).
 *
 * The two 403 cases sit side by side below on purpose: the distinction is the
 * whole point, and a test file that only pinned one half would let the other
 * drift.
 */

import {
  AuthErrorCode,
  ORG_UNVERIFIABLE_MESSAGE,
} from "@repo/api/src/types/auth-error";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "../../api/api-error";
import {
  AuthRejectionReason,
  clearAuthRejection,
  getAuthRejected,
  getAuthRejectionReason,
  isIdentityProbeAuthRejection,
  OWNS_AUTH_REJECTION_META_KEY,
  publishAuthRejectionForQuery,
  publishAuthRejectionIfAuthError,
  queryOwnsAuthRejection,
  subscribeAuthRejection,
} from "../auth-rejection-store";

/** A non-ApiError 403 (LivePrOverlayError-shaped). */
class GatewayError extends Error {
  readonly status: number;
  constructor(status: number) {
    super("gateway");
    this.status = status;
  }
}

describe("auth-rejection-store", () => {
  afterEach(() => {
    clearAuthRejection();
  });

  it("latches and notifies on an ApiError 401", () => {
    let notified = 0;
    const unsubscribe = subscribeAuthRejection(() => {
      notified += 1;
    });
    expect(getAuthRejected()).toBe(false);

    publishAuthRejectionIfAuthError(new ApiError("Unauthorized", 401));
    expect(getAuthRejected()).toBe(true);
    expect(notified).toBe(1);

    // Idempotent: a second auth error while already latched does not re-notify.
    publishAuthRejectionIfAuthError(new ApiError("Unauthorized", 401));
    expect(notified).toBe(1);

    unsubscribe();
  });

  // ISS-5095: the regression that blanked the workspace. A resource-scoped 403
  // (GET /teams/:id/repositories for an org member who is not on that team) is
  // NOT a session failure and must never latch the shell-wide re-auth surface.
  it("does NOT latch on an ApiError 403 (forbidden resource, not a dead session)", () => {
    let notified = 0;
    const unsubscribe = subscribeAuthRejection(() => {
      notified += 1;
    });

    publishAuthRejectionIfAuthError(new ApiError("Forbidden", 403));

    expect(getAuthRejected()).toBe(false);
    expect(notified).toBe(0);

    unsubscribe();
  });

  // The other half of the ISS-5095 contract. `withAuth` answers 403 when the
  // request's org cannot be confirmed for the session — every authenticated
  // request carries the org header, so that fails every query at once and
  // re-auth is the only way out. Tagged with a code precisely so it stays
  // distinguishable from a forbidden resource, which the case above proves is
  // ignored. Without this, narrowing to 401 would have deleted the only
  // recovery affordance for a real session failure.
  it("latches on a 403 the server tagged as a session-level auth failure", () => {
    publishAuthRejectionIfAuthError(
      new ApiError("Forbidden", 403, { code: AuthErrorCode.OrgForbidden })
    );
    expect(getAuthRejected()).toBe(true);
  });

  it("latches an unverifiable-org outage under its OWN reason, not the session one", () => {
    // ISS-5118. The org lookup FAILED rather than denying the caller, so the
    // server answers a retryable 503 with its own code. Two things have to be
    // true at once, and pinning only one of them is how this regresses:
    //   - it DOES latch, because the org header rides every authenticated
    //     request, so the outage fails every query on the page at once and there
    //     is no per-surface state left to explain it;
    //   - it does NOT latch as `SessionExpired`, because that card asserts a
    //     dead session over a live one and leads with a Sign in that cannot fix
    //     a provider outage. The reason is what selects the retry-only card in
    //     `WorkspaceAuthGuard`.
    publishAuthRejectionIfAuthError(
      new ApiError(ORG_UNVERIFIABLE_MESSAGE, 503, {
        code: AuthErrorCode.OrgUnverifiable,
      })
    );
    expect(getAuthRejected()).toBe(true);
    expect(getAuthRejectionReason()).toBe(AuthRejectionReason.OrgUnverifiable);
    expect(getAuthRejectionReason()).not.toBe(
      AuthRejectionReason.SessionExpired
    );
  });

  it("ignores a bare 503 that carries no auth code", () => {
    // The code is the contract, not the status: an ordinary upstream 503 from
    // any route must not blank the workspace.
    publishAuthRejectionIfAuthError(new ApiError("Unavailable", 503));
    expect(getAuthRejected()).toBe(false);
  });

  it("ignores a 403 carrying an unrelated error code", () => {
    publishAuthRejectionIfAuthError(
      new ApiError("Forbidden", 403, { code: "some_other_code" })
    );
    expect(getAuthRejected()).toBe(false);
  });

  it("ignores a non-ApiError 401 (gateway not-connected, not a session failure)", () => {
    publishAuthRejectionIfAuthError(new GatewayError(401));
    expect(getAuthRejected()).toBe(false);
  });

  it("ignores non-auth ApiError statuses", () => {
    publishAuthRejectionIfAuthError(new ApiError("Not found", 404));
    publishAuthRejectionIfAuthError(new ApiError("Server error", 500));
    expect(getAuthRejected()).toBe(false);
  });

  it("clears the latch and notifies subscribers", () => {
    let notified = 0;
    const unsubscribe = subscribeAuthRejection(() => {
      notified += 1;
    });
    publishAuthRejectionIfAuthError(new ApiError("Unauthorized", 401));
    expect(notified).toBe(1);

    clearAuthRejection();
    expect(getAuthRejected()).toBe(false);
    expect(notified).toBe(2);

    // Clearing again while already clear is a no-op (no extra notification).
    clearAuthRejection();
    expect(notified).toBe(2);

    unsubscribe();
  });
});

describe("auth-rejection reason", () => {
  afterEach(() => {
    clearAuthRejection();
  });

  it("reports no reason until something latches", () => {
    expect(getAuthRejectionReason()).toBeNull();
  });

  // The card's copy is derived from this, so the two failures must stay
  // distinguishable at the store: "your session expired" over a live session
  // whose org merely could not be confirmed is the same false claim ISS-5095
  // exists to remove.
  it("reports a 401 as an expired session", () => {
    publishAuthRejectionIfAuthError(new ApiError("Unauthorized", 401));
    expect(getAuthRejectionReason()).toBe(AuthRejectionReason.SessionExpired);
  });

  it("reports a session-tagged 403 as an unconfirmed organization", () => {
    publishAuthRejectionIfAuthError(
      new ApiError("Forbidden", 403, { code: AuthErrorCode.OrgForbidden })
    );
    expect(getAuthRejectionReason()).toBe(AuthRejectionReason.OrgUnconfirmed);
  });

  it("clears the reason along with the latch", () => {
    publishAuthRejectionIfAuthError(new ApiError("Unauthorized", 401));
    clearAuthRejection();
    expect(getAuthRejectionReason()).toBeNull();
  });
});

describe("publishAuthRejectionForQuery", () => {
  afterEach(() => {
    clearAuthRejection();
  });

  const optedOut = { [OWNS_AUTH_REJECTION_META_KEY]: true };

  it("honors the opt-out for a per-resource 401", () => {
    publishAuthRejectionForQuery(new ApiError("Unauthorized", 401), optedOut);
    expect(getAuthRejected()).toBe(false);
  });

  it("honors the opt-out for a bare 403", () => {
    publishAuthRejectionForQuery(new ApiError("Forbidden", 403), optedOut);
    expect(getAuthRejected()).toBe(false);
  });

  // The precedence fix. A server-tagged session code is not an answer about the
  // resource, so the opt-out has no claim over it.
  it("overrides the opt-out for a server-tagged session 403", () => {
    publishAuthRejectionForQuery(
      new ApiError("Forbidden", 403, { code: AuthErrorCode.OrgForbidden }),
      optedOut
    );
    expect(getAuthRejected()).toBe(true);
    expect(getAuthRejectionReason()).toBe(AuthRejectionReason.OrgUnconfirmed);
  });

  it("publishes normally when the query did not opt out", () => {
    publishAuthRejectionForQuery(new ApiError("Unauthorized", 401), undefined);
    expect(getAuthRejected()).toBe(true);
  });
});

describe("isIdentityProbeAuthRejection", () => {
  // `/me` is the identity probe: unlike every other query, a bare 403 there IS
  // a session failure, because the question was "who am I".
  it("accepts 401 and 403 alike, coded or not", () => {
    expect(
      isIdentityProbeAuthRejection(new ApiError("Unauthorized", 401))
    ).toBe(true);
    expect(isIdentityProbeAuthRejection(new ApiError("Forbidden", 403))).toBe(
      true
    );
    expect(
      isIdentityProbeAuthRejection(
        new ApiError("Forbidden", 403, { code: AuthErrorCode.OrgForbidden })
      )
    ).toBe(true);
  });

  it("rejects non-auth statuses and non-ApiError transports", () => {
    expect(isIdentityProbeAuthRejection(new ApiError("Server", 500))).toBe(
      false
    );
    expect(isIdentityProbeAuthRejection(new GatewayError(401))).toBe(false);
  });
});

describe("queryOwnsAuthRejection", () => {
  it("is true only when meta opts out via the canonical key", () => {
    expect(
      queryOwnsAuthRejection({ [OWNS_AUTH_REJECTION_META_KEY]: true })
    ).toBe(true);
  });

  it("is false for undefined, empty, or non-true meta", () => {
    expect(queryOwnsAuthRejection(undefined)).toBe(false);
    expect(queryOwnsAuthRejection({})).toBe(false);
    expect(
      queryOwnsAuthRejection({ [OWNS_AUTH_REJECTION_META_KEY]: false })
    ).toBe(false);
    // A truthy-but-not-true value must not opt out (strict === true).
    expect(
      queryOwnsAuthRejection({ [OWNS_AUTH_REJECTION_META_KEY]: 1 as unknown })
    ).toBe(false);
    // An unrelated meta flag (e.g. suppressDefaultErrorToast) does not opt out.
    expect(queryOwnsAuthRejection({ suppressDefaultErrorToast: true })).toBe(
      false
    );
  });
});
