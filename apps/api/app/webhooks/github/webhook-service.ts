import { withDb } from "@repo/database";
import { headers } from "next/headers";

/**
 * Check if GitHub integration is properly configured.
 */
export function isGitHubConfigured(): boolean {
  // Check env vars directly to avoid build-time validation errors
  return Boolean(
    process.env.GITHUB_APP_ID &&
      process.env.GITHUB_APP_PRIVATE_KEY &&
      process.env.GITHUB_APP_WEBHOOK_SECRET &&
      process.env.GITHUB_APP_DISPATCH_REPO
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

/**
 * Find the GitHubActionRun by correlation ID in triggerData.
 * @param correlationId - The correlation ID to search for
 * @param activeOnly - If true, only find runs that are still in progress (PENDING, QUEUED, RUNNING)
 *                     If false, find any run regardless of status (for replay support)
 */
export async function findActionRunByCorrelationId(
  correlationId: string,
  activeOnly = true
) {
  const actionRuns = await withDb((db) =>
    db.gitHubActionRun.findMany({
      where: {
        workflowName: "symphony-dispatch",
        ...(activeOnly
          ? { status: { in: ["PENDING", "QUEUED", "RUNNING"] } }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    })
  );

  return actionRuns.find((run) => {
    const data = run.triggerData as { correlationId?: string } | null;
    return data?.correlationId === correlationId;
  });
}
