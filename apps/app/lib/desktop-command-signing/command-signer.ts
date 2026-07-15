"use client";

import { stableStringify } from "@closedloop-ai/loops-api/stable-stringify";
import {
  CURRENT_DESKTOP_API_NAMESPACE,
  getDesktopApiNamespaceFromCapabilities,
  rewriteDesktopApiPath,
} from "@repo/api/src/desktop-api-namespace";
import type { JsonValue } from "@repo/api/src/types/common";
import type {
  BrowserSignedCommandId,
  CommandSignatureFields,
  ComputeTarget,
} from "@repo/api/src/types/compute-target";
import { COMMAND_SIGNING_CAPABILITY_KEY } from "@repo/api/src/types/compute-target";
import { bytesToBase64, bytesToBase64Url } from "./crypto-utils";
import { getStoredBrowserSigningKey } from "./key-store";

/**
 * Minimal compute-target capability view needed for browser-side signing.
 * Both the Desktop-local capability and server-side eligibility signal must be
 * explicit; rollout flag names are not accepted as browser capability keys.
 */
export type SigningTarget = Pick<
  ComputeTarget,
  "capabilities" | "serverCapabilities"
>;

/** Relay request fields included in the canonical user-intent signature. */
export type SignableRelayRequest = {
  method: string;
  pathWithQuery: string;
  body: JsonValue | undefined;
};

/** Signed command envelope forwarded through app relay routes to Desktop/API. */
export type SignedDesktopCommand = CommandSignatureFields & {
  commandId: BrowserSignedCommandId;
  path: string;
  query?: Record<string, string | string[]>;
};

type CanonicalPayload = {
  commandId: string;
  method: string;
  path: string;
  query: [string, string][];
  bodyHash: string;
  timestamp: number;
  nonce: string;
};

function splitPathAndQuery(pathWithQuery: string): {
  path: string;
  query?: Record<string, string | string[]>;
  canonicalQuery: [string, string][];
} {
  const url = new URL(pathWithQuery, "http://desktop-gateway.local");
  const grouped = new Map<string, string[]>();
  const canonicalQuery: [string, string][] = [];
  for (const [key, value] of url.searchParams.entries()) {
    canonicalQuery.push([key, value]);
    const values = grouped.get(key) ?? [];
    values.push(value);
    grouped.set(key, values);
  }
  canonicalQuery.sort(([aKey, aValue], [bKey, bValue]) =>
    aKey === bKey ? aValue.localeCompare(bValue) : aKey.localeCompare(bKey)
  );

  if (grouped.size === 0) {
    return { path: url.pathname, canonicalQuery };
  }

  return {
    path: url.pathname,
    canonicalQuery,
    query: Object.fromEntries(
      Array.from(grouped.entries()).map(([key, values]) => [
        key,
        values.length === 1 ? values[0] : values,
      ])
    ),
  };
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return bytesToBase64Url(new Uint8Array(digest));
}

function createUuidV7(): BrowserSignedCommandId {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let timestamp = Date.now();
  for (let index = 5; index >= 0; index--) {
    bytes[index] = timestamp % 256;
    timestamp = Math.floor(timestamp / 256);
  }
  bytes[6] = (bytes[6] % 16) + 112;
  bytes[8] = (bytes[8] % 64) + 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-") as BrowserSignedCommandId;
}

/**
 * Returns true only for targets that advertise the canonical Desktop
 * `commandSigning` capability and are also server-authorized for signing.
 */
export function hasEffectiveCommandSigningSupport(
  target: SigningTarget
): boolean {
  return (
    target.capabilities[COMMAND_SIGNING_CAPABILITY_KEY] === true &&
    target.serverCapabilities?.computeTargetSigning === true
  );
}

/** Hashes the stable JSON command body used inside the signature payload. */
export function hashCommandBody(body: JsonValue | undefined): Promise<string> {
  return sha256Base64Url(stableStringify(body ?? null));
}

/**
 * Rewrites Desktop gateway paths to the target namespace and splits query
 * values for both relay transport and canonical signature construction.
 */
export function resolveSignedDesktopRequest(
  pathWithQuery: string,
  capabilities: Record<string, unknown>
): {
  path: string;
  query?: Record<string, string | string[]>;
  canonicalQuery: [string, string][];
} {
  const namespace =
    getDesktopApiNamespaceFromCapabilities(capabilities) ??
    CURRENT_DESKTOP_API_NAMESPACE;
  return splitPathAndQuery(rewriteDesktopApiPath(pathWithQuery, namespace));
}

/** Serializes signature payload fields with stable key ordering. */
export function canonicalizeCommandSignaturePayload(
  payload: CanonicalPayload
): string {
  return stableStringify(payload);
}

function createCommandSigningUnavailableError(reason: string): Error {
  if (reason === "not_found") {
    return new Error(
      "Browser command signing is not registered for this browser. Register this browser in Settings before sending signed commands."
    );
  }

  return new Error(`Command signing unavailable: ${reason}`);
}

/**
 * Signs the exact Desktop command representation the API should relay.
 */
export async function signDesktopCommand(
  request: SignableRelayRequest,
  target: SigningTarget
): Promise<SignedDesktopCommand> {
  const key = await getStoredBrowserSigningKey();
  if (!key.ok) {
    throw createCommandSigningUnavailableError(key.reason);
  }

  const commandId = createUuidV7();
  const { path, query, canonicalQuery } = resolveSignedDesktopRequest(
    request.pathWithQuery,
    target.capabilities
  );
  const payload = canonicalizeCommandSignaturePayload({
    commandId,
    method: request.method.toUpperCase(),
    path,
    query: canonicalQuery,
    bodyHash: await hashCommandBody(request.body),
    timestamp: Math.floor(Date.now() / 1000),
    nonce: crypto.randomUUID(),
  });
  const signature = await crypto.subtle.sign(
    "Ed25519",
    key.keyPair.privateKey,
    new TextEncoder().encode(payload)
  );

  return {
    commandId,
    path,
    query,
    signature: bytesToBase64(new Uint8Array(signature)),
    signaturePayload: payload,
    publicKeyFingerprint: key.fingerprint,
  };
}
