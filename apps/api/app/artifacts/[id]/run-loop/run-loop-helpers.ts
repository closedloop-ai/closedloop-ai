import type { JsonObject } from "@repo/api/src/types/common";
import {
  type CreateLoopRequest,
  RunLoopCommand,
} from "@repo/api/src/types/loop";
import { getProjectSettings } from "@repo/api/src/types/project";
import { loopsService } from "@/app/loops/service";
import type { getCommandHandler } from "@/lib/loops/loop-commands";
import { artifactsService } from "../../service";

/**
 * Map route body commands (lowercase) to LoopCommand enum values (uppercase).
 */
export const COMMAND_MAP = {
  [RunLoopCommand.Plan]: "PLAN",
  [RunLoopCommand.Execute]: "EXECUTE",
  [RunLoopCommand.RequestChanges]: "REQUEST_CHANGES",
  [RunLoopCommand.Decompose]: "DECOMPOSE",
  [RunLoopCommand.EvaluatePrd]: "EVALUATE_PRD",
  [RunLoopCommand.GeneratePrd]: "GENERATE_PRD",
} as const;

/**
 * Resolve workstream, repo, branch, context refs, and parent loop for a
 * run-loop request. Extracted to keep the route handler's complexity low.
 */
export async function resolveLoopContext(
  artifact: NonNullable<
    Awaited<ReturnType<typeof artifactsService.findWithRegenerationContext>>
  >,
  body: {
    repo?: { fullName?: string; branch?: string };
    command: keyof typeof COMMAND_MAP;
  },
  handler: ReturnType<typeof getCommandHandler>,
  organizationId: string,
  userId: string,
  artifactId: string
) {
  const { workstream: resolvedWorkstream, source } =
    await artifactsService.findOrCreateWorkstream(
      organizationId,
      artifact,
      userId
    );

  const workstream = resolvedWorkstream ?? artifact.workstream;

  const projectSettings = getProjectSettings(
    (workstream?.project?.settings ?? {}) as JsonObject
  );

  const targetRepo =
    body.repo?.fullName ??
    source?.targetRepo ??
    artifact.targetRepo ??
    projectSettings.defaultRepository?.repoFullName;

  const targetBranch =
    body.repo?.branch ??
    source?.targetBranch ??
    artifact.targetBranch ??
    projectSettings.defaultRepository?.branch ??
    "main";

  const contextRefs: NonNullable<CreateLoopRequest["contextRefs"]> = [];
  if (source) {
    contextRefs.push({
      sourceId: source.id,
      sourceType: source.type,
      include: "full",
    });
  }

  let parentLoopId: string | undefined;
  if (handler?.requiresParent) {
    const parentLoop = await loopsService.findLatestCompletedForArtifact(
      artifactId,
      organizationId
    );
    parentLoopId = parentLoop?.id;
  }

  return {
    workstream,
    targetRepo,
    targetBranch,
    contextRefs,
    parentLoopId,
    source,
  };
}
