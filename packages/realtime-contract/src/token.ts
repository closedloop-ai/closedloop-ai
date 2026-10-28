import {
  base64url,
  type CryptoKey,
  decodeProtectedHeader,
  errors,
  jwtVerify,
  type KeyObject,
} from "jose";
import { z } from "zod";
import { RealtimeErrorCode } from "./error-codes";
import { type Grant, grantSchema } from "./grants";
import type { IssuedRealtimeToken } from "./protocol";

export const REALTIME_TOKEN_AUDIENCE = "closedloop-realtime";
export const REALTIME_TOKEN_ISSUER = "closedloop-api";
export const REALTIME_TOKEN_TTL_SECONDS = 600;

export const realtimeTokenClaimsSchema = z.object({
  sub: z.string().min(1),
  org: z.string().min(1),
  grants: z.array(grantSchema),
  exp: z.number().int(),
  iat: z.number().int(),
  jti: z.string().min(1),
  aud: z.literal(REALTIME_TOKEN_AUDIENCE),
  iss: z.literal(REALTIME_TOKEN_ISSUER),
});
export type RealtimeTokenClaims = z.infer<typeof realtimeTokenClaimsSchema>;

export type RealtimeTokenInput = {
  sub: string;
  org: string;
  grants: readonly Grant[];
};

/** RS256 only: the HS256 shared secret is retired (ISS-11966). */
export type RealtimeTokenIssueOptions = { signer: RealtimeTokenSigner };

/** A token verifies only as RS256, against the public key its `kid` names (ISS-11966). */
export type RealtimeTokenVerifyOptions = {
  publicKeys: RealtimeTokenPublicKeys;
};

export class RealtimeTokenError extends Error {
  readonly code:
    | typeof RealtimeErrorCode.Unauthorized
    | typeof RealtimeErrorCode.TokenExpired;

  constructor(
    code:
      | typeof RealtimeErrorCode.Unauthorized
      | typeof RealtimeErrorCode.TokenExpired
  ) {
    super(`Realtime token rejected: ${code}`);
    this.name = "RealtimeTokenError";
    this.code = code;
  }
}

export async function issueRealtimeToken(
  claims: RealtimeTokenInput,
  opts: RealtimeTokenIssueOptions
): Promise<IssuedRealtimeToken> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAtSeconds = issuedAt + REALTIME_TOKEN_TTL_SECONDS;
  const payload = {
    org: claims.org,
    grants: claims.grants,
    sub: claims.sub,
    aud: REALTIME_TOKEN_AUDIENCE,
    iss: REALTIME_TOKEN_ISSUER,
    iat: issuedAt,
    exp: expiresAtSeconds,
    jti: crypto.randomUUID(),
  };
  const token = await signWithSigner(payload, opts.signer);
  return { token, expiresAt: expiresAtSeconds * 1000 };
}

/**
 * Verifies signature, algorithm, audience, issuer and expiry, and rejects a
 * token whose claims are malformed rather than half-reading it. Throws
 * `RealtimeTokenError` carrying `token_expired` or `unauthorized`.
 */
export async function verifyRealtimeToken(
  token: string,
  opts: RealtimeTokenVerifyOptions
): Promise<RealtimeTokenClaims> {
  const claims = realtimeTokenClaimsSchema.safeParse(
    await verifiedPayload(token, opts)
  );
  if (!claims.success) {
    throw new RealtimeTokenError(RealtimeErrorCode.Unauthorized);
  }
  return claims.data;
}

const UTF8_ENCODER = new TextEncoder();

/** Any algorithm but RS256, an HS256 token among them, is refused before a key is looked up. */
async function verifiedPayload(
  token: string,
  opts: RealtimeTokenVerifyOptions
): Promise<unknown> {
  const header = readProtectedHeader(token);
  const key =
    header.alg === REALTIME_TOKEN_KMS_ALGORITHM && header.kid !== undefined
      ? opts.publicKeys.get(header.kid)
      : undefined;
  if (key === undefined) {
    throw new RealtimeTokenError(RealtimeErrorCode.Unauthorized);
  }
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: [REALTIME_TOKEN_KMS_ALGORITHM],
      audience: REALTIME_TOKEN_AUDIENCE,
      issuer: REALTIME_TOKEN_ISSUER,
    });
    return payload;
  } catch (error) {
    throw new RealtimeTokenError(
      error instanceof errors.JWTExpired
        ? RealtimeErrorCode.TokenExpired
        : RealtimeErrorCode.Unauthorized
    );
  }
}

/** What KMS signs with: `RSASSA_PKCS1_V1_5_SHA_256` over the JWS signing input (ISS-11966). */
export const REALTIME_TOKEN_KMS_ALGORITHM = "RS256";

/** An RSA public key, as Node's `createPublicKey` or Web Crypto returns one. */
export type RealtimeTokenPublicKey = KeyObject | CryptoKey;

/** RS256 verification keys by `kid`, the ID of the KMS key that signs (ISS-11827). */
export type RealtimeTokenPublicKeys = ReadonlyMap<
  string,
  RealtimeTokenPublicKey
>;

/**
 * Signs outside this package: `sign` returns the RSASSA-PKCS1-v1_5 SHA-256
 * signature of the JWS signing input, and `kid` names the key it used.
 */
export type RealtimeTokenSigner = {
  kid: string;
  sign: (signingInput: Uint8Array) => Promise<Uint8Array>;
};

const KMS_KEY_ID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|mrk-[0-9a-f]{32}";

export const REALTIME_TOKEN_KID = new RegExp(`^(?:${KMS_KEY_ID_PATTERN})$`);
const KMS_KEY_ARN = new RegExp(
  String.raw`^arn:aws[\w-]*:kms:([\w-]+):\d{12}:key/(${KMS_KEY_ID_PATTERN})$`
);

/** The KMS key that signs, with the region its ARN names and the `kid` it signs as. */
export type RealtimeTokenKmsKey = { arn: string; region: string; kid: string };

/**
 * Reads a KMS key ARN. A bare key ID names no region and an alias names no
 * fixed key, so neither parses (ISS-11966 review, thread on #8400).
 */
export function parseRealtimeTokenKmsKeyArn(
  value: string
): RealtimeTokenKmsKey | undefined {
  const match = KMS_KEY_ARN.exec(value);
  return match ? { arn: value, region: match[1], kid: match[2] } : undefined;
}

async function signWithSigner(
  payload: object,
  signer: RealtimeTokenSigner
): Promise<string> {
  const header = { alg: REALTIME_TOKEN_KMS_ALGORITHM, kid: signer.kid };
  const signingInput = `${encodeSegment(header)}.${encodeSegment(payload)}`;
  const signature = await signer.sign(UTF8_ENCODER.encode(signingInput));
  return `${signingInput}.${base64url.encode(signature)}`;
}

function encodeSegment(value: object): string {
  return base64url.encode(JSON.stringify(value));
}

function readProtectedHeader(token: string) {
  try {
    return decodeProtectedHeader(token);
  } catch {
    throw new RealtimeTokenError(RealtimeErrorCode.Unauthorized);
  }
}
