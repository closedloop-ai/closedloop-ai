import type {
  CheckRunEvent,
  DeploymentStatusEvent,
  PushEvent,
} from "@octokit/webhooks-types";
import { verifyWebhookSignature } from "@repo/github";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import type { GitHubWebhookObservationContext } from "@/lib/github/github-webhook-observation";
import { withRequestCompleted } from "@/lib/observability/with-request-completed";
import { handleCheckRun } from "./handlers/check-run-handler";
import { handleDeploymentStatus } from "./handlers/deployment-status-handler";
import { handleInstallation } from "./handlers/installation-handler";
import { handleInstallationRepositories } from "./handlers/installation-repositories-handler";
import {
  type HandledIssueCommentEvent,
  handleIssueComment,
} from "./handlers/issue-comment-handler";
import type { HandledPullRequestEvent } from "./handlers/pull-request-action-application";
import { handlePullRequest } from "./handlers/pull-request-handler";
import {
  type HandledPullRequestReviewCommentEvent,
  handlePullRequestReviewComment,
} from "./handlers/pull-request-review-comment-handler";
import {
  type HandledPullRequestReviewEvent,
  handlePullRequestReview,
} from "./handlers/pull-request-review-handler";
import { handlePullRequestReviewThread } from "./handlers/pull-request-review-thread-handler";
import { handlePush } from "./handlers/push-handler";
import { maybeDropPreviewSchemaOnClose } from "./preview-schema-drop";
import { isGitHubConfigured, validateRequest } from "./webhook-service";

export const POST = withRequestCompleted(handleGitHubWebhook);

async function handleGitHubWebhook(request: Request): Promise<Response> {
  if (!isGitHubConfigured()) {
    log.warn("[webhook/github] GitHub not configured, rejecting request");
    return NextResponse.json({ message: "GitHub not configured", ok: false });
  }

  try {
    const validated = await validateRequest(request);
    if (validated.oversized) {
      return validated.oversized;
    }
    const { body, deliveryId, eventType, observedAt, signature } = validated;

    if (!signature) {
      log.warn("[webhook/github] Missing signature header, rejecting");
      return NextResponse.json(
        { message: "Missing signature", ok: false },
        { status: 401 }
      );
    }

    if (!verifyWebhookSignature(body, signature)) {
      log.warn("[webhook/github] Invalid signature, rejecting");
      return NextResponse.json(
        { message: "Invalid signature", ok: false },
        { status: 401 }
      );
    }

    const parsedBody = JSON.parse(body) as { action?: string };
    const observationContext = createWebhookObservationContext(
      deliveryId,
      observedAt
    );

    switch (eventType) {
      case "installation":
        return await handleGitHubRouteEvent(eventType, parsedBody, () =>
          handleInstallation(
            parsedBody as { action: string },
            observationContext
          )
        );

      case "installation_repositories":
        return await handleGitHubRouteEvent(eventType, parsedBody, () =>
          handleInstallationRepositories(
            parsedBody as { action: string },
            observationContext
          )
        );

      case "pull_request": {
        const prEvent = parsedBody as HandledPullRequestEvent;
        return await handleGitHubRouteEvent(eventType, parsedBody, async () => {
          const prResponse = await handlePullRequest(
            prEvent,
            observationContext
          );
          maybeDropPreviewSchemaOnClose({
            action: parsedBody.action ?? "",
            branch: prEvent.pull_request.head.ref,
            repoFullName: prEvent.repository.full_name,
          });
          return prResponse;
        });
      }

      case "check_run":
        // GitHub App settings (T-7.1) filter delivery to completed events;
        // handler-level action guard provides defense-in-depth
        return await handleCheckRun(
          parsedBody as CheckRunEvent,
          observationContext
        );

      case "deployment_status":
        return await handleGitHubRouteEvent(eventType, parsedBody, () =>
          handleDeploymentStatus(
            parsedBody as DeploymentStatusEvent,
            observationContext
          )
        );

      case "pull_request_review":
        return await handleGitHubRouteEvent(eventType, parsedBody, () =>
          handlePullRequestReview(
            parsedBody as HandledPullRequestReviewEvent,
            observationContext
          )
        );

      case "pull_request_review_comment":
        return await handleGitHubRouteEvent(eventType, parsedBody, () =>
          handlePullRequestReviewComment(
            parsedBody as HandledPullRequestReviewCommentEvent,
            observationContext
          )
        );

      case "pull_request_review_thread":
        return await handleGitHubRouteEvent(eventType, parsedBody, () =>
          handlePullRequestReviewThread(parsedBody, observationContext)
        );

      case "issue_comment":
        return await handleGitHubRouteEvent(eventType, parsedBody, () =>
          handleIssueComment(
            parsedBody as HandledIssueCommentEvent,
            observationContext
          )
        );

      case "push":
        return await handleGitHubRouteEvent(eventType, parsedBody, () =>
          handlePush(parsedBody as PushEvent, observationContext)
        );

      default: {
        log.info("[webhook/github] Completed webhook handling", {
          action: parsedBody.action,
          eventType,
          outcome: "unsupported_event",
          provider: "github",
        });
        return NextResponse.json({
          message: `Ignoring event type: ${eventType}`,
          ok: true,
        });
      }
    }
  } catch (error) {
    const message = parseError(error);
    log.error("[webhook/github] Unhandled error processing webhook", {
      error: message,
    });
    return NextResponse.json(
      { message: "Something went wrong", ok: false },
      { status: 500 }
    );
  }
}

function createWebhookObservationContext(
  deliveryId: string | null,
  observedAt: Date
): GitHubWebhookObservationContext | undefined {
  if (!deliveryId?.trim()) {
    return undefined;
  }
  return { deliveryId, observedAt };
}

async function handleGitHubRouteEvent(
  eventType: string,
  parsedBody: { action?: string },
  handler: () => Promise<Response>
): Promise<Response> {
  const response = await handler();
  const outcome = await readGitHubRouteOutcome(response);
  const fields = {
    action: parsedBody.action,
    eventType,
    outcome,
    provider: "github",
  };
  // ISS-8450 AC2: a processed delivery is routine success and logs at debug;
  // ignored and failed deliveries keep info. `api.webhooks.github` still counts
  // both, because its filter does not pin a status.
  if (outcome === "processed" && !LIFECYCLE_ROUTE_EVENTS.has(eventType)) {
    log.debug("[webhook/github] Completed webhook handling", fields);
  } else {
    log.info("[webhook/github] Completed webhook handling", fields);
  }
  return response;
}

// Every handler routed through `handleGitHubRouteEvent` answers with
// `NextResponse.json(...)`, so the body parse below cannot throw. The type
// system cannot carry that invariant: `NextResponse`'s body parameter is
// inferred from the expected type, so a bodyless `new NextResponse(null)`
// satisfies any annotation a handler declares. `handler-response-json-contract`
// enforces it instead, and a violation fails there rather than as a 500 here.
async function readGitHubRouteOutcome(response: Response): Promise<string> {
  if (!response.ok) {
    return "failed_response";
  }
  const body = (await response.clone().json()) as {
    message?: unknown;
    ok?: unknown;
  };
  if (body.ok === false) {
    return "failed_response";
  }
  const message = typeof body.message === "string" ? body.message : "";
  return IGNORED_ROUTE_MESSAGE.test(message) ? "ignored" : "processed";
}

// Every `ok: true` skip a routed handler answers with. A skip this misses is
// labelled processed and logged at debug, which hides it (ISS-8450), so a new
// skip wording belongs here.
const IGNORED_ROUTE_MESSAGE =
  /\bignor(?:ed|ing)\b|not tracked|no matching|no resolvable|\bskipped\b|\brejected\b|\backnowledged\b/i;

// App install, uninstall, suspend and repository-scope changes are lifecycle
// transitions, which `apps/api/AGENTS.md` reserves info for. Their handlers
// answer "... successfully", so they land in the processed arm above and would
// otherwise drop to debug — leaving no info-level record anywhere that a
// customer removed the App, because `requireNoRoutineGitHubHandlerInfoLogs`
// forbids the handlers from carrying one. They are a handful of deliveries a
// month, so they are not part of the volume ISS-8450 targets.
const LIFECYCLE_ROUTE_EVENTS: ReadonlySet<string> = new Set([
  "installation",
  "installation_repositories",
]);
