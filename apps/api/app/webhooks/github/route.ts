import type {
  CheckRunEvent,
  DeploymentStatusEvent,
  PushEvent,
} from "@octokit/webhooks-types";
import { verifyWebhookSignature } from "@repo/github";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import { handleCheckRun } from "./handlers/check-run-handler";
import { handleDeploymentStatus } from "./handlers/deployment-status-handler";
import { handleInstallation } from "./handlers/installation-handler";
import { handleInstallationRepositories } from "./handlers/installation-repositories-handler";
import {
  type HandledPullRequestEvent,
  handlePullRequest,
} from "./handlers/pull-request-handler";
import {
  type HandledPullRequestReviewCommentEvent,
  handlePullRequestReviewComment,
} from "./handlers/pull-request-review-comment-handler";
import {
  type HandledPullRequestReviewEvent,
  handlePullRequestReview,
} from "./handlers/pull-request-review-handler";
import { handlePush } from "./handlers/push-handler";
import { handleWorkflowRun } from "./handlers/workflow-run-handler";
import type { WorkflowRunEvent } from "./types";
import { isGitHubConfigured, validateRequest } from "./webhook-service";

export async function POST(request: Request): Promise<Response> {
  log.info("[webhook/github] Received webhook request");

  if (!isGitHubConfigured()) {
    log.warn("[webhook/github] GitHub not configured, rejecting request");
    return NextResponse.json({ message: "GitHub not configured", ok: false });
  }

  try {
    const { body, signature, eventType } = await validateRequest(request);
    log.info("[webhook/github] Validating request", { eventType });

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

    switch (eventType) {
      case "workflow_run":
        return await handleWorkflowRun(parsedBody as WorkflowRunEvent);

      case "installation":
        return await handleInstallation(parsedBody as { action: string });

      case "installation_repositories":
        return await handleInstallationRepositories(
          parsedBody as { action: string }
        );

      case "pull_request":
        return await handlePullRequest(parsedBody as HandledPullRequestEvent);

      case "check_run":
        // GitHub App settings (T-7.1) filter delivery to completed events;
        // handler-level action guard provides defense-in-depth
        return await handleCheckRun(parsedBody as CheckRunEvent);

      case "deployment_status":
        return await handleDeploymentStatus(
          parsedBody as DeploymentStatusEvent
        );

      case "pull_request_review":
        return await handlePullRequestReview(
          parsedBody as HandledPullRequestReviewEvent
        );

      case "pull_request_review_comment":
        return await handlePullRequestReviewComment(
          parsedBody as HandledPullRequestReviewCommentEvent
        );

      case "push":
        return await handlePush(parsedBody as PushEvent);

      default: {
        log.info("[webhook/github] Ignoring unsupported event type", {
          eventType,
          reason: "Event type not supported",
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
