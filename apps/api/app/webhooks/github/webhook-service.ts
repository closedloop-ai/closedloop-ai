import { headers } from "next/headers";
import type { NextResponse } from "next/server";
import {
  GITHUB_WEBHOOK_MAX_BYTES,
  readVerifiableWebhookBody,
  type WebhookErrorBody,
} from "../webhook-body";

/**
 * Check if GitHub integration is properly configured.
 */
export function isGitHubConfigured(): boolean {
  // Check env vars directly to avoid build-time validation errors
  return Boolean(
    process.env.GITHUB_APP_ID &&
      process.env.GITHUB_APP_PRIVATE_KEY &&
      process.env.GITHUB_APP_WEBHOOK_SECRET
  );
}

/**
 * A validated GitHub webhook request, or the 413 that refused it.
 *
 * The over-cap arm carries no `body`: the read stopped short of the payload, so
 * there is no raw text to sign over and the route must return `oversized`
 * rather than reason about a partial one.
 */
export type ValidatedGitHubWebhookRequest =
  | {
      oversized: NextResponse<WebhookErrorBody>;
      body?: undefined;
    }
  | {
      oversized: null;
      body: string;
      deliveryId: string | null;
      eventType: string | null;
      observedAt: Date;
      signature: string | null;
    };

/**
 * Validate and parse incoming GitHub webhook request.
 *
 * Reads the raw text before any JSON parsing (the signature is over these
 * bytes), under `GITHUB_WEBHOOK_MAX_BYTES` — the caller is anonymous until
 * `verifyWebhookSignature` runs, so the read that feeds it has to be bounded.
 */
export async function validateRequest(
  request: Request
): Promise<ValidatedGitHubWebhookRequest> {
  const observedAt = new Date();
  const { body, response } = await readVerifiableWebhookBody(
    request,
    GITHUB_WEBHOOK_MAX_BYTES
  );
  if (response) {
    return { oversized: response };
  }

  const headerPayload = await headers();
  const signature = headerPayload.get("x-hub-signature-256");
  const eventType = headerPayload.get("x-github-event");
  const deliveryId = headerPayload.get("x-github-delivery");

  return {
    body,
    deliveryId,
    eventType,
    observedAt,
    oversized: null,
    signature,
  };
}
