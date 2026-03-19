import type { CreateLoopRequest } from "@repo/api/src/types/loop";
import { loopsService } from "@/app/loops/service";
import type { getCommandHandler } from "@/lib/loops/loop-commands";
import { artifactsService } from "../../service";

/**
 * Map route body commands to LoopCommand enum values.
 */
export const COMMAND_MAP = {
  plan: "PLAN",
  execute: "EXECUTE",
  request_changes: "REQUEST_CHANGES",
  decompose: "DECOMPOSE",
  evaluate_prd: "EVALUATE_PRD",
  generate_prd: "GENERATE_PRD",
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

  const targetRepo =
    body.repo?.fullName ?? source?.targetRepo ?? artifact.targetRepo;

  const targetBranch =
    body.repo?.branch ??
    source?.targetBranch ??
    artifact.targetBranch ??
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

  return { workstream, targetRepo, targetBranch, contextRefs, parentLoopId };
}
