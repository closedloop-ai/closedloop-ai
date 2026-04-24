/**
 * Unit tests for Ed25519 SPKI PEM validation.
 */
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeEd25519SpkiPublicKeyPem } from "../ed25519-spki-pem";

describe("normalizeEd25519SpkiPublicKeyPem", () => {
  it("accepts and normalizes a valid Ed25519 SPKI public key", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const pem = publicKey.export({ format: "pem", type: "spki" }).toString();

    expect(normalizeEd25519SpkiPublicKeyPem(pem)).toBe(pem);
  });

  it("rejects PEM input that is not an Ed25519 public key", () => {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = publicKey.export({ format: "pem", type: "spki" }).toString();

    expect(normalizeEd25519SpkiPublicKeyPem(pem)).toBeNull();
  });

  it("rejects malformed PEM data", () => {
    expect(normalizeEd25519SpkiPublicKeyPem("not-a-pem")).toBeNull();
  });
});
