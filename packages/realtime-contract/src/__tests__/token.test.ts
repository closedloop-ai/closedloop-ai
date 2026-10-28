import {
  decodeProtectedHeader,
  exportSPKI,
  generateKeyPair,
  SignJWT,
  UnsecuredJWT,
} from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RealtimeErrorCode } from "../error-codes";
import { type Grant, GrantAccess } from "../grants";
import {
  issueRealtimeToken,
  parseRealtimeTokenKmsKeyArn,
  REALTIME_TOKEN_AUDIENCE,
  REALTIME_TOKEN_ISSUER,
  REALTIME_TOKEN_TTL_SECONDS,
  RealtimeTokenError,
  type RealtimeTokenSigner,
  verifyRealtimeToken,
} from "../token";

const ORG = "0190f6a1-5b2c-7d3e-8f40-6a7b8c9d0e1f";
/** The shape of the retired REALTIME_TOKEN_SECRETS value (ISS-11966). */
const SHARED_SECRET = "current-secret-with-enough-entropy-0001";
const grants: Grant[] = [
  { pattern: `comments:${ORG}:*`, access: GrantAccess.Read },
];
const input = { sub: "user-1", org: ORG, grants };
const KID = "0b2c4d6e-1f3a-4b5c-8d7e-9f0a1b2c3d4e";
const UNKNOWN_KID = "9f8e7d6c-5b4a-4321-8fed-cba987654321";
const RSA_PAIR = await generateKeyPair("RS256");
const PUBLIC_KEYS = new Map([[KID, RSA_PAIR.publicKey]]);

function tokenError(code: RealtimeTokenError["code"]) {
  return { name: RealtimeTokenError.name, code };
}

function signRaw(payload: Record<string, unknown>): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setSubject("user-1")
    .setAudience(REALTIME_TOKEN_AUDIENCE)
    .setIssuer(REALTIME_TOKEN_ISSUER)
    .setIssuedAt()
    .setExpirationTime("10m")
    .setJti("jti-1")
    .sign(RSA_PAIR.privateKey);
}

/** Signed as apps/api signed before ISS-11966: HS256 with the shared secret. */
function signHs256(): Promise<string> {
  return new SignJWT({ org: ORG, grants })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("user-1")
    .setAudience(REALTIME_TOKEN_AUDIENCE)
    .setIssuer(REALTIME_TOKEN_ISSUER)
    .setIssuedAt()
    .setExpirationTime("10m")
    .setJti("jti-1")
    .sign(new TextEncoder().encode(SHARED_SECRET));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("issueRealtimeToken / verifyRealtimeToken", () => {
  it("signs, then verifies the claims", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T12:00:00.000Z"));
    const { token, expiresAt } = await issueRealtimeToken(input, {
      signer: rsaSigner(KID),
    });
    const nowSeconds = Math.floor(Date.now() / 1000);
    expect(expiresAt).toBe((nowSeconds + REALTIME_TOKEN_TTL_SECONDS) * 1000);
    const claims = await verifyRealtimeToken(token, {
      publicKeys: PUBLIC_KEYS,
    });
    expect(claims).toMatchObject({
      sub: input.sub,
      org: ORG,
      grants,
      aud: REALTIME_TOKEN_AUDIENCE,
      iss: REALTIME_TOKEN_ISSUER,
      iat: nowSeconds,
      exp: nowSeconds + REALTIME_TOKEN_TTL_SECONDS,
    });
    expect(claims.jti.length).toBeGreaterThan(0);
  });

  it("rejects malformed claims", async () => {
    const badGrants = await signRaw({
      org: ORG,
      grants: [{ pattern: "x", access: "admin" }],
    });
    const noOrg = await signRaw({ grants });
    for (const token of [badGrants, noOrg, "not.a.jwt"]) {
      await expect(
        verifyRealtimeToken(token, { publicKeys: PUBLIC_KEYS })
      ).rejects.toMatchObject(tokenError(RealtimeErrorCode.Unauthorized));
    }
  });

  it("refuses an HS256 token signed with the retired shared secret (ISS-11966)", async () => {
    const rs256 = await issueRealtimeToken(input, { signer: rsaSigner(KID) });

    expect(
      (await verifyRealtimeToken(rs256.token, { publicKeys: PUBLIC_KEYS })).org
    ).toBe(ORG);
    await expect(
      verifyRealtimeToken(await signHs256(), { publicKeys: PUBLIC_KEYS })
    ).rejects.toMatchObject(tokenError(RealtimeErrorCode.Unauthorized));
  });
});

describe("RS256 tokens signed by KMS (ISS-11966)", () => {
  it("verifies a token by the public key its kid names, and states that kid in the header", async () => {
    const { token } = await issueRealtimeToken(input, {
      signer: rsaSigner(KID),
    });

    expect(decodeProtectedHeader(token)).toEqual({ alg: "RS256", kid: KID });
    const claims = await verifyRealtimeToken(token, {
      publicKeys: PUBLIC_KEYS,
    });
    expect(claims).toMatchObject({ sub: input.sub, org: ORG, grants });
  });

  it("rejects a kid it has no key for, though another configured key would verify the signature", async () => {
    const { token } = await issueRealtimeToken(input, {
      signer: rsaSigner(UNKNOWN_KID),
    });

    await expect(
      verifyRealtimeToken(token, { publicKeys: PUBLIC_KEYS })
    ).rejects.toMatchObject(tokenError(RealtimeErrorCode.Unauthorized));
  });

  it.each([
    [
      "alg none",
      () =>
        Promise.resolve(
          new UnsecuredJWT({ org: ORG, grants })
            .setSubject("user-1")
            .setAudience(REALTIME_TOKEN_AUDIENCE)
            .setIssuer(REALTIME_TOKEN_ISSUER)
            .setIssuedAt()
            .setExpirationTime("10m")
            .setJti("jti-1")
            .encode()
        ),
    ],
    [
      "HS256 keyed with the public key under a configured kid",
      async () =>
        new SignJWT({ org: ORG, grants })
          .setProtectedHeader({ alg: "HS256", kid: KID })
          .setSubject("user-1")
          .setAudience(REALTIME_TOKEN_AUDIENCE)
          .setIssuer(REALTIME_TOKEN_ISSUER)
          .setIssuedAt()
          .setExpirationTime("10m")
          .setJti("jti-1")
          .sign(new TextEncoder().encode(await exportSPKI(RSA_PAIR.publicKey))),
    ],
    [
      "RS256 with no kid",
      () =>
        new SignJWT({ org: ORG, grants })
          .setProtectedHeader({ alg: "RS256" })
          .setSubject("user-1")
          .setAudience(REALTIME_TOKEN_AUDIENCE)
          .setIssuer(REALTIME_TOKEN_ISSUER)
          .setIssuedAt()
          .setExpirationTime("10m")
          .setJti("jti-1")
          .sign(RSA_PAIR.privateKey),
    ],
    [
      "RS256 for another audience",
      () => signRs256("elsewhere", REALTIME_TOKEN_ISSUER),
    ],
    [
      "RS256 from another issuer",
      () => signRs256(REALTIME_TOKEN_AUDIENCE, "elsewhere"),
    ],
  ])("refuses %s", async (_label, token) => {
    await expect(
      verifyRealtimeToken(await token(), { publicKeys: PUBLIC_KEYS })
    ).rejects.toMatchObject(tokenError(RealtimeErrorCode.Unauthorized));
  });

  it("rejects an expired RS256 token with token_expired", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T12:00:00.000Z"));
    const { token } = await issueRealtimeToken(input, {
      signer: rsaSigner(KID),
    });
    vi.setSystemTime(
      new Date(
        Date.parse("2026-10-05T12:00:00.000Z") +
          (REALTIME_TOKEN_TTL_SECONDS + 1) * 1000
      )
    );

    await expect(
      verifyRealtimeToken(token, { publicKeys: PUBLIC_KEYS })
    ).rejects.toMatchObject(tokenError(RealtimeErrorCode.TokenExpired));
  });
});

describe("parseRealtimeTokenKmsKeyArn", () => {
  it("reads a key ARN into the ARN, its region and the bare key ID as the kid", () => {
    const arn = `arn:aws:kms:eu-west-1:123456789012:key/${KID}`;

    expect(parseRealtimeTokenKmsKeyArn(arn)).toEqual({
      arn,
      region: "eu-west-1",
      kid: KID,
    });
  });

  it.each([
    ["a bare key ID, which names no region", KID],
    ["an alias", "alias/realtime-token"],
    ["an alias ARN", "arn:aws:kms:us-east-1:123456789012:alias/realtime-token"],
  ])("refuses %s", (_label, value) => {
    expect(parseRealtimeTokenKmsKeyArn(value)).toBeUndefined();
  });
});

function rsaSigner(kid: string): RealtimeTokenSigner {
  return {
    kid,
    sign: async (signingInput) =>
      new Uint8Array(
        await crypto.subtle.sign(
          "RSASSA-PKCS1-v1_5",
          RSA_PAIR.privateKey,
          new Uint8Array(signingInput)
        )
      ),
  };
}

function signRs256(audience: string, issuer: string): Promise<string> {
  return new SignJWT({ org: ORG, grants })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setSubject("user-1")
    .setAudience(audience)
    .setIssuer(issuer)
    .setIssuedAt()
    .setExpirationTime("10m")
    .setJti("jti-1")
    .sign(RSA_PAIR.privateKey);
}
