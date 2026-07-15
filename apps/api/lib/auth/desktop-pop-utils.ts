import { createPublicKey, type KeyObject } from "node:crypto";
import {
  DESKTOP_POP_GATEWAY_ID_HEADER,
  DESKTOP_POP_SIGNATURE_HEADER,
  DESKTOP_POP_TIMESTAMP_HEADER,
} from "@repo/api/src/types/api-key";

/**
 * Shared primitives for desktop Ed25519 proof-of-possession verification,
 * consumed by both the desktop-managed-PoP (API-key bound) and desktop-session
 * (first-party session bound) verifiers. Kept in one place so a correctness fix
 * — e.g. tightening the freshness window — applies to every PoP surface at once.
 *
 * Intentionally NOT `import "server-only"`: desktop-managed-PoP is loaded by the
 * desktop gateway socket server under `tsx` outside Next, where `server-only`
 * throws (see scripts/smoke-desktop-gateway-import.ts). These primitives carry no
 * secrets.
 */

export const POP_TIMESTAMP_FRESHNESS_SECONDS = 60;
export const TIMESTAMP_SECONDS_PATTERN = /^\d+$/;
export const BASE64URL_SIGNATURE_PATTERN = /^[A-Za-z0-9_-]+={0,2}$/;

export function createEd25519PublicKey(pem: string): KeyObject | null {
  try {
    const key = createPublicKey(pem.trim());
    if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
      return null;
    }
    return key;
  } catch {
    return null;
  }
}

export type DesktopPopHeaders = {
  gatewayId: string | null;
  timestamp: string | null;
  signature: string | null;
};

export function readDesktopPopHeaders(headers: Headers): DesktopPopHeaders {
  return {
    gatewayId: normalizeHeaderValue(headers.get(DESKTOP_POP_GATEWAY_ID_HEADER)),
    timestamp: normalizeHeaderValue(headers.get(DESKTOP_POP_TIMESTAMP_HEADER)),
    signature: normalizeHeaderValue(headers.get(DESKTOP_POP_SIGNATURE_HEADER)),
  };
}

function normalizeHeaderValue(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
