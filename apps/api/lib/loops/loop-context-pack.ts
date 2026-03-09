/**
 * Context pack assembly for loop orchestration.
 *
 * Builds the context pack (artifacts, refs, summaries) that gets uploaded to S3
 * for the container to consume. Uses command handlers to determine which
 * artifacts to include.
 */

import { EntityType } from "@repo/api/src/types/entity-link";
import type { LoopCommand } from "@repo/api/src/types/loop";
import { log } from "@repo/observability/log";
import { artifactVersionService } from "@/app/artifacts/artifact-version-service";
import { artifactsService } from "@/app/artifacts/service";
import { issuesService } from "@/app/issues/service";
import { loopsService } from "@/app/loops/service";
import { getCommandHandler } from "./loop-commands";
import {
  type ContextPack,
  downloadMetadata,
  uploadContextPack,
} from "./loop-state";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LoopForContextPack = {
  id: string;
  command: LoopCommand;
  prompt: string | null;
  artifactId: string | null;
  parentLoopId: string | null;
  repo: { fullName: string; branch: string } | null;
  contextRefs: Array<{
    sourceId: string;
    sourceType?: EntityType;
    include: "full" | "summary";
  }> | null;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function fetchPrimaryArtifact(
  loop: LoopForContextPack,
  organizationId: string
): Promise<ContextPack["artifacts"]> {
  if (!loop.artifactId) {
    return [];
  }

  // Commands declare whether they need the primary artifact in the context pack.
  // PLAN skips it (PRD comes via contextRefs). REQUEST_CHANGES/EXECUTE include it.
  const handler = getCommandHandler(loop.command);
  if (handler && !handler.includePrimaryArtifact) {
    return [];
  }

  const artifact = await artifactsService.findByIdSimple(
    loop.artifactId,
    organizationId
  );
  if (!artifact) {
    log.warn("[loop-context-pack] Primary artifact not found", {
      loopId: loop.id,
      artifactId: loop.artifactId,
    });
    return [];
  }

  const latestVersion = await artifactVersionService.getLatest(artifact.id);

  return [
    {
      id: artifact.id,
      type: String(artifact.type),
      title: artifact.title,
      content: latestVersion?.content ?? "",
    },
  ];
}

async function fetchContextRefArtifacts(
  loop: LoopForContextPack,
  organizationId: string
): Promise<ContextPack["artifacts"]> {
  if (!loop.contextRefs || loop.contextRefs.length === 0) {
    return [];
  }

  // Exclude the primary artifact from context refs to avoid duplication
  const refs = loop.contextRefs.filter(
    (ref) =>
      ref.sourceId !== loop.artifactId || ref.sourceType === EntityType.Issue
  );

  const results = await Promise.all(
    refs.map((ref) => {
      if (ref.sourceType === EntityType.Issue) {
        return fetchIssueRef(ref, organizationId, loop.id);
      }
      return fetchArtifactRef(ref, organizationId, loop.id);
    })
  );

  return results.filter((item): item is NonNullable<typeof item> =>
    Boolean(item)
  );
}

async function fetchIssueRef(
  ref: { sourceId: string; include: "full" | "summary" },
  organizationId: string,
  loopId: string
): Promise<ContextPack["artifacts"][number] | null> {
  const issue = await issuesService.findById(ref.sourceId, organizationId);
  if (!issue) {
    log.warn("[loop-context-pack] Issue not found for context ref", {
      loopId,
      issueId: ref.sourceId,
    });
    return null;
  }

  const content = issue.description ?? "";

  return {
    id: issue.id,
    type: "FEATURE",
    title: issue.title,
    content: ref.include === "summary" ? truncateForSummary(content) : content,
  };
}

async function fetchArtifactRef(
  ref: { sourceId: string; include: "full" | "summary" },
  organizationId: string,
  loopId: string
): Promise<ContextPack["artifacts"][number] | null> {
  const artifact = await artifactsService.findByIdSimple(
    ref.sourceId,
    organizationId
  );
  if (!artifact) {
    log.warn("[loop-context-pack] Artifact not found for context ref", {
      loopId,
      artifactId: ref.sourceId,
    });
    return null;
  }

  const latestVersion = await artifactVersionService.getLatest(artifact.id);
  const content = latestVersion?.content ?? "";

  return {
    id: artifact.id,
    type: String(artifact.type),
    title: artifact.title,
    content: ref.include === "summary" ? truncateForSummary(content) : content,
  };
}

async function fetchParentLoopSummary(
  loop: LoopForContextPack,
  organizationId: string
): Promise<NonNullable<ContextPack["priorLoopSummaries"]>> {
  if (!loop.parentLoopId) {
    return [];
  }

  const parentLoop = await loopsService.findById(
    loop.parentLoopId,
    organizationId
  );
  if (!parentLoop) {
    return [];
  }

  const metadata = parentLoop.s3StateKey
    ? await downloadMetadata(parentLoop.s3StateKey)
    : null;
  return [
    {
      loopId: parentLoop.id,
      command: parentLoop.command,
      summary: metadata
        ? `Completed with ${metadata.tokensInput + metadata.tokensOutput} tokens. ` +
          `Files written: ${metadata.filesWritten.join(", ") || "none"}.`
        : `Parent loop (${parentLoop.status}).`,
    },
  ];
}

/**
 * Truncate content to a reasonable summary length.
 * Used when contextRefs specify include: "summary".
 */
function truncateForSummary(content: string, maxLength = 2000): string {
  if (content.length <= maxLength) {
    return content;
  }
  return `${content.slice(0, maxLength)}\n\n[... truncated for summary ...]`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build and upload a ContextPack for the given loop.
 *
 * Assembles:
 * - The loop's command and prompt
 * - Primary artifact content (if artifactId is set)
 * - Prior loop summary (if parentLoopId is set)
 * - Repository info from the loop record
 *
 * Returns the S3 key where the context pack was stored.
 */
export async function buildContextPack(
  loop: LoopForContextPack,
  organizationId: string,
  stateKeyPrefix: string,
  secrets?: { anthropicApiKey: string; githubToken?: string },
  committer?: { name: string; email: string }
): Promise<string> {
  const [primaryArtifacts, refArtifacts, priorLoopSummaries] =
    await Promise.all([
      fetchPrimaryArtifact(loop, organizationId),
      fetchContextRefArtifacts(loop, organizationId),
      fetchParentLoopSummary(loop, organizationId),
    ]);

  // Context ref artifacts first (Issue/PRD), then primary artifact
  const artifacts = [...refArtifacts, ...primaryArtifacts];

  const contextPack: ContextPack = {
    command: loop.command,
    prompt: loop.prompt ?? undefined,
    artifacts,
    repoInfo: loop.repo ?? undefined,
    priorLoopSummaries:
      priorLoopSummaries.length > 0 ? priorLoopSummaries : undefined,
    committer,
    secrets,
  };

  const s3Key = await uploadContextPack(stateKeyPrefix, contextPack);
  return s3Key;
}
