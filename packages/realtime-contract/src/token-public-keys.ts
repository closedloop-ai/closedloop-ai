import { createPublicKey, type KeyObject } from "node:crypto";
import { z } from "zod";
import { REALTIME_TOKEN_KID, type RealtimeTokenPublicKeys } from "./token";

const MIN_RSA_MODULUS_BITS = 2048;

export function parseRealtimeTokenPublicKeys(
  raw: string | undefined
): RealtimeTokenPublicKeys | undefined {
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  const pems = publicKeyPemsSchema.safeParse(parseJson(raw));
  if (!pems.success || Object.keys(pems.data).length === 0) {
    throw new Error(
      "REALTIME_TOKEN_PUBLIC_KEYS must be a JSON object mapping each kid to an SPKI PEM public key"
    );
  }
  return new Map(
    Object.entries(pems.data).map(([kid, pem]) => [
      bareKeyId(kid),
      rsaPublicKey(pem),
    ])
  );
}

function bareKeyId(kid: string): string {
  if (!REALTIME_TOKEN_KID.test(kid)) {
    throw new Error(
      "REALTIME_TOKEN_PUBLIC_KEYS must be keyed by the bare KMS key ID, which is the token's kid"
    );
  }
  return kid;
}

const publicKeyPemsSchema = z.record(z.string().min(1), z.string().min(1));

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function rsaPublicKey(pem: string): KeyObject {
  // createPublicKey derives the public half of a private key; refuse one
  // rather than hold a signing key in this service's env.
  if (pem.includes(PRIVATE_KEY_PEM_LABEL)) {
    throw new Error(
      "REALTIME_TOKEN_PUBLIC_KEYS has a private key entry; it takes public keys only"
    );
  }
  let key: KeyObject;
  try {
    key = createPublicKey(pem);
  } catch {
    throw new Error(
      "REALTIME_TOKEN_PUBLIC_KEYS has an entry that is not a PEM public key"
    );
  }
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (key.asymmetricKeyType !== "rsa" || bits < MIN_RSA_MODULUS_BITS) {
    throw new Error(
      `REALTIME_TOKEN_PUBLIC_KEYS entries must be RSA keys of at least ${MIN_RSA_MODULUS_BITS} bits`
    );
  }
  return key;
}

const PRIVATE_KEY_PEM_LABEL = "PRIVATE KEY";
