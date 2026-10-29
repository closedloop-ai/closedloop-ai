import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
import { getAwsCredentials } from "@repo/aws/credentials";
import {
  boundedRequestHandler,
  CONTROL_PLANE_BOUNDS,
} from "@repo/aws/request-handler";

/**
 * KMS envelope encryption for secrets at rest (ISS-8007).
 *
 * Extracted from the former Anthropic API key service when the Pensero
 * credential became the second secret needing it. Two copies of a `KMSClient` singleton,
 * an ARN check, and a pair of encrypt/decrypt calls is exactly the drift that
 * ends with one secret losing its encryption context or its empty-result guard
 * in a later edit — so there is one implementation, parameterized by purpose.
 */

/**
 * The KMS encryption context a secret is bound to. It is authenticated
 * additional data, NOT a secret: a ciphertext sealed under one purpose cannot
 * be decrypted under another, so a confused-deputy read that hands one
 * purpose's ciphertext to another purpose's path fails closed instead of
 * returning bytes.
 *
 * Values are frozen strings — changing one strands every ciphertext already
 * written under the old value.
 */
export const KmsSecretPurpose = {
  /** Per-org Pensero delivery-metrics credential (`pensero-integration-service.ts`). */
  PenseroApiToken: "pensero-api-token",
} as const;
export type KmsSecretPurpose =
  (typeof KmsSecretPurpose)[keyof typeof KmsSecretPurpose];

let cachedClient: KMSClient | null = null;

function getKmsClient(): KMSClient {
  if (!cachedClient) {
    cachedClient = new KMSClient({
      region: process.env.AWS_REGION ?? "us-east-1",
      credentials: getAwsCredentials(),
      // Secret encrypt/decrypt is awaited on the request path.
      requestHandler: boundedRequestHandler(CONTROL_PLANE_BOUNDS),
    });
  }
  return cachedClient;
}

function requireKmsKeyArn(): string {
  const arn = process.env.KMS_KEY_ARN;
  if (!arn) {
    throw new Error("KMS_KEY_ARN is not configured");
  }
  return arn;
}

/** Encrypt `plaintext` under `purpose`, returning base64 ciphertext. */
export async function encryptSecret(
  plaintext: string,
  purpose: KmsSecretPurpose
): Promise<string> {
  const result = await getKmsClient().send(
    new EncryptCommand({
      KeyId: requireKmsKeyArn(),
      Plaintext: Buffer.from(plaintext, "utf-8"),
      EncryptionContext: { purpose },
    })
  );

  if (!result.CiphertextBlob) {
    throw new Error("KMS encryption failed: empty ciphertext");
  }

  return Buffer.from(result.CiphertextBlob).toString("base64");
}

/**
 * How much of a secret may be shown back to a client: the last four characters,
 * as a FINGERPRINT for telling one credential from another. Never a prefix —
 * a leading slice of `sk_...` narrows the secret, a trailing slice does not.
 *
 * One definition so every settings surface reveals the same amount. Widening
 * this widens disclosure everywhere at once, which is the point.
 */
export function secretLastFour(secret: string): string {
  return secret.slice(-4);
}

/** Decrypt base64 `ciphertext` sealed under `purpose`. */
export async function decryptSecret(
  ciphertext: string,
  purpose: KmsSecretPurpose
): Promise<string> {
  const result = await getKmsClient().send(
    new DecryptCommand({
      CiphertextBlob: Buffer.from(ciphertext, "base64"),
      EncryptionContext: { purpose },
    })
  );

  if (!result.Plaintext) {
    throw new Error("KMS decryption failed: empty plaintext");
  }

  return Buffer.from(result.Plaintext).toString("utf-8");
}
