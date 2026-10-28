import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { env } from "@/env";
import { withRequestCompleted } from "@/lib/observability/with-request-completed";
import {
  readVerifiableWebhookBody,
  SLACK_WEBHOOK_MAX_BYTES,
} from "../webhook-body";
import {
  handleCreateIdea,
  handleGetStatus,
  type SlackSlashCommandPayload,
} from "./handlers";
import { slackVerifyWebhookSignature, WHITESPACE_REGEX } from "./webhook-utils";

export const POST = withRequestCompleted(handleSlackWebhook);

async function handleSlackWebhook(request: Request): Promise<Response> {
  const signingSecret = env.SLACK_SIGNING_SECRET;

  if (!signingSecret) {
    log.warn("[webhook/slack] SLACK_SIGNING_SECRET not set, rejecting request");
    return NextResponse.json(
      { message: "Slack integration not configured", ok: false },
      { status: 401 }
    );
  }

  try {
    // Read raw body for signature verification, bounded — the read precedes
    // the HMAC check, so the caller is still anonymous here (ISS-7665).
    const { body, response: oversized } = await readVerifiableWebhookBody(
      request,
      SLACK_WEBHOOK_MAX_BYTES
    );
    if (oversized) {
      return oversized;
    }
    const headerPayload = await headers();
    const timestamp = headerPayload.get("x-slack-request-timestamp") ?? "";
    const signature = headerPayload.get("x-slack-signature") ?? "";

    // Verify the webhook signature
    const isValid = slackVerifyWebhookSignature(
      body,
      timestamp,
      signature,
      signingSecret
    );

    if (!isValid) {
      log.warn("[webhook/slack] Invalid signature, rejecting request");
      return NextResponse.json(
        { message: "Invalid signature", ok: false },
        { status: 401 }
      );
    }

    // Handle Slack URL verification challenge (JSON body with type="url_verification")
    try {
      const jsonBody = JSON.parse(body) as {
        type?: string;
        challenge?: string;
      };
      if (jsonBody.type === "url_verification") {
        logSlackTerminalEvent({ outcome: "url_verification" });
        return NextResponse.json({ challenge: jsonBody.challenge });
      }
    } catch {
      // Not JSON — continue to slash command handling
    }

    // Parse URLSearchParams-encoded slash command body
    const params = new URLSearchParams(body);
    const command = params.get("command") ?? "";
    const text = params.get("text") ?? "";
    const teamId = params.get("team_id") ?? "";
    const userId = params.get("user_id") ?? "";
    const channelId = params.get("channel_id") ?? "";

    const payload: SlackSlashCommandPayload = {
      team_id: teamId,
      user_id: userId,
      text,
      channel_id: channelId,
      command,
    };

    // Route slash commands
    if (command === "/symphony") {
      const subcommand = text.trim().split(WHITESPACE_REGEX)[0] ?? "";

      if (subcommand === "create-idea") {
        const slashPayload: SlackSlashCommandPayload = {
          ...payload,
          text: text.trim().slice(subcommand.length).trim(),
        };
        const response = await handleCreateIdea(slashPayload);
        logSlackTerminalEvent({
          channelId,
          command,
          outcome: "processed",
          subcommand,
          teamId,
        });
        return NextResponse.json(response);
      }

      if (subcommand === "status") {
        const slashPayload: SlackSlashCommandPayload = {
          ...payload,
          text: text.trim().slice(subcommand.length).trim(),
        };
        const response = await handleGetStatus(slashPayload);
        logSlackTerminalEvent({
          channelId,
          command,
          outcome: "processed",
          subcommand,
          teamId,
        });
        return NextResponse.json(response);
      }

      logSlackTerminalEvent({
        channelId,
        command,
        hasText: text.trim().length > 0,
        outcome: "unknown_subcommand",
        subcommandCategory: "unknown",
        subcommandKnown: false,
        teamId,
      });
      return NextResponse.json({
        response_type: "ephemeral",
        text: "Unknown subcommand. Available commands: `create-idea`, `status`",
      });
    }

    logSlackTerminalEvent({ command, outcome: "unsupported_command", teamId });
    return NextResponse.json({ message: "Command not handled", ok: true });
  } catch (error) {
    const message = parseError(error);
    log.error("[webhook/slack] Unhandled error processing webhook", {
      error: message,
    });
    return NextResponse.json(
      { message: "Something went wrong", ok: false },
      { status: 500 }
    );
  }
}

function logSlackTerminalEvent(metadata: Record<string, unknown>): void {
  log.info("[webhook/slack] Event handled", {
    provider: "slack",
    ...metadata,
  });
}
