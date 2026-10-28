import {
  REALTIME_TOKEN_AUDIENCE,
  REALTIME_TOKEN_ISSUER,
  REALTIME_TOKEN_TTL_SECONDS,
  type RealtimeTokenClaims,
} from "@repo/realtime-contract/token";
import { describe, expect, it } from "vitest";
import { createRevocations, REVOCATION_RETENTION_MS } from "../revocations";

const ORG_A = "0190a2b4-0000-7000-8000-00000000000a";
const ORG_B = "0190a2b4-0000-7000-8000-00000000000b";
const USER_A = "user_a";
const USER_B = "user_b";

const DOC_1 = `comments:${ORG_A}:doc-1`;
const DOC_2 = `comments:${ORG_A}:doc-2`;
const ORG_B_DOC = `comments:${ORG_B}:doc-1`;
/** A revoke taken 10.5 s into the epoch. */
const REVOKED_AT = 10_500;

function claimsIssuedAt(iatSeconds: number, sub = USER_A): RealtimeTokenClaims {
  return {
    sub,
    org: ORG_A,
    grants: [],
    iat: iatSeconds,
    exp: iatSeconds + REALTIME_TOKEN_TTL_SECONDS,
    jti: `jti-${iatSeconds}`,
    aud: REALTIME_TOKEN_AUDIENCE,
    iss: REALTIME_TOKEN_ISSUER,
  };
}

describe("revocations", () => {
  it("binds a token issued in or before the revoke's second, not one issued after, and only the revoked user's", () => {
    const revocations = createRevocations(() => REVOKED_AT);
    revocations.record({ target: { userId: USER_A }, at: REVOKED_AT });

    expect(revocations.covers(claimsIssuedAt(9), DOC_1)).toBe(true);
    expect(revocations.covers(claimsIssuedAt(10), DOC_1)).toBe(true);
    expect(revocations.covers(claimsIssuedAt(11), DOC_1)).toBe(false);
    expect(revocations.covers(claimsIssuedAt(9, USER_B), DOC_1)).toBe(false);
  });

  it("binds a channel revoke to that channel and an org revoke to that org's channels", () => {
    const revocations = createRevocations(() => REVOKED_AT);
    revocations.record({ target: { channel: DOC_1 }, at: REVOKED_AT });
    const token = claimsIssuedAt(9, USER_B);

    expect(revocations.covers(token, DOC_1)).toBe(true);
    expect(revocations.covers(token, DOC_2)).toBe(false);

    revocations.record({ target: { orgId: ORG_A }, at: REVOKED_AT });
    expect(revocations.covers(token, DOC_2)).toBe(true);
    expect(revocations.covers(token, ORG_B_DOC)).toBe(false);
  });

  it("keeps the latest revoke of a target when an older one arrives after it", () => {
    const revocations = createRevocations(() => REVOKED_AT);
    revocations.record({ target: { userId: USER_A }, at: REVOKED_AT });
    revocations.record({ target: { userId: USER_A }, at: 1000 });

    expect(revocations.covers(claimsIssuedAt(5), DOC_1)).toBe(true);
  });

  it("drops a revoke once the token lifetime has passed since it", () => {
    let now = REVOKED_AT;
    const revocations = createRevocations(() => now);
    revocations.record({ target: { userId: USER_A }, at: REVOKED_AT });

    now = REVOKED_AT + REVOCATION_RETENTION_MS - 1;
    expect(revocations.covers(claimsIssuedAt(9), DOC_1)).toBe(true);
    now = REVOKED_AT + REVOCATION_RETENTION_MS;
    expect(revocations.covers(claimsIssuedAt(9), DOC_1)).toBe(false);
  });
});
