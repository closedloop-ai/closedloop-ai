import { handlePullRequest } from "@/app/webhooks/github/handlers/pull-request-handler";
import { createRepository } from "../fixtures/github-webhook-fixtures";

const AUTHORITY_OBSERVED_AT = new Date("2026-08-11T12:00:00.000Z");

/** Adds an authoritative PR-head repository snapshot before invoking the webhook. */
export async function handleAuthoritativePullRequest(
  event: any
): Promise<void> {
  event.pull_request.head.repo = {
    ...createRepository(789),
    default_branch: "main",
  };
  event.pull_request.base.repo = createRepository(789);
  await handlePullRequest(event, {
    deliveryId: `iss-5827-${event.pull_request.id}`,
    observedAt: AUTHORITY_OBSERVED_AT,
  });
}
