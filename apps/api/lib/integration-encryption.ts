import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
import { getAwsCredentials } from "@repo/aws/credentials";
import {
  boundedRequestHandler,
  CONTROL_PLANE_BOUNDS,
} from "@repo/aws/request-handler";

// TODO: Before first production backfill, consider adding integration-type
// (e.g., "google" or "linear") to the encryption context for finer-grained
// cryptographic separation. Changing the context after data is encrypted would
// make existing ciphertexts unreadable, so this must happen before any rows
// are backfilled.
const INTEGRATION_ENCRYPTION_CONTEXT = {
  purpose: "integration-token",
} as const;

let _kmsClient: KMSClient | null = null;

function getKmsClient(): KMSClient {
  if (!_kmsClient) {
    _kmsClient = new KMSClient({
      region: process.env.AWS_REGION ?? "us-east-1",
      credentials: getAwsCredentials(),
      // Every integration token read goes through here on the request path
      // (`integrations/*/service.ts`), so a hung socket must not outlive the
      // caller's deadline.
      requestHandler: boundedRequestHandler(CONTROL_PLANE_BOUNDS),
    });
  }
  return _kmsClient;
}

function requireKmsKeyArn(): string {
  const arn = process.env.KMS_KEY_ARN;
  if (!arn) {
    throw new Error("KMS_KEY_ARN is not configured");
  }
  return arn;
}

/**
 * Encrypts an integration token using AWS KMS with an integration-specific
 * encryption context. Returns a base64-encoded ciphertext string.
 */
export async function encryptIntegrationToken(token: string): Promise<string> {
  const result = await getKmsClient().send(
    new EncryptCommand({
      KeyId: requireKmsKeyArn(),
      Plaintext: Buffer.from(token, "utf-8"),
      EncryptionContext: INTEGRATION_ENCRYPTION_CONTEXT,
    })
  );

  if (!result.CiphertextBlob) {
    throw new Error("KMS encryption failed: empty ciphertext");
  }

  return Buffer.from(result.CiphertextBlob).toString("base64");
}

/**
 * Decrypts a base64-encoded integration token ciphertext using AWS KMS.
 * Requires the same integration-specific encryption context used during encryption.
 */
export async function decryptIntegrationToken(
  encrypted: string
): Promise<string> {
  const result = await getKmsClient().send(
    new DecryptCommand({
      CiphertextBlob: Buffer.from(encrypted, "base64"),
      EncryptionContext: INTEGRATION_ENCRYPTION_CONTEXT,
    })
  );

  if (!result.Plaintext) {
    throw new Error("KMS decryption failed: empty plaintext");
  }

  return Buffer.from(result.Plaintext).toString("utf-8");
}

/**
 * Encrypts an access token and optional refresh token in parallel.
 * Returns the encrypted values in a named object for clarity at the call site.
 */
export async function encryptTokenPair(
  accessToken: string,
  refreshToken: string | null | undefined
): Promise<{
  encryptedAccessToken: string;
  encryptedRefreshToken: string | null;
}> {
  const [encryptedAccessToken, encryptedRefreshToken] = await Promise.all([
    encryptIntegrationToken(accessToken),
    refreshToken
      ? encryptIntegrationToken(refreshToken)
      : Promise.resolve(null),
  ]);
  return { encryptedAccessToken, encryptedRefreshToken };
}

/**
 * The token columns an integration write stores: ciphertext only.
 *
 * The refresh half is OPTIONAL, and omission is load-bearing. A provider that
 * issues no new refresh token on a refresh (Google's ordinary behaviour) must
 * leave the stored one where it is; writing `null` there would delete the
 * organization's only means of refreshing. Absent keys mean "do not touch",
 * which is what Prisma does with `undefined`.
 */
export type IntegrationTokenColumns = {
  accessTokenEncrypted: string;
  refreshTokenEncrypted?: string;
};

/**
 * Build the token columns for a Google or Linear connect or refresh — the ONE
 * function every write path routes through.
 *
 * ISS-5081 removed the fallback that stored plaintext when encryption failed: a
 * failed encrypt THROWS and the caller's write fails, matching the GitHub
 * user-token cutover, whose connect never persisted a credential it could not
 * encrypt. A write that cannot encrypt stores nothing rather than a plaintext
 * credential.
 *
 * `refreshToken` is the refresh token the provider issued, if any. When it is
 * absent (a Google refresh or reconnect ordinarily reissues none) the refresh
 * column is omitted, so the stored ciphertext is left untouched.
 */
export async function buildIntegrationTokenColumns(
  accessToken: string,
  refreshToken: string | null | undefined
): Promise<IntegrationTokenColumns> {
  const { encryptedAccessToken, encryptedRefreshToken } =
    await encryptTokenPair(accessToken, refreshToken);
  return {
    accessTokenEncrypted: encryptedAccessToken,
    ...(encryptedRefreshToken === null
      ? {}
      : { refreshTokenEncrypted: encryptedRefreshToken }),
  };
}

/**
 * Resolves a Google or Linear token from its ciphertext alone, or null when the
 * row has none. ISS-11096 dropped their plaintext columns, so a row without
 * ciphertext has no token: it resolves to null and its caller fails the read.
 * The `integration_tokens_unencrypted` gauge counts such rows.
 */
export function resolveEncryptedIntegrationToken(
  encrypted: string | null
): Promise<string | null> {
  return encrypted ? decryptIntegrationToken(encrypted) : Promise.resolve(null);
}
