import { describe, expect, it } from "vitest";
import {
  CLERK_SESSION_TASK_CHOOSE_ORGANIZATION,
  DesktopBootstrapErrorCode,
  desktopBootstrapMintResultSchema,
  desktopBootstrapRedeemResultSchema,
} from "./desktop-bootstrap";

/**
 * ISS-10966 (PLN-2095 Slice 1) — the bootstrap mint's RESPONSE boundary.
 *
 * This schema is the only thing between a malformed 2xx and Desktop being handed
 * an `undefined` code that it would carry into a loopback redirect. So the cases
 * that matter are the rejections: a schema exercised only on a valid payload
 * would pass identically if every field were `z.unknown()`.
 */

const VALID = {
  code: "bootstrap-code-1",
  expiresAt: "2026-09-24T21:32:52.000Z",
};

describe("desktopBootstrapMintResultSchema", () => {
  it("parses a well-formed mint result", () => {
    expect(desktopBootstrapMintResultSchema.parse(VALID)).toEqual(VALID);
  });

  it("rejects a missing code, rather than yielding undefined", () => {
    const result = desktopBootstrapMintResultSchema.safeParse({
      expiresAt: VALID.expiresAt,
    });
    expect(result.success).toBe(false);
    // Asserted on the PATH, not merely on `success`: a schema that failed for
    // some unrelated reason would satisfy a bare falsiness check while leaving
    // this field unguarded.
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([["code"]]);
  });

  it("rejects an EMPTY code, which is the shape a broken mint actually emits", () => {
    // A service that built its result from an unset variable produces `""`, not
    // a missing key. Without `.min(1)` this parses and Desktop redirects with an
    // empty code that fails at redeem with no useful signal.
    const result = desktopBootstrapMintResultSchema.safeParse({
      ...VALID,
      code: "",
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([["code"]]);
  });

  it("rejects an empty expiresAt", () => {
    const result = desktopBootstrapMintResultSchema.safeParse({
      ...VALID,
      expiresAt: "",
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([
      ["expiresAt"],
    ]);
  });

  it("rejects a non-string code rather than coercing it", () => {
    const result = desktopBootstrapMintResultSchema.safeParse({
      ...VALID,
      code: 12_345,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([["code"]]);
  });

  it("IGNORES an unknown key, so a newer API cannot strand an older browser", () => {
    // The deliberate non-`.strict()` half of the contract, asserted so a future
    // change that adds `.strict()` here goes red instead of shipping a bundle
    // that rejects the whole payload mid-signup. The unknown key is dropped
    // rather than passed through.
    const parsed = desktopBootstrapMintResultSchema.parse({
      ...VALID,
      fieldFromANewerApi: "ignored",
    });
    expect(parsed).toEqual(VALID);
    expect(parsed).not.toHaveProperty("fieldFromANewerApi");
  });
});

describe("desktopBootstrapRedeemResultSchema", () => {
  const redeemResult = {
    bootstrapToken: "bootstrap-token",
    expiresAt: VALID.expiresAt,
    pendingUserId: "user_123",
  };

  it("publishes the pending Clerk user separately from an internal identity", () => {
    expect(desktopBootstrapRedeemResultSchema.parse(redeemResult)).toEqual(
      redeemResult
    );
  });

  it("rejects a response that omits the pending user", () => {
    const { pendingUserId: _, ...missingPendingUser } = redeemResult;
    expect(
      desktopBootstrapRedeemResultSchema.safeParse(missingPendingUser).success
    ).toBe(false);
  });
});

describe("DesktopBootstrapErrorCode", () => {
  it("pins the mint, token and organization refusal literals on the wire", () => {
    // Every member pinned, not just the distinctive one: a typo in any of them
    // (`..._INVALID_REQEUST`) is invisible to a shape or distinctness check, and
    // these strings ARE the contract — the desktop client branches on them, and
    // they are the half of the mirrored vocabulary a reviewer can only verify by
    // eye. Written as a whole-object equality so a member ADDED without a
    // decision fails here too.
    expect({ ...DesktopBootstrapErrorCode }).toEqual({
      PendingSessionRequired: "PENDING_SESSION_REQUIRED",
      InvalidBody: "INVALID_DESKTOP_BOOTSTRAP",
      Forbidden: "DESKTOP_BOOTSTRAP_FORBIDDEN",
      ServiceRejected: "DESKTOP_BOOTSTRAP_INVALID_REQUEST",
      Failed: "DESKTOP_BOOTSTRAP_FAILED",
      TokenInvalidBody: "INVALID_DESKTOP_BOOTSTRAP_TOKEN",
      TokenFailed: "DESKTOP_BOOTSTRAP_TOKEN_FAILED",
      ProofOfPossessionRequired: "DESKTOP_SESSION_POP_REQUIRED",
      TokenInvalid: "DESKTOP_BOOTSTRAP_TOKEN_INVALID",
      BootstrapRequired: "DESKTOP_BOOTSTRAP_REQUIRED",
      OrganizationInvalidBody: "INVALID_DESKTOP_ORGANIZATION",
      OrganizationFailed: "DESKTOP_ORGANIZATION_FAILED",
      OrganizationAlreadyExists: "DESKTOP_ORGANIZATION_ALREADY_EXISTS",
      BootstrapInvalid: "DESKTOP_BOOTSTRAP_INVALID",
    });
  });

  it("keeps every refusal distinguishable on the wire", () => {
    const codes = Object.values(DesktopBootstrapErrorCode);
    // A duplicated literal would silently collapse two refusals into one, which
    // is exactly the distinction the desktop client branches on.
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("does not reuse the sibling mint's SESSION_REQUIRED spelling", () => {
    // `/desktop/authorize` returns `SESSION_REQUIRED` for an absent signed-in
    // principal. This route admits a strictly narrower principal, so a client
    // must not read the two refusals as the same condition and retry one
    // against the other.
    expect(Object.values(DesktopBootstrapErrorCode)).not.toContain(
      "SESSION_REQUIRED"
    );
    expect(DesktopBootstrapErrorCode.PendingSessionRequired).toBe(
      "PENDING_SESSION_REQUIRED"
    );
  });
});

describe("CLERK_SESSION_TASK_CHOOSE_ORGANIZATION", () => {
  it("is Clerk's own task key, spelled exactly", () => {
    // Pinned as a literal because a typo would never match a real session task:
    // the render-swap in Slice 4 would silently fall through, the Clerk embed
    // would render, and the reported bug would look unfixed with nothing red.
    expect(CLERK_SESSION_TASK_CHOOSE_ORGANIZATION).toBe("choose-organization");
  });
});
