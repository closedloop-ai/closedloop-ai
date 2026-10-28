import { analytics } from "@repo/analytics/server";
import type { WebhookEvent } from "@repo/auth/server";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { Webhook } from "svix";
import { env } from "@/env";
import { withRequestCompleted } from "@/lib/observability/with-request-completed";
import {
  CLERK_WEBHOOK_MAX_BYTES,
  readVerifiableWebhookBody,
} from "../webhook-body";
import {
  handleOrganizationCreated,
  handleOrganizationDeleted,
  handleOrganizationMembershipCreated,
  handleOrganizationMembershipDeleted,
  handleOrganizationMembershipUpdated,
  handleOrganizationUpdated,
  handleUserCreated,
  handleUserDeleted,
  handleUserUpdated,
} from "./auth-hooks";

export const POST = withRequestCompleted(handleClerkWebhook);

async function handleClerkWebhook(request: Request): Promise<Response> {
  if (!env.CLERK_WEBHOOK_SECRET) {
    return NextResponse.json({ message: "Not configured", ok: false });
  }

  // Tracks whether control reached the dispatch switch. Only a handler captures
  // analytics, so only a post-dispatch failure is worth waiting on the shared
  // client for (see `shutdownAnalytics` below).
  let dispatched = false;

  // Opens before `await headers()` so that every precondition that can throw —
  // the header read, the capped body read, the svix constructor — is answered
  // with this receiver's own 500 envelope rather than escaping POST as a raw
  // throw (github/route.ts does the same).
  try {
    // Get the headers
    const headerPayload = await headers();
    const svixId = headerPayload.get("svix-id");
    const svixTimestamp = headerPayload.get("svix-timestamp");
    const svixSignature = headerPayload.get("svix-signature");

    // If there are no headers, error out
    if (!(svixId && svixTimestamp && svixSignature)) {
      return new Response("Error occured -- no svix headers", {
        status: 400,
      });
    }

    // Svix signs the exact bytes Clerk sent. Parsing and re-serializing produces
    // a different string for the same payload, so verification must run on the
    // raw text (apps/api/app/webhooks/AGENTS.md). Bounded because that read
    // precedes verification and the caller is still anonymous (ISS-7665).
    const { body, response: oversized } = await readVerifiableWebhookBody(
      request,
      CLERK_WEBHOOK_MAX_BYTES
    );
    if (oversized) {
      return oversized;
    }

    // Create a new SVIX instance with your secret.
    const webhook = new Webhook(env.CLERK_WEBHOOK_SECRET);

    let event: WebhookEvent | undefined;

    // Verify the payload with the headers
    try {
      event = webhook.verify(body, {
        "svix-id": svixId,
        "svix-timestamp": svixTimestamp,
        "svix-signature": svixSignature,
      }) as WebhookEvent;
    } catch (error) {
      log.error("[webhook/auth] Error verifying webhook", { error });
      return new Response("Error occured", {
        status: 400,
      });
    }

    // Get the ID and type
    const { id } = event.data;
    const eventType = event.type;

    // The raw body is deliberately absent: it carries Clerk PII (names, phone
    // numbers, image URLs, and the rendered email body on `email.created`) that
    // no redactor here knows how to strip (ISS-7972).
    log.info("[webhook/auth] Webhook", { eventType, id });

    let response: Response = new Response("", { status: 201 });

    dispatched = true;

    switch (eventType) {
      case "user.created": {
        response = await handleUserCreated(event.data);
        break;
      }
      case "user.updated": {
        response = await handleUserUpdated(event.data);
        break;
      }
      case "user.deleted": {
        response = await handleUserDeleted(event.data);
        break;
      }
      case "organization.created": {
        response = await handleOrganizationCreated(event.data);
        break;
      }
      case "organization.updated": {
        response = await handleOrganizationUpdated(event.data);
        break;
      }
      case "organization.deleted": {
        response = await handleOrganizationDeleted(event.data);
        break;
      }
      case "organizationMembership.created": {
        response = await handleOrganizationMembershipCreated(event.data);
        break;
      }
      case "organizationMembership.updated": {
        response = handleOrganizationMembershipUpdated(event.data);
        break;
      }
      case "organizationMembership.deleted": {
        response = await handleOrganizationMembershipDeleted(event.data);
        break;
      }
      default: {
        // No handler ran, so this request captured no analytics. Returning here
        // skips the shutdown below rather than joining the MODULE-LEVEL client's
        // promise queue to wait out a concurrent request's work for no gain
        // (review, davetho). The `finally` still flushes; the 201 is unchanged.
        return response;
      }
    }

    await shutdownAnalytics();

    return response;
  } catch (error) {
    log.error("[webhook/auth] Unhandled error processing webhook", {
      error: parseError(error),
    });
    if (dispatched) {
      await shutdownAnalytics();
    }
    return NextResponse.json(
      { message: "Something went wrong", ok: false },
      { status: 500 }
    );
  }
}

/**
 * Whenever a PostHog key is configured `analytics` is a real client, and its
 * `shutdown()` REJECTS on its own 30s timeout — `@posthog/core` races the flush
 * against a rejecting timer, and because it clears its in-flight promise on
 * settle, a second call starts a fresh 30s race. Letting either escape would
 * reject POST, the exact failure the wrapper above exists to remove, so the
 * failure is reported and swallowed. Kept off the `finally` on purpose, and
 * gated on `dispatched` in the catch: `shutdown()` joins the MODULE-LEVEL
 * client's in-flight promise queue, so a path that captured nothing — an
 * early exit, or a pre-dispatch throw such as an aborted body — would be
 * waiting out another concurrent request's analytics work for no gain.
 */
async function shutdownAnalytics(): Promise<void> {
  try {
    await analytics.shutdown();
  } catch (error) {
    log.error("[webhook/auth] analytics shutdown failed", {
      error: parseError(error),
    });
  }
}
