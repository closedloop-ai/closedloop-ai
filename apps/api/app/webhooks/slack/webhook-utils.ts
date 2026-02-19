import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify a Slack webhook signature using HMAC-SHA256.
 *
 * Slack signs each request with a signature derived from:
 *   v0:<timestamp>:<raw_body>
 *
 * Requests older than 5 minutes are rejected to prevent replay attacks.
 *
 * @param body - Raw request body string
 * @param timestamp - Value of the X-Slack-Request-Timestamp header
 * @param signature - Value of the X-Slack-Signature header (format: "v0=<hex>")
 * @param signingSecret - The Slack app's signing secret
 * @returns true if signature is valid and request is within the 5-minute window
 */
export function slackVerifyWebhookSignature(
  body: string,
  timestamp: string,
  signature: string,
  signingSecret: string
): boolean {
  // Reject requests older than 5 minutes (300 seconds) to prevent replay attacks
  const requestAge = Math.abs(
    Date.now() / 1000 - Number.parseInt(timestamp, 10)
  );
  if (requestAge > 300) {
    return false;
  }

  // Compute the expected HMAC-SHA256 signature
  const baseString = `v0:${timestamp}:${body}`;
  const hmac = createHmac("sha256", signingSecret)
    .update(baseString)
    .digest("hex");
  const expectedSignature = `v0=${hmac}`;

  // Use timing-safe comparison to prevent timing attacks
  try {
    const expectedBuffer = Buffer.from(expectedSignature, "utf8");
    const actualBuffer = Buffer.from(signature, "utf8");

    if (expectedBuffer.length !== actualBuffer.length) {
      return false;
    }

    return timingSafeEqual(expectedBuffer, actualBuffer);
  } catch {
    return false;
  }
}
