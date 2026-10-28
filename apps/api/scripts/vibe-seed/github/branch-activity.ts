import {
  type GitHubBranchActivityProducerInput,
  GitHubBranchActivityProductionStatus,
  persistGitHubBranchActivity,
} from "@/app/webhooks/github/handlers/branch-activity-producer";

/**
 * ISS-12017: hand one webhook-shaped delivery to the GitHub Branch activity
 * producer, the mapper every GitHub webhook handler calls, and fail loudly
 * when it writes nothing. A replay of the same delivery counts as written.
 */
export async function deliverBranchActivity(
  input: GitHubBranchActivityProducerInput & { deliveryId: string }
): Promise<void> {
  const result = await persistGitHubBranchActivity(input);
  if (result.status !== GitHubBranchActivityProductionStatus.Persisted) {
    throw new Error(
      `branch activity delivery ${input.deliveryId} (${String(input.eventName)}) wrote nothing: ${result.reason}`
    );
  }
}

/** A stable delivery id for one seeded webhook, so a re-run replays it. */
export function seedDeliveryId(...parts: readonly (string | number)[]): string {
  return ["vibe-seed", ...parts].join(":");
}
