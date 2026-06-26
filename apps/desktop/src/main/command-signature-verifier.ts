import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import { stableStringify } from "@closedloop-ai/loops-api/stable-stringify";
import {
  COMMAND_SIGNING_REJECTION_REASONS,
  type CommandSigningRejectionReason,
} from "../shared/contracts.js";
import type { AuthorizedCommandKeyStore } from "./authorized-command-key-store.js";
import type { DesktopCommandEvent } from "./cloud-protocol.js";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const MAX_SIGNATURE_AGE_SECONDS = 45;
const MAX_SIGNATURE_FUTURE_SKEW_SECONDS = 5;

export type CommandSignatureVerificationResult =
  | { ok: true }
  | { ok: false; reason: CommandSigningRejectionReason };

export type CommandSignatureVerifierOptions = {
  authorizedKeys: AuthorizedCommandKeyStore;
  now?: () => Date;
};

type SignaturePayload = {
  commandId: string;
  method: string;
  path: string;
  query: [string, string][];
  bodyHash: string;
  timestamp: number;
  nonce: string;
};

/**
 * Verifies browser-origin Ed25519 command signatures against locally
 * authorized public keys. The verifier is synchronous and never logs signature
 * material or private key data.
 */
export class CommandSignatureVerifier {
  private readonly authorizedKeys: AuthorizedCommandKeyStore;
  private readonly now: () => Date;
  private readonly seenNonces = new Map<string, number>();

  constructor(options: CommandSignatureVerifierOptions) {
    this.authorizedKeys = options.authorizedKeys;
    this.now = options.now ?? (() => new Date());
  }

  verify(
    command: DesktopCommandEvent,
    bodyOverride?: unknown
  ): CommandSignatureVerificationResult {
    if (this.authorizedKeys.list().length === 0) {
      return {
        ok: false,
        reason: COMMAND_SIGNING_REJECTION_REASONS.noKeysAuthorized,
      };
    }

    if (
      !(
        command.signature &&
        command.signaturePayload &&
        command.publicKeyFingerprint
      )
    ) {
      return {
        ok: false,
        reason: COMMAND_SIGNING_REJECTION_REASONS.unsignedCommand,
      };
    }

    const key = this.authorizedKeys.get(command.publicKeyFingerprint);
    if (!key) {
      return {
        ok: false,
        reason: COMMAND_SIGNING_REJECTION_REASONS.unknownSigningKey,
      };
    }

    let payload: SignaturePayload;
    let signature: Buffer;
    try {
      payload = JSON.parse(command.signaturePayload) as SignaturePayload;
      signature = Buffer.from(command.signature, "base64");
    } catch {
      return {
        ok: false,
        reason: COMMAND_SIGNING_REJECTION_REASONS.invalidSignature,
      };
    }

    if (!isSignaturePayload(payload)) {
      return {
        ok: false,
        reason: COMMAND_SIGNING_REJECTION_REASONS.invalidSignature,
      };
    }

    const nowSeconds = Math.floor(this.now().getTime() / 1000);
    this.pruneSeenNonces(nowSeconds);
    if (
      nowSeconds - payload.timestamp > MAX_SIGNATURE_AGE_SECONDS ||
      payload.timestamp - nowSeconds > MAX_SIGNATURE_FUTURE_SKEW_SECONDS
    ) {
      return {
        ok: false,
        reason: COMMAND_SIGNING_REJECTION_REASONS.staleOrReplayedCommand,
      };
    }

    if (
      payload.commandId !== command.commandId ||
      payload.method !== command.method.toUpperCase() ||
      payload.path !== command.path ||
      stableStringify(payload.query) !==
        stableStringify(canonicalQuery(command.query)) ||
      payload.bodyHash !== hashCommandBody(bodyOverride ?? command.body)
    ) {
      return {
        ok: false,
        reason: COMMAND_SIGNING_REJECTION_REASONS.payloadMismatch,
      };
    }

    const nonceKey = `${command.publicKeyFingerprint}:${payload.nonce}`;
    if (this.seenNonces.has(nonceKey)) {
      return {
        ok: false,
        reason: COMMAND_SIGNING_REJECTION_REASONS.staleOrReplayedCommand,
      };
    }

    try {
      const publicKey = createPublicKey({
        key: Buffer.concat([
          ED25519_SPKI_PREFIX,
          Buffer.from(key.publicKeyBase64, "base64"),
        ]),
        format: "der",
        type: "spki",
      });
      const valid = verifySignature(
        null,
        Buffer.from(command.signaturePayload, "utf8"),
        publicKey,
        signature
      );
      if (!valid) {
        return {
          ok: false,
          reason: COMMAND_SIGNING_REJECTION_REASONS.invalidSignature,
        };
      }
      this.seenNonces.set(nonceKey, payload.timestamp);
      return { ok: true };
    } catch {
      return {
        ok: false,
        reason: COMMAND_SIGNING_REJECTION_REASONS.invalidSignature,
      };
    }
  }

  private pruneSeenNonces(nowSeconds: number): void {
    const cutoff = nowSeconds - MAX_SIGNATURE_AGE_SECONDS;
    for (const [nonceKey, timestamp] of this.seenNonces.entries()) {
      if (timestamp < cutoff) {
        this.seenNonces.delete(nonceKey);
      }
    }
  }
}

function isSignaturePayload(value: unknown): value is SignaturePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const payload = value as SignaturePayload;
  return (
    typeof payload.commandId === "string" &&
    typeof payload.method === "string" &&
    typeof payload.path === "string" &&
    Array.isArray(payload.query) &&
    payload.query.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === "string" &&
        typeof entry[1] === "string"
    ) &&
    typeof payload.bodyHash === "string" &&
    typeof payload.timestamp === "number" &&
    Number.isSafeInteger(payload.timestamp) &&
    typeof payload.nonce === "string"
  );
}

function canonicalQuery(
  query: DesktopCommandEvent["query"]
): [string, string][] {
  if (!query) {
    return [];
  }
  const entries: [string, string][] = [];
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        entries.push([key, item]);
      }
      continue;
    }
    entries.push([key, value]);
  }
  return entries.sort(([aKey, aValue], [bKey, bValue]) =>
    aKey === bKey ? aValue.localeCompare(bValue) : aKey.localeCompare(bKey)
  );
}

function hashCommandBody(body: unknown): string {
  return createHash("sha256")
    .update(stableStringify(body ?? null))
    .digest("base64url");
}
