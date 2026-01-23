import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Short-lived OAuth initiation token for cross-domain auth.
 *
 * Used when the app (on domain A) needs to initiate an OAuth flow
 * on the API (on domain B) where Clerk cookies aren't available.
 *
 * Token format: base64url({payload}:{timestamp}:{signature})
 * - payload: JSON with orgId and userId
 * - timestamp: Unix timestamp in seconds
 * - signature: HMAC-SHA256 of payload:timestamp
 *
 * Tokens expire after 5 minutes.
 */

const TOKEN_EXPIRY_SECONDS = 5 * 60; // 5 minutes

function getSecret(): string {
  const secret = process.env.CLERK_SECRET_KEY;
  if (!secret) {
    throw new Error("CLERK_SECRET_KEY is required for OAuth token signing");
  }
  // Use first 32 chars of Clerk secret as HMAC key
  return secret.slice(0, 32);
}

function base64urlEncode(str: string): string {
  return Buffer.from(str, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function base64urlDecode(str: string): string {
  // Add back padding
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  return Buffer.from(
    padded.replace(/-/g, "+").replace(/_/g, "/"),
    "base64"
  ).toString("utf8");
}

export type OAuthTokenPayload = {
  orgId: string;
  userId: string;
};

/**
 * Generate a signed OAuth initiation token.
 * Call this from the app's server action before redirecting to the API.
 */
export function generateOAuthToken(payload: OAuthTokenPayload): string {
  const secret = getSecret();
  const timestamp = Math.floor(Date.now() / 1000);
  const payloadStr = JSON.stringify(payload);
  const data = `${payloadStr}:${timestamp}`;

  const signature = createHmac("sha256", secret).update(data).digest("hex");

  return base64urlEncode(`${data}:${signature}`);
}

export type OAuthTokenVerifyResult =
  | { valid: true; payload: OAuthTokenPayload }
  | { valid: false; error: string };

/**
 * Verify and decode an OAuth initiation token.
 * Call this from the API's OAuth endpoint.
 */
export function verifyOAuthToken(token: string): OAuthTokenVerifyResult {
  try {
    const decoded = base64urlDecode(token);
    const parts = decoded.split(":");

    // Format: {json}:{timestamp}:{signature}
    // JSON might contain colons, so signature is last, timestamp is second-to-last
    if (parts.length < 3) {
      return { valid: false, error: "Invalid token format" };
    }

    const signature = parts.pop();
    const timestamp = parts.pop();
    if (!(signature && timestamp)) {
      return { valid: false, error: "Invalid token format" };
    }
    const payloadStr = parts.join(":");

    // Verify timestamp (not expired)
    const tokenTime = Number.parseInt(timestamp, 10);
    const now = Math.floor(Date.now() / 1000);
    if (Number.isNaN(tokenTime) || now - tokenTime > TOKEN_EXPIRY_SECONDS) {
      return { valid: false, error: "Token expired" };
    }

    // Verify signature
    const secret = getSecret();
    const data = `${payloadStr}:${timestamp}`;
    const expectedSignature = createHmac("sha256", secret)
      .update(data)
      .digest("hex");

    const sigBuffer = Buffer.from(signature, "hex");
    const expectedBuffer = Buffer.from(expectedSignature, "hex");

    if (
      sigBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(sigBuffer, expectedBuffer)
    ) {
      return { valid: false, error: "Invalid signature" };
    }

    // Parse payload
    const payload = JSON.parse(payloadStr) as OAuthTokenPayload;
    if (!(payload.orgId && payload.userId)) {
      return { valid: false, error: "Invalid payload" };
    }

    return { valid: true, payload };
  } catch {
    return { valid: false, error: "Token verification failed" };
  }
}
