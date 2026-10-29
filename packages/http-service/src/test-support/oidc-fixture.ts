import {
  exportJWK,
  type FetchImplementation,
  generateKeyPair,
  type JWTPayload,
  SignJWT,
} from "jose";
import { vi } from "vitest";
import type { InternalOidcConfig } from "../internal-oidc";

/** ISS-11966 item 2: a local key pair and JWKS standing in for Vercel's issuer. */
export const OIDC_CONFIG: InternalOidcConfig = {
  issuer: "https://oidc.vercel.com/fixture-team",
  audience: "realtime-internal-fixture",
  ownerId: "team_fixture",
  projectId: "prj_fixture_api",
  environment: "production",
};

export const OIDC_JWKS_URL = `${OIDC_CONFIG.issuer}/.well-known/jwks`;

const KID = "fixture-key";

export type OidcFixture = {
  /** A token for {@link OIDC_CONFIG}, with any claim overridden; `exp: undefined` omits it. */
  mint: (overrides?: JWTPayload, key?: CryptoKey) => Promise<string>;
  /** Serves the fixture's JWKS, as Vercel's issuer would. */
  servingJwks: () => ReturnType<typeof vi.fn<FetchImplementation>>;
  /** A second key, under the same `kid`, that the JWKS does not hold. */
  otherKey: CryptoKey;
};

export async function createOidcFixture(): Promise<OidcFixture> {
  const signing = await generateKeyPair("RS256");
  const other = await generateKeyPair("RS256");
  const jwk = {
    ...(await exportJWK(signing.publicKey)),
    kid: KID,
    alg: "RS256",
  };
  return {
    otherKey: other.privateKey,
    mint: (overrides = {}, key = signing.privateKey) => {
      const jwt = new SignJWT({
        owner_id: OIDC_CONFIG.ownerId,
        project_id: OIDC_CONFIG.projectId,
        environment: OIDC_CONFIG.environment,
        ...overrides,
      })
        .setProtectedHeader({ alg: "RS256", kid: KID, typ: "JWT" })
        .setIssuer(String(overrides.iss ?? OIDC_CONFIG.issuer))
        .setAudience(overrides.aud ?? OIDC_CONFIG.audience)
        .setIssuedAt();
      return ("exp" in overrides ? jwt : jwt.setExpirationTime("1h")).sign(key);
    },
    servingJwks: () =>
      vi.fn<FetchImplementation>(() =>
        Promise.resolve(Response.json({ keys: [jwk] }))
      ),
  };
}
