import { headers } from "next/headers";

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
 * Validate and parse incoming GitHub webhook request.
 */
export async function validateRequest(request: Request) {
  const body = await request.text();
  const headerPayload = await headers();
  const signature = headerPayload.get("x-hub-signature-256");
  const eventType = headerPayload.get("x-github-event");

  return { body, signature, eventType };
}
