import { DocumentType } from "@repo/api/src/types/document";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { documentsService } from "../../documents/service";
import { WHITESPACE_REGEX } from "./webhook-utils";

export type SlackSlashCommandPayload = {
  team_id: string;
  user_id: string;
  text: string;
  channel_id: string;
  command: string;
};

export type SlackResponse = {
  response_type: "ephemeral" | "in_channel";
  text: string;
};

/**
 * Resolve a SlackIntegration and the calling User from the Slack payload.
 * Returns null for both if the Slack team or user cannot be matched.
 */
async function resolveSlackContext(payload: SlackSlashCommandPayload): Promise<{
  organizationId: string;
  userId: string;
} | null> {
  // Find the SlackIntegration by Slack teamId
  const integration = await withDb((db) =>
    db.slackIntegration.findFirst({
      where: { teamId: payload.team_id },
      select: { organizationId: true },
    })
  );

  if (!integration) {
    log.warn("[slack/handlers] No SlackIntegration found for team", {
      teamId: payload.team_id,
    });
    return null;
  }

  const { organizationId } = integration;

  // Find the User by slackId within the organization
  const user = await withDb((db) =>
    db.user.findFirst({
      where: { slackId: payload.user_id, organizationId },
      select: { id: true },
    })
  );

  if (!user) {
    log.warn("[slack/handlers] No User found for Slack user in organization", {
      slackUserId: payload.user_id,
      organizationId,
    });
    return null;
  }

  return { organizationId, userId: user.id };
}

/**
 * Parse the slash command text for a projectId and title.
 * Expected format: "<projectId> <title...>" or just "<title...>"
 * Returns { projectId, title } where projectId may be null.
 */
function parseCreateIdeaText(text: string): {
  projectId: string | null;
  title: string;
} {
  const trimmed = text.trim();
  if (!trimmed) {
    return { projectId: null, title: "" };
  }

  // Split on whitespace; first token may be a project ID if it looks like a UUID/CUID
  const parts = trimmed.split(WHITESPACE_REGEX);
  const firstPart = parts[0];

  // Heuristic: if the first word is a UUID-like or CUID-like string (>20 chars, no spaces),
  // treat it as a projectId and the rest as the title.
  if (firstPart && firstPart.length > 20 && parts.length > 1) {
    const projectId = firstPart;
    const title = parts.slice(1).join(" ");
    return { projectId, title };
  }

  // Otherwise the entire text is the title
  return { projectId: null, title: trimmed };
}

/**
 * Handle /symphony create-idea <text>
 * Creates a new PRD artifact for the calling user's organization.
 */
export async function handleCreateIdea(
  payload: SlackSlashCommandPayload
): Promise<SlackResponse> {
  log.info("[slack/handlers] handleCreateIdea", {
    teamId: payload.team_id,
    userId: payload.user_id,
    text: payload.text,
  });

  // Step 1 & 2: Resolve org and user
  const context = await resolveSlackContext(payload);
  if (!context) {
    return {
      response_type: "ephemeral",
      text: "Your Slack workspace is not connected to ClosedLoop, or your Slack user is not linked to a ClosedLoop account. Please contact your administrator.",
    };
  }

  const { organizationId, userId } = context;

  // Step 3: Parse text for projectId and title
  const { projectId, title } = parseCreateIdeaText(payload.text);

  if (!title) {
    return {
      response_type: "ephemeral",
      text: "Please provide a title for the idea. Usage: `/symphony create-idea <projectId> <title>`",
    };
  }

  if (!projectId) {
    return {
      response_type: "ephemeral",
      text: "A project ID is required. Usage: `/symphony create-idea <projectId> <title>`",
    };
  }

  // Step 4: Validate projectId belongs to the org
  {
    const project = await withDb((db) =>
      db.project.findFirst({
        where: { id: projectId, organizationId },
        select: { id: true },
      })
    );

    if (!project) {
      return {
        response_type: "ephemeral",
        text: `Project \`${projectId}\` was not found in your organization.`,
      };
    }
  }

  // Step 5: Create the artifact
  try {
    const artifact = await documentsService.create(organizationId, userId, {
      type: DocumentType.Prd,
      title,
      content: "",
      projectId,
    });

    if (!artifact) {
      return {
        response_type: "ephemeral",
        text: "Failed to create the idea. Please ensure a valid project is specified.",
      };
    }

    // Step 6: Return success response
    return {
      response_type: "in_channel",
      text: `Idea created: *${artifact.title}* (ID: \`${artifact.id}\`). Open ClosedLoop to continue refining it.`,
    };
  } catch (error) {
    log.error("[slack/handlers] Failed to create idea", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      response_type: "ephemeral",
      text: "An error occurred while creating the idea. Please try again.",
    };
  }
}

/**
 * Handle /symphony status <identifier>
 * Returns the status of a project or artifact by ID or title fragment.
 */
export async function handleGetStatus(
  payload: SlackSlashCommandPayload
): Promise<SlackResponse> {
  log.info("[slack/handlers] handleGetStatus", {
    teamId: payload.team_id,
    userId: payload.user_id,
    text: payload.text,
  });

  // Resolve org and user
  const context = await resolveSlackContext(payload);
  if (!context) {
    return {
      response_type: "ephemeral",
      text: "Your Slack workspace is not connected to ClosedLoop, or your Slack user is not linked to a ClosedLoop account. Please contact your administrator.",
    };
  }

  const { organizationId } = context;

  const identifier = payload.text.trim();

  if (!identifier) {
    return {
      response_type: "ephemeral",
      text: "Please provide a project or artifact identifier. Usage: `/symphony status <id>`",
    };
  }

  // Try to find artifact by ID first
  const artifact = await documentsService.findById(identifier, organizationId);

  if (artifact) {
    const statusText = [
      `*${artifact.title}*`,
      `Type: ${artifact.type}`,
      `Status: ${artifact.status}`,
      `Version: v${artifact.latestVersion}`,
      artifact.generationStatus
        ? `Generation: ${artifact.generationStatus.status}`
        : null,
    ]
      .filter(Boolean)
      .join("\n");

    return {
      response_type: "ephemeral",
      text: statusText,
    };
  }

  // Try to find a project by ID
  const project = await withDb((db) =>
    db.project.findFirst({
      where: { id: identifier, organizationId },
      select: {
        id: true,
        name: true,
        priority: true,
        _count: {
          select: {
            workstreams: true,
            documents: true,
          },
        },
      },
    })
  );

  if (project) {
    const statusText = [
      `*${project.name}*`,
      `Priority: ${project.priority}`,
      `Workstreams: ${project._count.workstreams}`,
      `Documents: ${project._count.documents}`,
    ].join("\n");

    return {
      response_type: "ephemeral",
      text: statusText,
    };
  }

  return {
    response_type: "ephemeral",
    text: `No artifact or project found with identifier \`${identifier}\`.`,
  };
}
