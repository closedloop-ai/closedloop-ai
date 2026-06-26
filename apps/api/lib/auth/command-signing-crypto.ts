import { createHash, createPublicKey, type KeyObject } from "node:crypto";

const ED25519_RAW_PUBLIC_KEY_LENGTH = 32;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const COMMAND_PUBLIC_KEY_FINGERPRINT_PREFIX = "cl:";
const PUBLIC_KEY_BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const FINGERPRINT_PATTERN = /^cl:[A-Za-z0-9_-]{22}$/;

export type CommandPublicKeyValidationResult =
  | {
      ok: true;
      rawPublicKey: Buffer;
      publicKey: KeyObject;
      fingerprint: string;
    }
  | {
      ok: false;
      reason:
        | "malformed_public_key"
        | "unsupported_public_key"
        | "fingerprint_mismatch";
    };

/**
 * Derives the stable browser/user command-signing public-key fingerprint.
 * Only raw Ed25519 public keys are accepted for this command authorization
 * boundary; Desktop PoP PEM keys are intentionally not reused here.
 */
export function fingerprintCommandPublicKey(rawPublicKey: Uint8Array): string {
  const digest = createHash("sha256").update(rawPublicKey).digest("base64url");
  return `${COMMAND_PUBLIC_KEY_FINGERPRINT_PREFIX}${digest.slice(0, 22)}`;
}

export function isCommandPublicKeyFingerprint(value: string): boolean {
  return FINGERPRINT_PATTERN.test(value);
}

export function decodeCommandPublicKeyBase64(value: string): Buffer | null {
  const trimmed = value.trim();
  if (!PUBLIC_KEY_BASE64_PATTERN.test(trimmed)) {
    return null;
  }
  try {
    const decoded = Buffer.from(trimmed, "base64");
    return decoded.length === ED25519_RAW_PUBLIC_KEY_LENGTH ? decoded : null;
  } catch {
    return null;
  }
}

export function createEd25519PublicKeyFromRaw(
  rawPublicKey: Uint8Array
): KeyObject | null {
  if (rawPublicKey.byteLength !== ED25519_RAW_PUBLIC_KEY_LENGTH) {
    return null;
  }
  try {
    return createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(rawPublicKey)]),
      format: "der",
      type: "spki",
    });
  } catch {
    return null;
  }
}

/**
 * Validates a registered browser public key and confirms the supplied
 * fingerprint is derived from the raw public key bytes.
 */
export function validateCommandPublicKeyRegistration(input: {
  publicKeyBase64: string;
  fingerprint: string;
}): CommandPublicKeyValidationResult {
  const rawPublicKey = decodeCommandPublicKeyBase64(input.publicKeyBase64);
  if (!(rawPublicKey && isCommandPublicKeyFingerprint(input.fingerprint))) {
    return { ok: false, reason: "malformed_public_key" };
  }

  const fingerprint = fingerprintCommandPublicKey(rawPublicKey);
  if (fingerprint !== input.fingerprint.trim()) {
    return { ok: false, reason: "fingerprint_mismatch" };
  }

  const publicKey = createEd25519PublicKeyFromRaw(rawPublicKey);
  if (!publicKey) {
    return { ok: false, reason: "unsupported_public_key" };
  }

  return { ok: true, rawPublicKey, publicKey, fingerprint };
}
