/**
 * Context pack assembly for loop orchestration.
 *
 * Builds the context pack (artifacts, refs, summaries) that gets uploaded to S3
 * for the container to consume. Uses command handlers to determine which
 * artifacts to include.
 */

import type { ContextPackAttachment } from "@closedloop-ai/loops-api/context-pack";
import type { ArtifactType } from "@repo/api/src/types/artifact";
import { DocumentType } from "@repo/api/src/types/document";
import type { AdditionalRepoRefWithToken } from "@repo/api/src/types/loop";
import { LoopCommand } from "@repo/api/src/types/loop";
import { log } from "@repo/observability/log";
import {
  ATTACHMENT_SIGNED_URL_MAX_FILES,
  attachmentsService,
} from "@/app/documents/attachments-service";
import { documentService } from "@/app/documents/document-service";
import { documentVersionService } from "@/app/documents/document-version-service";
import { loopsService } from "@/app/loops/service";
import { documentTemplatesService } from "@/app/templates/service";
import { getCommandHandler } from "./loop-commands";
import {
  type ContextPack,
  downloadMetadata,
  uploadContextPack,
} from "./loop-state";
import { extractUploadedPlanRaw } from "./uploaded-plan-artifacts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LoopForContextPack = {
  id: string;
  userId: string;
  command: LoopCommand;
  prompt: string | null;
  documentId: string | null;
  documentVersion: number | null;
  parentLoopId: string | null;
  repo: { fullName: string; branch: string } | null;
  contextRefs: Array<{
    sourceId: string;
    sourceType?: ArtifactType;
    include: "full" | "summary";
  }> | null;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type ParentLoopForContextPack = Awaited<
  ReturnType<typeof loopsService.findById>
>;

function fetchDesktopExecuteRawPlanState(
  loop: LoopForContextPack,
  artifactType: string,
  parentLoop: ParentLoopForContextPack
): Record<string, unknown> | undefined {
  if (
    loop.command !== LoopCommand.Execute ||
    artifactType !== DocumentType.ImplementationPlan ||
    !parentLoop?.computeTargetId
  ) {
    return undefined;
  }

  return extractUploadedPlanRaw(parentLoop.uploadedArtifacts);
}

function getDesktopExecuteRawPlanOmissionReason(
  loop: LoopForContextPack,
  artifactType: string,
  parentLoop: ParentLoopForContextPack
): string | null {
  if (loop.command !== LoopCommand.Execute) {
    return "non_execute_command";
  }
  if (artifactType !== DocumentType.ImplementationPlan) {
    return "non_implementation_plan";
  }
  if (!parentLoop) {
    return "missing_parent_loop";
  }
  if (!parentLoop.computeTargetId) {
    return "parent_not_desktop";
  }
  if (!parentLoop.uploadedArtifacts) {
    return "parent_uploaded_artifacts_missing";
  }
  if (!extractUploadedPlanRaw(parentLoop.uploadedArtifacts)) {
    return "parent_uploaded_plan_raw_missing";
  }
  return null;
}

function logDesktopExecuteRawPlanDecision({
  loop,
  artifactType,
  artifactContent,
  parentLoop,
  rawPlan,
}: {
  loop: LoopForContextPack;
  artifactType: string;
  artifactContent: string;
  parentLoop: ParentLoopForContextPack;
  rawPlan: Record<string, unknown> | undefined;
}): void {
  if (
    loop.command !== LoopCommand.Execute ||
    artifactType !== DocumentType.ImplementationPlan
  ) {
    return;
  }

  const rawPlanContent =
    typeof rawPlan?.content === "string" ? rawPlan.content : undefined;

  log.info("[loop-context-pack] Desktop EXECUTE plan raw state decision", {
    loopId: loop.id,
    documentId: loop.documentId,
    parentLoopId: parentLoop?.id ?? null,
    parentLoopStatus: parentLoop?.status ?? null,
    parentComputeTargetId: parentLoop?.computeTargetId ?? null,
    parentUploadedArtifactsPresent: Boolean(parentLoop?.uploadedArtifacts),
    rawPlanRecordAttached: rawPlan !== undefined,
    rawPlanContentPresent: rawPlanContent !== undefined,
    rawPlanContentMatchesArtifact:
      rawPlanContent !== undefined ? rawPlanContent === artifactContent : null,
    rawPlanContentLength: rawPlanContent?.length ?? null,
    artifactContentLength: artifactContent.length,
    omissionReason:
      rawPlan === undefined
        ? getDesktopExecuteRawPlanOmissionReason(loop, artifactType, parentLoop)
        : null,
  });
}

async function fetchPrimaryArtifact(
  loop: LoopForContextPack,
  organizationId: string,
  parentLoop: ParentLoopForContextPack
): Promise<ContextPack["artifacts"]> {
  if (!loop.documentId) {
    return [];
  }

  // Commands declare whether they need the primary artifact in the context pack.
  // PLAN skips it (PRD comes via contextRefs). REQUEST_CHANGES/EXECUTE include it.
  const handler = getCommandHandler(loop.command);
  if (handler && !handler.includePrimaryArtifact) {
    return [];
  }

  const artifact = await documentService.findByIdSimple(
    loop.documentId,
    organizationId
  );
  if (!artifact) {
    log.warn("[loop-context-pack] Primary artifact not found", {
      loopId: loop.id,
      documentId: loop.documentId,
    });
    return [];
  }

  // Use the pinned version when the loop was created with a specific artifact
  // version (e.g. EVALUATE_PRD). This closes the TOCTOU window: if the PRD
  // advances between loop creation and context-pack build, we still evaluate
  // the version the loop was created for, so the stale-write guard in the
  // ingest handler can accurately compare versions.
  const artifactVersion =
    loop.documentVersion != null
      ? await documentVersionService.getByVersion(
          artifact.id,
          loop.documentVersion
        )
      : await documentVersionService.getLatest(artifact.id);
  const rawPlan = await fetchDesktopExecuteRawPlanState(
    loop,
    String(artifact.type),
    parentLoop
  );
  const artifactContent = artifactVersion?.content ?? "";
  logDesktopExecuteRawPlanDecision({
    loop,
    artifactType: String(artifact.type),
    artifactContent,
    parentLoop,
    rawPlan,
  });

  return [
    {
      id: artifact.id,
      type: String(artifact.type),
      title: artifact.title,
      content: artifactContent,
      ...(rawPlan ? { raw: rawPlan } : {}),
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
    (ref) => ref.sourceId !== loop.documentId
  );

  const results = await Promise.all(
    refs.map((ref) => fetchArtifactRef(ref, organizationId, loop.id))
  );

  return results.filter((item): item is NonNullable<typeof item> =>
    Boolean(item)
  );
}

async function fetchArtifactRef(
  ref: { sourceId: string; include: "full" | "summary" },
  organizationId: string,
  loopId: string
): Promise<ContextPack["artifacts"][number] | null> {
  const artifact = await documentService.findByIdSimple(
    ref.sourceId,
    organizationId
  );
  if (!artifact) {
    log.warn("[loop-context-pack] Artifact not found for context ref", {
      loopId,
      documentId: ref.sourceId,
    });
    return null;
  }

  const latestVersion = await documentVersionService.getLatest(artifact.id);
  const content = latestVersion?.content ?? "";

  return {
    id: artifact.id,
    type: String(artifact.type),
    title: artifact.title,
    content: ref.include === "summary" ? truncateForSummary(content) : content,
  };
}

async function fetchParentLoopSummary(
  _loop: LoopForContextPack,
  parentLoop: ParentLoopForContextPack
): Promise<NonNullable<ContextPack["priorLoopSummaries"]>> {
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
 * Fetch the org's PRD template for GENERATE_PRD commands.
 * Ensures the template exists (lazy-seeds if missing) and returns it as a
 * context pack artifact so the agent can use it as a structural blueprint.
 */
async function fetchTemplateForCommand(
  loop: LoopForContextPack,
  organizationId: string
): Promise<ContextPack["artifacts"]> {
  if (loop.command !== LoopCommand.GeneratePrd) {
    return [];
  }

  let template = await documentTemplatesService.findOrgTemplate(
    organizationId,
    DocumentType.Prd
  );
  if (!template) {
    await documentTemplatesService.ensureDefaultTemplates(
      organizationId,
      loop.userId
    );
    template = await documentTemplatesService.findOrgTemplate(
      organizationId,
      DocumentType.Prd
    );
  }
  if (!template) {
    log.warn("[loop-context-pack] No PRD template found for org", {
      loopId: loop.id,
      organizationId,
    });
    return [];
  }

  const version = await documentVersionService.getLatest(template.id);
  return [
    {
      id: template.id,
      type: DocumentType.Template,
      title: template.title,
      content: version?.content ?? "",
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

/**
 * Fetch user-supplied additional context from ArtifactVersion v1.
 * Only fetched when the loop command is PLAN and an artifactId is present.
 */
async function fetchUserContext(
  loop: LoopForContextPack
): Promise<string | undefined> {
  if (loop.command !== LoopCommand.Plan || !loop.documentId) {
    return undefined;
  }

  // Version 1 contains the user's original context when entered at plan creation
  // time (e.g., via the "Generate PRD" flow). In the start-from-local path
  // (`/plans/start-loop-from-local`), version 1 is created with empty content
  // because that flow does not yet collect additional instructions — in that case
  // this returns undefined and userContext is omitted from the context pack.
  const version = await documentVersionService.getByVersion(loop.documentId, 1);
  const content = version?.content;

  if (!content?.trim()) {
    return undefined;
  }

  const USER_CONTEXT_MAX_LENGTH = 16_000;
  if (content.length > USER_CONTEXT_MAX_LENGTH) {
    log.warn("[loop-context-pack] User context truncated", {
      documentId: loop.documentId,
      originalLength: content.length,
    });
    return content.slice(0, USER_CONTEXT_MAX_LENGTH);
  }

  return content;
}

const ATTACHMENT_MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB per-file limit
const ATTACHMENT_MAX_TOTAL_BYTES = 50 * 1024 * 1024; // 50 MB total cap
const ATTACHMENT_MAX_FILES = ATTACHMENT_SIGNED_URL_MAX_FILES;

/**
 * Fetch file attachments to include in the context pack.
 *
 * Collects from two sources:
 * 1. Primary artifact attachments (when command declares includePrimaryArtifact)
 * 2. ContextRef attachments (features and artifacts referenced by the loop)
 *
 * Enforces per-file (25 MB), total (50 MB), and count (20 files) limits.
 * Deduplicates by attachment ID — primary artifact entries take precedence.
 *
 */
export async function fetchAttachmentsForContextPack(
  loop: LoopForContextPack,
  organizationId: string
): Promise<ContextPackAttachment[]> {
  // Path 1: primary artifact attachments
  let primaryAttachments: ContextPackAttachment[] = [];
  if (
    loop.documentId &&
    getCommandHandler(loop.command)?.includePrimaryArtifact
  ) {
    try {
      primaryAttachments =
        await attachmentsService.listWithSignedUrlsByDocument(
          loop.documentId,
          organizationId
        );
    } catch (error) {
      log.warn(
        "[loop-context-pack] Failed to fetch primary artifact attachments",
        {
          loopId: loop.id,
          error,
        }
      );
      primaryAttachments = [];
    }
  }

  // Path 2: contextRef attachments
  const contextRefAttachments = await collectContextRefAttachments(
    loop.contextRefs ?? [],
    organizationId,
    loop.id
  );

  // Deduplicate — primary artifact entries written first (take precedence)
  const deduped = new Map<string, ContextPackAttachment>();
  for (const attachment of primaryAttachments) {
    deduped.set(attachment.id, attachment);
  }
  for (const attachment of contextRefAttachments) {
    if (!deduped.has(attachment.id)) {
      deduped.set(attachment.id, attachment);
    }
  }

  return applyAttachmentLimits(deduped.values(), loop.id);
}

async function collectContextRefAttachments(
  contextRefs: NonNullable<LoopForContextPack["contextRefs"]>,
  organizationId: string,
  loopId: string
): Promise<ContextPackAttachment[]> {
  const result: ContextPackAttachment[] = [];
  for (const ref of contextRefs) {
    try {
      const refAttachments =
        await attachmentsService.listWithSignedUrlsByDocument(
          ref.sourceId,
          organizationId
        );
      result.push(...refAttachments);
    } catch (error) {
      log.warn("[loop-context-pack] Failed to fetch context ref attachments", {
        loopId,
        sourceId: ref.sourceId,
        sourceType: ref.sourceType,
        error,
      });
    }
  }
  return result;
}

function applyAttachmentLimits(
  attachments: IterableIterator<ContextPackAttachment>,
  loopId: string
): ContextPackAttachment[] {
  const result: ContextPackAttachment[] = [];
  let totalBytes = 0;

  for (const attachment of attachments) {
    if (attachment.sizeBytes > ATTACHMENT_MAX_FILE_BYTES) {
      log.warn(
        "[loop-context-pack] Attachment exceeds per-file size limit, skipping",
        {
          loopId,
          attachmentId: attachment.id,
          filename: attachment.filename,
          sizeBytes: attachment.sizeBytes,
          limitBytes: ATTACHMENT_MAX_FILE_BYTES,
        }
      );
      continue;
    }

    if (result.length >= ATTACHMENT_MAX_FILES) {
      log.warn(
        "[loop-context-pack] Attachment count cap reached, skipping remaining",
        {
          loopId,
          attachmentId: attachment.id,
          filename: attachment.filename,
          cap: ATTACHMENT_MAX_FILES,
        }
      );
      break;
    }

    if (totalBytes + attachment.sizeBytes > ATTACHMENT_MAX_TOTAL_BYTES) {
      log.warn(
        "[loop-context-pack] Attachment total size cap reached, skipping remaining",
        {
          loopId,
          attachmentId: attachment.id,
          filename: attachment.filename,
          totalBytes,
          limitBytes: ATTACHMENT_MAX_TOTAL_BYTES,
        }
      );
      break;
    }

    result.push(attachment);
    totalBytes += attachment.sizeBytes;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a ContextPack in memory without uploading to S3.
 * Used for both S3 upload (ECS) and inline dispatch (desktop).
 */
export async function buildContextPackInMemory(
  loop: LoopForContextPack,
  organizationId: string,
  secrets?: { anthropicApiKey?: string; githubToken?: string },
  committer?: { name: string; email: string },
  additionalRepos?: AdditionalRepoRefWithToken[]
): Promise<ContextPack> {
  const parentLoop = loop.parentLoopId
    ? await loopsService.findById(loop.parentLoopId, organizationId)
    : null;
  const [
    primaryArtifacts,
    refArtifacts,
    templateArtifacts,
    priorLoopSummaries,
    userContext,
    attachments,
  ] = await Promise.all([
    fetchPrimaryArtifact(loop, organizationId, parentLoop),
    fetchContextRefArtifacts(loop, organizationId),
    fetchTemplateForCommand(loop, organizationId),
    fetchParentLoopSummary(loop, parentLoop),
    fetchUserContext(loop),
    fetchAttachmentsForContextPack(loop, organizationId).catch((error) => {
      log.warn("[loop-context-pack] Failed to fetch attachments", {
        loopId: loop.id,
        error,
      });
      return [];
    }),
  ]);

  // Template first (structural blueprint), then context refs (Feature/PRD), then primary artifact
  const artifacts = [
    ...templateArtifacts,
    ...refArtifacts,
    ...primaryArtifacts,
  ];

  return {
    command: loop.command,
    prompt: loop.prompt ?? undefined,
    artifacts,
    repoInfo: loop.repo ?? undefined,
    priorLoopSummaries:
      priorLoopSummaries.length > 0 ? priorLoopSummaries : undefined,
    committer,
    secrets,
    userContext,
    attachments: attachments.length > 0 ? attachments : undefined,
    additionalRepos: additionalRepos?.length ? additionalRepos : undefined,
  };
}

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
  secrets?: { anthropicApiKey?: string; githubToken?: string },
  committer?: { name: string; email: string },
  additionalRepos?: AdditionalRepoRefWithToken[]
): Promise<string> {
  const contextPack = await buildContextPackInMemory(
    loop,
    organizationId,
    secrets,
    committer,
    additionalRepos
  );

  return uploadContextPack(stateKeyPrefix, contextPack);
}
