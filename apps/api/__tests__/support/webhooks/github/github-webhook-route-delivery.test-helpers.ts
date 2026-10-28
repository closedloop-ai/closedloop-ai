/**
 * Delivers a payload through the production `/webhooks/github` route: a real
 * signed request, read by the real `validateRequest` and verified by the real
 * `verifyWebhookSignature`. The route takes the raw body, so this is how a test
 * sends a payload the handler's Octokit type forbids (an action GitHub sends
 * that the handler does not handle, a field GitHub leaves null or out) without
 * casting it into that type.
 *
 * The calling suite mocks `next/headers` with the `headers` mock it passes in,
 * since there is no Next request scope under Vitest.
 */

import { createHmac } from "node:crypto";
import type { Mock } from "vitest";
import { POST } from "@/app/webhooks/github/route";

export type GitHubWebhookDelivery = {
  eventType: string;
  payload: unknown;
  deliveryId?: string;
};

export async function deliverGitHubWebhook(
  nextHeaders: Mock,
  delivery: GitHubWebhookDelivery
): Promise<Response> {
  const body = JSON.stringify(delivery.payload);
  const headers = new Headers({
    "content-type": "application/json",
    "x-github-event": delivery.eventType,
    "x-hub-signature-256": `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`,
  });
  if (delivery.deliveryId) {
    headers.set("x-github-delivery", delivery.deliveryId);
  }
  nextHeaders.mockResolvedValueOnce(headers);

  const previousEnv = new Map(
    Object.keys(GITHUB_APP_ENV).map((key) => [key, process.env[key]])
  );
  Object.assign(process.env, GITHUB_APP_ENV);
  try {
    return await POST(
      new Request(ROUTE_URL, { method: "POST", headers, body })
    );
  } finally {
    for (const [key, value] of previousEnv) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  }
}

const ROUTE_URL = "https://api.closedloop.test/webhooks/github";
const WEBHOOK_SECRET = "github-webhook-route-delivery-secret";
/** The three keys `isGitHubConfigured` requires before the route reads a body. */
const GITHUB_APP_ENV = {
  GITHUB_APP_ID: "123",
  GITHUB_APP_PRIVATE_KEY: "test-private-key",
  GITHUB_APP_WEBHOOK_SECRET: WEBHOOK_SECRET,
};
