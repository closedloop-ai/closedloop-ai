import type {
  ReassignAgentSessionProjectRequest,
  RenameAgentSessionRequest,
} from "@repo/api/src/types/agent-session-field-mutation";
import type { UpdateArtifactPriorityRequest } from "@repo/api/src/types/artifact-priority-mutation";
import { type ApplyTagInput, TagEntityType } from "@repo/api/src/types/tag";
import { z } from "zod";

// Provenance values are server-owned and version-skewed across installed
// Desktop builds. The privileged bridge admits strings; the server validates
// known values and safely omits unknown ones.
const updateArtifactPriorityBodySchema = z
  .object({
    priority: z.string().nullable(),
    expectedPriority: z.string().nullable().optional(),
    surface: z.string().optional(),
  } satisfies Record<keyof UpdateArtifactPriorityRequest, z.ZodTypeAny>)
  .strict();

const renameAgentSessionBodySchema = z
  .object({
    name: z.string(),
    expectedName: z.string().optional(),
    surface: z.string().optional(),
  } satisfies Record<keyof RenameAgentSessionRequest, z.ZodTypeAny>)
  .strict();

const reassignAgentSessionProjectBodySchema = z
  .object({
    projectId: z.string().nullable(),
    expectedProjectId: z.string().nullable().optional(),
  } satisfies Record<keyof ReassignAgentSessionProjectRequest, z.ZodTypeAny>)
  .strict();

const entityTagAttachBodySchema = z
  .object({
    tagId: z.string(),
    // Pinning Artifact prevents the main-held credential from tagging projects.
    entityType: z.literal(TagEntityType.Artifact),
    entityId: z.string(),
    surface: z.string().optional(),
  } satisfies Record<keyof ApplyTagInput, z.ZodTypeAny>)
  .strict();

const entityTagDetachSurfaceSchema = z.string().optional();

/** Admit only one priority body, or a session-only rename/project body. */
export function admitsArtifactPatchBody(
  body: string | undefined,
  onSessionPath: boolean
): boolean {
  return (
    matchesBodySchema(body, updateArtifactPriorityBodySchema) ||
    (onSessionPath &&
      (matchesBodySchema(body, renameAgentSessionBodySchema) ||
        matchesBodySchema(body, reassignAgentSessionProjectBodySchema)))
  );
}

/** Admit an Artifact tag attach without widening the main-held credential. */
export function admitsArtifactEntityTagAttachBody(
  body: string | undefined
): boolean {
  return matchesBodySchema(body, entityTagAttachBodySchema);
}

/** Admit omitted or version-skewed string provenance on an Artifact tag detach. */
export function admitsArtifactEntityTagDetachSurface(
  surface: string | null
): boolean {
  return entityTagDetachSurfaceSchema.safeParse(surface ?? undefined).success;
}

function matchesBodySchema(
  body: string | undefined,
  schema: z.ZodTypeAny
): boolean {
  if (body === undefined) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  return schema.safeParse(parsed).success;
}
