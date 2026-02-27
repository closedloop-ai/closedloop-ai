import { nanoid } from "nanoid";
import { basicUserSelect } from "@/lib/db-utils";

/**
 * Generates a unique slug for an artifact URL.
 */
export function generateSlug(): string {
  return nanoid(14);
}

/**
 * Typed error for artifact not found - maps to 404 HTTP status.
 */
export class ArtifactNotFoundError extends Error {
  readonly status = 404;
  constructor(message = "Artifact not found") {
    super(message);
    this.name = "ArtifactNotFoundError";
  }
}

/**
 * Lightweight include for queries that returns an artifact with assignee and approver only.
 * Use artifactIncludeWithContext when workstream/project info is also needed.
 */
export const artifactIncludeWithUser = {
  assignee: basicUserSelect,
  approver: basicUserSelect,
} as const;

/**
 * Prisma select for GitHubPullRequest fields that map to PullRequestInfo.
 * Centralizes the field list so callers don't omit checksStatus accidentally.
 */
export const pullRequestSelect = {
  id: true,
  number: true,
  title: true,
  htmlUrl: true,
  state: true,
  headBranch: true,
  baseBranch: true,
  createdAt: true,
  checksStatus: true,
  reviewDecision: true,
} as const;

/**
 * Standard include pattern for artifact queries with workstream and project info.
 */
export const artifactIncludeWithContext = {
  workstream: {
    select: {
      id: true,
      title: true,
      state: true,
    },
  },
  project: {
    select: {
      id: true,
      organizationId: true,
      name: true,
      teams: {
        select: {
          team: {
            select: {
              id: true,
              name: true,
            },
          },
        },
        take: 1,
      },
    },
  },
  ...artifactIncludeWithUser,
} as const;

/**
 * Extends artifactIncludeWithContext with the latest version content.
 * Use only for list queries that need a snippet (e.g. engineer ticket cards).
 * Single-artifact fetches (findById, findBySlug) don't need this — they load
 * full version content via the dedicated /versions endpoint.
 */
export const artifactIncludeWithSnippet = {
  ...artifactIncludeWithContext,
  versions: {
    orderBy: { version: "desc" as const },
    take: 1,
    select: { content: true },
  },
} as const;

/** Valid command values for GenerationStatus. */
const VALID_COMMANDS = new Set(["plan", "execute", "chat"]);

/**
 * Type definition for validated trigger data.
 */
export type TriggerData = {
  correlationId: string;
  artifactId: string;
  command: "plan" | "execute" | "chat";
};

/**
 * Type guard to safely parse and validate Prisma Json triggerData fields.
 * Returns typed TriggerData object if valid, null otherwise.
 */
export function parseTriggerData(triggerData: unknown): TriggerData | null {
  if (
    typeof triggerData !== "object" ||
    triggerData === null ||
    Array.isArray(triggerData)
  ) {
    return null;
  }

  const data = triggerData as Record<string, unknown>;

  if (
    typeof data.correlationId !== "string" ||
    typeof data.artifactId !== "string" ||
    typeof data.command !== "string"
  ) {
    return null;
  }

  if (
    data.correlationId.trim() === "" ||
    data.artifactId.trim() === "" ||
    data.command.trim() === ""
  ) {
    return null;
  }

  if (!VALID_COMMANDS.has(data.command)) {
    return null;
  }

  return {
    correlationId: data.correlationId,
    artifactId: data.artifactId,
    command: data.command as TriggerData["command"],
  };
}
