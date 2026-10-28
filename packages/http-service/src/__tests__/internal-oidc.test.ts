import { log } from "@repo/observability/log";
import { SignJWT } from "jose";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createInternalOidcVerifier,
  InternalOidcVerdict,
  JWKS_FETCH_ATTEMPTS,
  JWKS_OUTAGE_COOLDOWN_MS,
} from "../internal-oidc";
import {
  createOidcFixture,
  OIDC_CONFIG,
  OIDC_JWKS_URL,
  type OidcFixture,
} from "../test-support/oidc-fixture";

let fixture: OidcFixture;

beforeAll(async () => {
  fixture = await createOidcFixture();
});

beforeEach(() => {
  vi.spyOn(log, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createInternalOidcVerifier", () => {
  it("verifies a token carrying every expected claim, against the issuer's JWKS", async () => {
    const fetch = fixture.servingJwks();
    const verify = createInternalOidcVerifier(OIDC_CONFIG, {
      unavailableEvent: INTERNAL_OIDC_JWKS_UNAVAILABLE_EVENT,
      fetch,
    });

    expect(await verify(await fixture.mint())).toEqual({
      verdict: InternalOidcVerdict.Verified,
    });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      OIDC_JWKS_URL,
      expect.anything()
    );
  });

  it.each([
    ["iss", { iss: "https://oidc.vercel.com/other-team" }],
    ["aud", { aud: "https://vercel.com/fixture-team" }],
    ["owner_id", { owner_id: "team_other" }],
    ["project_id", { project_id: "prj_other" }],
    ["environment", { environment: "development" }],
  ])("rejects a token whose %s does not match", async (claim, overrides) => {
    const verify = createInternalOidcVerifier(OIDC_CONFIG, {
      unavailableEvent: INTERNAL_OIDC_JWKS_UNAVAILABLE_EVENT,
      fetch: fixture.servingJwks(),
    });

    expect(await verify(await fixture.mint(overrides))).toEqual({
      verdict: InternalOidcVerdict.Rejected,
      reason: claim,
    });
  });

  it("rejects a token signed by a key the JWKS does not hold", async () => {
    const verify = createInternalOidcVerifier(OIDC_CONFIG, {
      unavailableEvent: INTERNAL_OIDC_JWKS_UNAVAILABLE_EVENT,
      fetch: fixture.servingJwks(),
    });

    expect(await verify(await fixture.mint({}, fixture.otherKey))).toEqual({
      verdict: InternalOidcVerdict.Rejected,
      reason: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
    });
  });

  it("rejects a token with no exp", async () => {
    const verify = createInternalOidcVerifier(OIDC_CONFIG, {
      unavailableEvent: INTERNAL_OIDC_JWKS_UNAVAILABLE_EVENT,
      fetch: fixture.servingJwks(),
    });

    expect(await verify(await fixture.mint({ exp: undefined }))).toEqual({
      verdict: InternalOidcVerdict.Rejected,
      reason: "exp",
    });
  });

  it("rejects a token signed with any algorithm but RS256", async () => {
    const verify = createInternalOidcVerifier(OIDC_CONFIG, {
      unavailableEvent: INTERNAL_OIDC_JWKS_UNAVAILABLE_EVENT,
      fetch: fixture.servingJwks(),
    });
    const hs256 = await new SignJWT({
      owner_id: OIDC_CONFIG.ownerId,
      project_id: OIDC_CONFIG.projectId,
      environment: OIDC_CONFIG.environment,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(OIDC_CONFIG.issuer)
      .setAudience(OIDC_CONFIG.audience)
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(HS256_SECRET));

    expect(await verify(hs256)).toEqual({
      verdict: InternalOidcVerdict.Rejected,
      reason: "ERR_JOSE_ALG_NOT_ALLOWED",
    });
  });

  it("fetches the key set once for many tokens", async () => {
    const fetch = fixture.servingJwks();
    const verify = createInternalOidcVerifier(OIDC_CONFIG, {
      unavailableEvent: INTERNAL_OIDC_JWKS_UNAVAILABLE_EVENT,
      fetch,
    });

    await verify(await fixture.mint());
    await verify(await fixture.mint());

    expect(fetch).toHaveBeenCalledOnce();
  });

  it("fails closed after a bounded retry when the JWKS cannot be fetched, and logs it", async () => {
    const fetch = vi.fn(() => Promise.reject(new TypeError("fetch failed")));
    const verify = createInternalOidcVerifier(OIDC_CONFIG, {
      unavailableEvent: INTERNAL_OIDC_JWKS_UNAVAILABLE_EVENT,
      fetch,
    });

    expect(await verify(await fixture.mint())).toEqual({
      verdict: InternalOidcVerdict.Unavailable,
    });
    expect(fetch).toHaveBeenCalledTimes(JWKS_FETCH_ATTEMPTS);
    expect(JWKS_FETCH_ATTEMPTS).toBe(2);
    expect(log.error).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      event: INTERNAL_OIDC_JWKS_UNAVAILABLE_EVENT,
      attempts: 2,
      cause: "TypeError",
    });
  });

  it("answers unavailable without fetching for the cooldown after an outage, then fetches again", async () => {
    let now = 1_000_000;
    const fetch = vi.fn(() => Promise.reject(new TypeError("fetch failed")));
    const verify = createInternalOidcVerifier(OIDC_CONFIG, {
      unavailableEvent: INTERNAL_OIDC_JWKS_UNAVAILABLE_EVENT,
      fetch,
      now: () => now,
    });
    const token = await fixture.mint();

    await verify(token);
    now += JWKS_OUTAGE_COOLDOWN_MS - 1;
    expect(await verify(token)).toEqual({
      verdict: InternalOidcVerdict.Unavailable,
    });
    expect(fetch).toHaveBeenCalledTimes(JWKS_FETCH_ATTEMPTS);
    expect(log.error).toHaveBeenCalledOnce();

    now += 1;
    await verify(token);
    expect(fetch).toHaveBeenCalledTimes(2 * JWKS_FETCH_ATTEMPTS);
  });

  it("keeps verifying with the cached key set while a failed refetch cools down", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(JWKS_FETCHED_AT);
    const fetch = vi.fn(fixture.servingJwks());
    const verify = createInternalOidcVerifier(OIDC_CONFIG, {
      unavailableEvent: INTERNAL_OIDC_JWKS_UNAVAILABLE_EVENT,
      fetch,
    });
    expect(await verify(await fixture.mint())).toEqual({
      verdict: InternalOidcVerdict.Verified,
    });
    fetch.mockRejectedValue(new TypeError("fetch failed"));
    vi.setSystemTime(JWKS_FETCHED_AT + JOSE_UNKNOWN_KID_COOLDOWN_MS + 1000);
    const unknownKid = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "rotated-key" })
      .sign(fixture.otherKey);

    expect(await verify(unknownKid)).toEqual({
      verdict: InternalOidcVerdict.Unavailable,
    });
    expect(await verify(await fixture.mint())).toEqual({
      verdict: InternalOidcVerdict.Verified,
    });
    expect(fetch).toHaveBeenCalledTimes(1 + JWKS_FETCH_ATTEMPTS);
  });

  it("verifies on the retry when the first JWKS fetch fails", async () => {
    const serving = fixture.servingJwks();
    const fetch = vi
      .fn(serving)
      .mockRejectedValueOnce(new TypeError("fetch failed"));
    const verify = createInternalOidcVerifier(OIDC_CONFIG, {
      unavailableEvent: INTERNAL_OIDC_JWKS_UNAVAILABLE_EVENT,
      fetch,
    });

    expect(await verify(await fixture.mint())).toEqual({
      verdict: InternalOidcVerdict.Verified,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(log.error).not.toHaveBeenCalled();
  });
});

const INTERNAL_OIDC_JWKS_UNAVAILABLE_EVENT =
  "test.internal_oidc_jwks_unavailable";
const HS256_SECRET = "an-hmac-key-of-at-least-thirty-two-bytes";
const JWKS_FETCHED_AT = Date.UTC(2026, 9, 5, 12);
/** jose's `cooldownDuration` default, after which an unknown `kid` refetches. */
const JOSE_UNKNOWN_KID_COOLDOWN_MS = 30_000;
