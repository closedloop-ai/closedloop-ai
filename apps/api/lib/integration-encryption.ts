import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
import { getAwsCredentials } from "@repo/aws/credentials";

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
 * Resolves an integration token by decrypting the encrypted form if present,
 * or returning the plaintext fallback. Returns null if neither is available.
 */
export function resolveIntegrationToken(
  encrypted: string | null | undefined,
  plaintext: string | null
): Promise<string | null> {
  if (encrypted) {
    return decryptIntegrationToken(encrypted);
  }
  return Promise.resolve(plaintext);
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
