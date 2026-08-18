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
import { scheduleLogFlush } from "@/lib/route-utils";
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

export async function POST(request: Request): Promise<Response> {
  if (!isGitHubConfigured()) {
    log.warn("[webhook/github] GitHub not configured, rejecting request");
    scheduleLogFlush();
    return NextResponse.json({ message: "GitHub not configured", ok: false });
  }

  // finally block below ensures every success branch (all switch cases) and
  // the error branch flush logs; prevents drops on short-lived invocations.
  try {
    const { body, deliveryId, eventType, observedAt, signature } =
      await validateRequest(request);

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
  } finally {
    scheduleLogFlush();
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
  log.info("[webhook/github] Completed webhook handling", {
    action: parsedBody.action,
    eventType,
    outcome,
    provider: "github",
  });
  return response;
}

async function readGitHubRouteOutcome(response: Response): Promise<string> {
  if (!response.ok) {
    return "failed_response";
  }
  const body = await readJsonBody(response);
  if (body?.ok === false) {
    return "failed_response";
  }
  const message = typeof body?.message === "string" ? body.message : "";
  if (
    message.startsWith("Ignoring ") ||
    message.includes(" ignored") ||
    message.includes("not tracked") ||
    message.includes("No matching")
  ) {
    return "ignored";
  }
  return "processed";
}

async function readJsonBody(
  response: Response
): Promise<{ message?: unknown; ok?: unknown } | null> {
  try {
    return (await response.clone().json()) as {
      message?: unknown;
      ok?: unknown;
    };
  } catch {
    return null;
  }
}
