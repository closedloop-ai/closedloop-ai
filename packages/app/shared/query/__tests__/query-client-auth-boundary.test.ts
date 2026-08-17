/**
 * Boundary contract for the shared query client's `QueryCache.onError` auth
 * hook (FEA-3940, narrowed by ISS-5095). The hook latches the shell-wide re-auth
 * surface on the first ApiError **401** from ANY query — never on a BARE 403,
 * which is a per-resource authorization answer rather than a session failure —
 * and never for a query that owns its own access-denied UI via
 * `meta.ownsAuthRejection`. The one exception, and the precedence these tests
 * pin: a 403 the server explicitly tagged session-level latches even from an
 * opted-out query, because it is not an answer about that resource at all.
 *
 * These tests drive the real production client (`makeQueryClient`) so they
 * exercise the actual `onError` branch that was changed, not a reimplementation:
 * a `fetchQuery` whose `queryFn` rejects flows through the client's own
 * QueryCache into the boundary.
 */

import { AuthErrorCode } from "@repo/api/src/types/auth-error";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../api/api-error";
import {
  AuthRejectionReason,
  clearAuthRejection,
  getAuthRejected,
  getAuthRejectionReason,
  OWNS_AUTH_REJECTION_META_KEY,
} from "../auth-rejection-store";
import { makeQueryClient } from "../query-client";

async function runFailingQuery(options: {
  error: unknown;
  meta?: Record<string, unknown>;
}) {
  clearAuthRejection();
  const client = makeQueryClient();
  await client
    .fetchQuery({
      queryKey: ["auth-boundary-test", Math.random()],
      queryFn: () => Promise.reject(options.error),
      retry: false,
      meta: options.meta,
    })
    .catch(() => undefined);
}

describe("makeQueryClient auth-rejection boundary", () => {
  it("latches the re-auth surface on an ApiError 401 from a normal query", async () => {
    await runFailingQuery({ error: new ApiError("Unauthorized", 401) });
    expect(getAuthRejected()).toBe(true);
    clearAuthRejection();
  });

  // ISS-5095: driven through the real client so the production `onError` branch
  // is the thing under test. A forbidden sub-resource must leave the shell alone.
  it("does NOT latch on an ApiError 403 from a normal query", async () => {
    await runFailingQuery({ error: new ApiError("Forbidden", 403) });
    expect(getAuthRejected()).toBe(false);
  });

  it("does NOT latch when the failing query owns its own auth UI (opt-out meta)", async () => {
    // A per-resource 401 (e.g. useBranchView's "Access required") must not
    // hijack the whole shell into the session-expired surface.
    await runFailingQuery({
      error: new ApiError("Unauthorized", 401),
      meta: { [OWNS_AUTH_REJECTION_META_KEY]: true },
    });
    expect(getAuthRejected()).toBe(false);
  });

  // ISS-5095: the coded, session-level 403 must still reach the shell through
  // the real boundary — driven here rather than asserted on the predicate alone.
  it("latches on a session-tagged 403 from a normal query", async () => {
    await runFailingQuery({
      error: new ApiError("Forbidden", 403, {
        code: AuthErrorCode.OrgForbidden,
      }),
    });
    expect(getAuthRejected()).toBe(true);
    clearAuthRejection();
  });

  // ISS-5095 review: the opt-out is a claim about a RESOURCE, and a
  // server-tagged session code is not a resource answer, so the code outranks
  // the opt-out. Without this precedence `useBranchView`, `useBranchViewFileDiff`
  // and `use-trace-comments` — all opted out, all routed through `withAuth` —
  // swallow an org-confirmation failure and render "Access required" with a
  // Retry that can never clear it, while `/me` sits fresh for five minutes.
  it("latches on a session-tagged 403 EVEN from a query that owns its own auth UI", async () => {
    await runFailingQuery({
      error: new ApiError("Forbidden", 403, {
        code: AuthErrorCode.OrgForbidden,
      }),
      meta: { [OWNS_AUTH_REJECTION_META_KEY]: true },
    });
    expect(getAuthRejected()).toBe(true);
    expect(getAuthRejectionReason()).toBe(AuthRejectionReason.OrgUnconfirmed);
    clearAuthRejection();
  });

  // The other side of that precedence: the opt-out still holds for every
  // authorization answer that IS about the resource.
  it("does NOT latch on a bare 403 from a query that owns its own auth UI", async () => {
    await runFailingQuery({
      error: new ApiError("Forbidden", 403),
      meta: { [OWNS_AUTH_REJECTION_META_KEY]: true },
    });
    expect(getAuthRejected()).toBe(false);
  });

  it("does NOT latch on a 403 carrying an unrelated code from an opted-out query", async () => {
    await runFailingQuery({
      error: new ApiError("Forbidden", 403, { code: "team_admin_required" }),
      meta: { [OWNS_AUTH_REJECTION_META_KEY]: true },
    });
    expect(getAuthRejected()).toBe(false);
  });

  it("does not latch on a non-auth ApiError even from a normal query", async () => {
    await runFailingQuery({ error: new ApiError("Server error", 500) });
    expect(getAuthRejected()).toBe(false);
  });
});
