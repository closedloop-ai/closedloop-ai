import { createPublicKey } from "node:crypto";

/**
 * Validates and canonicalizes a PEM-encoded Ed25519 SPKI public key.
 * Returns null when the input is not a usable Ed25519 public key.
 */
export function normalizeEd25519SpkiPublicKeyPem(pem: string): string | null {
  try {
    const key = createPublicKey(pem.trim());
    if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
      return null;
    }

    const normalized = key.export({
      format: "pem",
      type: "spki",
    });

    return `${normalized}`;
  } catch {
    return null;
  }
}
