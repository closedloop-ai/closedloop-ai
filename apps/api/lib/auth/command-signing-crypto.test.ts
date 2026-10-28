import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createEd25519PublicKeyFromRaw,
  decodeCommandPublicKeyBase64,
  fingerprintCommandPublicKey,
  isCommandPublicKeyFingerprint,
  validateCommandPublicKeyRegistration,
} from "./command-signing-crypto";

const FINGERPRINT_REGEX = /^cl:[A-Za-z0-9_-]{22}$/;
const keypair = generateKeyPairSync("ed25519");
const VALID_RAW = keypair.publicKey
  .export({ type: "spki", format: "der" })
  .subarray(12);
const VALID_B64 = VALID_RAW.toString("base64");
const VALID_FINGERPRINT = `cl:${createHash("sha256").update(VALID_RAW).digest("base64url").slice(0, 22)}`;

describe("fingerprintCommandPublicKey", () => {
  it("produces a cl:-prefixed 22-char base64url digest", () => {
    const fp = fingerprintCommandPublicKey(VALID_RAW);
    expect(fp).toMatch(FINGERPRINT_REGEX);
  });

  it("is deterministic for the same key", () => {
    expect(fingerprintCommandPublicKey(VALID_RAW)).toBe(
      fingerprintCommandPublicKey(VALID_RAW)
    );
  });

  it("differs for different keys", () => {
    const other = generateKeyPairSync("ed25519")
      .publicKey.export({ type: "spki", format: "der" })
      .subarray(12);
    expect(fingerprintCommandPublicKey(VALID_RAW)).not.toBe(
      fingerprintCommandPublicKey(other)
    );
  });
});

describe("isCommandPublicKeyFingerprint", () => {
  it("accepts a valid fingerprint", () => {
    expect(isCommandPublicKeyFingerprint(VALID_FINGERPRINT)).toBe(true);
  });

  it("rejects missing prefix", () => {
    expect(isCommandPublicKeyFingerprint("84K6BFfuNL1bhYU5WQtaIj")).toBe(false);
  });

  it("rejects wrong length", () => {
    expect(isCommandPublicKeyFingerprint("cl:short")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isCommandPublicKeyFingerprint("")).toBe(false);
  });
});

describe("decodeCommandPublicKeyBase64", () => {
  it("decodes a valid 32-byte Ed25519 public key", () => {
    const result = decodeCommandPublicKeyBase64(VALID_B64);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(32);
  });

  it("returns null for non-base64 input", () => {
    expect(decodeCommandPublicKeyBase64("not!valid!base64")).toBeNull();
  });

  it("returns null for wrong-length key", () => {
    const short = Buffer.alloc(16).toString("base64");
    expect(decodeCommandPublicKeyBase64(short)).toBeNull();
  });

  it("trims whitespace before decoding", () => {
    const result = decodeCommandPublicKeyBase64(`  ${VALID_B64}  `);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(32);
  });

  it("returns null for empty string", () => {
    expect(decodeCommandPublicKeyBase64("")).toBeNull();
  });
});

describe("createEd25519PublicKeyFromRaw", () => {
  it("creates a KeyObject from valid 32-byte raw key", () => {
    const key = createEd25519PublicKeyFromRaw(VALID_RAW);
    expect(key).not.toBeNull();
    expect(key!.type).toBe("public");
    expect(key!.asymmetricKeyType).toBe("ed25519");
  });

  it("returns null for wrong-length input", () => {
    expect(createEd25519PublicKeyFromRaw(Buffer.alloc(16))).toBeNull();
  });

  it("returns null for empty buffer", () => {
    expect(createEd25519PublicKeyFromRaw(Buffer.alloc(0))).toBeNull();
  });
});

describe("validateCommandPublicKeyRegistration", () => {
  it("validates a correct registration", () => {
    const result = validateCommandPublicKeyRegistration({
      publicKeyBase64: VALID_B64,
      fingerprint: VALID_FINGERPRINT,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fingerprint).toBe(VALID_FINGERPRINT);
      expect(result.rawPublicKey.length).toBe(32);
      expect(result.publicKey.type).toBe("public");
    }
  });

  it("rejects malformed base64", () => {
    const result = validateCommandPublicKeyRegistration({
      publicKeyBase64: "not-valid",
      fingerprint: VALID_FINGERPRINT,
    });
    expect(result).toEqual({ ok: false, reason: "malformed_public_key" });
  });

  it("rejects malformed fingerprint format", () => {
    const result = validateCommandPublicKeyRegistration({
      publicKeyBase64: VALID_B64,
      fingerprint: "bad-fingerprint",
    });
    expect(result).toEqual({ ok: false, reason: "malformed_public_key" });
  });

  it("rejects fingerprint mismatch", () => {
    const other = generateKeyPairSync("ed25519")
      .publicKey.export({ type: "spki", format: "der" })
      .subarray(12);
    const otherFp = `cl:${createHash("sha256").update(other).digest("base64url").slice(0, 22)}`;
    const result = validateCommandPublicKeyRegistration({
      publicKeyBase64: VALID_B64,
      fingerprint: otherFp,
    });
    expect(result).toEqual({ ok: false, reason: "fingerprint_mismatch" });
  });

  it("rejects a fingerprint with surrounding whitespace", () => {
    const result = validateCommandPublicKeyRegistration({
      publicKeyBase64: VALID_B64,
      fingerprint: `  ${VALID_FINGERPRINT}  `,
    });
    // The fingerprint pattern check happens BEFORE the trim comparison,
    // so leading/trailing whitespace fails the pattern and returns malformed.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("malformed_public_key");
    }
  });
});
