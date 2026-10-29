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

/**
 * The API stores the device key as an SPKI PEM (`createEd25519PublicKey` in
 * desktop-pop-utils.ts parses it); a Desktop's auth material carries the same
 * SPKI as base64 DER. Rejects anything that is not an Ed25519 public key, since
 * a wrong key would only surface later as a `pop_failed` refresh.
 */
export function ed25519SpkiBase64ToPem(spkiBase64: string): string {
  const key = createPublicKey({
    key: Buffer.from(spkiBase64, "base64"),
    format: "der",
    type: "spki",
  });
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(
      `publicKeySpki is a ${String(key.asymmetricKeyType)} key, expected ed25519`
    );
  }
  return key.export({ format: "pem", type: "spki" }).toString();
}
