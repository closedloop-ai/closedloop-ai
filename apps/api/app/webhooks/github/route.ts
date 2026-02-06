import type {
  InstallationCreatedEvent,
  InstallationDeletedEvent,
  InstallationRepositoriesAddedEvent,
  InstallationRepositoriesRemovedEvent,
  InstallationSuspendEvent,
  InstallationUnsuspendEvent,
} from "@octokit/webhooks-types";
import { verifyWebhookSignature } from "@repo/github";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import {
  handleInstallationCreated,
  handleInstallationDeleted,
  handleInstallationSuspended,
  handleInstallationUnsuspended,
} from "./handlers/installation-handler";
import {
  handleInstallationRepositoriesAdded,
  handleInstallationRepositoriesRemoved,
} from "./handlers/installation-repositories-handler";
import { handleWorkflowRun } from "./handlers/workflow-run-handler";
import type { WorkflowRunEvent } from "./types";
import {
  isGitHubConfigured,
  isS3Configured,
  validateRequest,
} from "./webhook-service";

export async function POST(request: Request): Promise<Response> {
  log.info("[webhook/github] Received webhook request");

  if (!isGitHubConfigured()) {
    log.warn("[webhook/github] GitHub not configured, rejecting request");
    return NextResponse.json({ message: "GitHub not configured", ok: false });
  }

  const s3Configured = isS3Configured();

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
      case "workflow_run": {
        const event = parsedBody as WorkflowRunEvent;
        return await handleWorkflowRun(event, s3Configured);
      }

      case "installation": {
        const event = parsedBody as { action: string };
        log.info("[webhook/github] Received installation event", {
          action: event.action,
        });

        switch (event.action) {
          case "created":
            await handleInstallationCreated(event as InstallationCreatedEvent);
            return NextResponse.json({
              message: "Installation created successfully",
              ok: true,
            });
          case "deleted":
            await handleInstallationDeleted(event as InstallationDeletedEvent);
            return NextResponse.json({
              message: "Installation deleted successfully",
              ok: true,
            });
          case "suspend":
            await handleInstallationSuspended(
              event as InstallationSuspendEvent
            );
            return NextResponse.json({
              message: "Installation suspended successfully",
              ok: true,
            });
          case "unsuspend":
            await handleInstallationUnsuspended(
              event as InstallationUnsuspendEvent
            );
            return NextResponse.json({
              message: "Installation unsuspended successfully",
              ok: true,
            });
          default:
            return NextResponse.json({
              message: `Installation action '${event.action}' acknowledged`,
              ok: true,
            });
        }
      }

      case "installation_repositories": {
        const event = parsedBody as { action: string };
        log.info("[webhook/github] Received installation_repositories event", {
          action: event.action,
        });

        switch (event.action) {
          case "added":
            await handleInstallationRepositoriesAdded(
              event as InstallationRepositoriesAddedEvent
            );
            return NextResponse.json({
              message: "Repositories added successfully",
              ok: true,
            });
          case "removed":
            await handleInstallationRepositoriesRemoved(
              event as InstallationRepositoriesRemovedEvent
            );
            return NextResponse.json({
              message: "Repositories removed successfully",
              ok: true,
            });
          default:
            return NextResponse.json({
              message: `Installation repositories action '${event.action}' acknowledged`,
              ok: true,
            });
        }
      }

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
