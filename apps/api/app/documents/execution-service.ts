import { createId } from "@paralleldrive/cuid2";
import { LinkType } from "@repo/api/src/types/artifact";
import {
  type CreateDocumentInput,
  DocumentStatus,
  DocumentType,
} from "@repo/api/src/types/document";
import { LoopCommand } from "@repo/api/src/types/loop";
import { ArtifactType, withDb } from "@repo/database";
import { triggerWorkflowDispatch } from "@repo/github";
import { artifactLinksService } from "../artifact-links/service";
import { loopsService } from "../loops/service";
import {
  createDocumentRecord,
  findInstallationRepoId,
  getCommitterInfo,
} from "./document-service";
import {
  type ExecuteResult,
  isGitHubConfigured,
  type StartPlanLoopFromLocalResult,
} from "./document-utils";
import { documentVersionService } from "./document-version-service";
import { documentGenerationService } from "./generation-service";
import { createDocumentRoom } from "./room-utils";
import { documentWorkstreamService } from "./workstream-service";

const DEFAULT_BRANCH = "main";

type EarliestRecord = { id: string; createdAt: Date } | null;

/**
 * Find the earliest GitHub Action run for a document. Includes
 * PENDING/QUEUED/RUNNING/SUCCESS — any initiated run counts, because even
 * an in-flight plan locks the document to GH Actions.
 */
function findEarliestGhActionRun(
  documentId: string,
  workstreamId: string | null
): Promise<EarliestRecord> {
  if (!workstreamId) {
    return Promise.resolve(null);
  }
  return withDb((db) =>
    db.gitHubActionRun.findFirst({
      where: {
        workstreamId,
        status: { in: ["PENDING", "QUEUED", "RUNNING", "SUCCESS"] },
        triggerData: { path: ["documentId"], equals: documentId },
      },
      orderBy: { createdAt: "asc" },
      select: { id: true, createdAt: true },
    })
  );
}

/**
 * Resolve which implementation-plan artifact to use for a plan loop, creating
 * one if none exist. Returns an early-exit result when the caller should
 * return immediately, or `{ documentId }` to continue.
 */
async function resolveOrCreatePlanDocument(opts: {
  organizationId: string;
  userId: string;
  featureId: string;
  feature: { id: string; title: string; projectId: string };
  linkedPlans: { id: string; title: string }[];
  selectedDocumentId?: string;
  ticketTitle?: string;
}): Promise<
  | { outcome: "needs-selection"; documents: { id: string; title: string }[] }
  | {
      outcome: "invalid-document";
      existingDocuments: { id: string; title: string }[];
    }
  | { documentId: string }
> {
  const {
    organizationId,
    userId,
    featureId,
    feature,
    linkedPlans,
    selectedDocumentId,
    ticketTitle,
  } = opts;

  if (selectedDocumentId) {
    const isValid = linkedPlans.some((a) => a.id === selectedDocumentId);
    if (!isValid) {
      return { outcome: "invalid-document", existingDocuments: linkedPlans };
    }

    const artifact = await withDb((db) =>
      db.artifact.findUnique({
        where: { id: selectedDocumentId, organizationId },
        select: { type: true, subtype: true },
      })
    );
    if (
      artifact?.type !== ArtifactType.DOCUMENT ||
      artifact.subtype !== DocumentType.ImplementationPlan
    ) {
      return { outcome: "invalid-document", existingDocuments: linkedPlans };
    }

    const allLinkedPlanIds = linkedPlans.map((p) => p.id);
    await withDb.tx(async (tx) => {
      if (allLinkedPlanIds.length > 0) {
        await tx.artifactLink.deleteMany({
          where: {
            organizationId,
            sourceId: featureId,
            targetId: { in: allLinkedPlanIds },
            linkType: LinkType.Produces,
          },
        });
      }

      await tx.artifactLink.create({
        data: {
          organizationId,
          sourceId: featureId,
          targetId: selectedDocumentId,
          linkType: LinkType.Produces,
        },
      });
    });

    return { documentId: selectedDocumentId };
  }

  if (linkedPlans.length > 1) {
    return { outcome: "needs-selection", documents: linkedPlans };
  }

  if (linkedPlans.length === 1) {
    return { documentId: linkedPlans[0].id };
  }

  const title = ticketTitle ? `Plan: ${ticketTitle}` : `Plan: ${feature.title}`;
  const createInput: CreateDocumentInput = {
    type: DocumentType.ImplementationPlan,
    title,
    content: "",
    sourceId: featureId,
    projectId: feature.projectId,
    status: DocumentStatus.Draft,
  };
  const newDocument = await withDb.tx((tx) =>
    createDocumentRecord(tx, organizationId, userId, createInput)
  );
  if (!newDocument) {
    throw new Error("Failed to create implementation plan artifact");
  }
  await createDocumentRoom(newDocument);
  return { documentId: newDocument.id };
}

/**
 * Document execution service. Owns flows that move a plan toward shipped
 * code: triggering symphony-dispatch with command="execute", launching plan
 * loops, and reasoning about which execution backend (Loops vs GitHub
 * Actions) is canonical for a given document.
 */
export const documentExecutionService = {
  /**
   * Execute an approved implementation plan. Triggers the symphony-dispatch
   * workflow with command="execute" to generate code and create a PR.
   */
  async executeImplementationPlan(
    documentId: string,
    organizationId: string,
    userId: string
  ): Promise<ExecuteResult> {
    if (!isGitHubConfigured()) {
      return {
        success: false,
        error:
          "GitHub Actions integration is not configured. Cannot execute plan.",
        status: 500,
      };
    }

    const artifact =
      await documentGenerationService.findWithRegenerationContext(
        documentId,
        organizationId
      );

    if (!artifact) {
      return { success: false, error: "Artifact not found", status: 404 };
    }

    if (artifact.type !== DocumentType.ImplementationPlan) {
      return {
        success: false,
        error: "Only implementation plans can be executed",
        status: 400,
      };
    }

    if (artifact.status !== DocumentStatus.Approved) {
      return {
        success: false,
        error: "Plan must be approved before execution",
        status: 400,
      };
    }

    const { workstream, source } =
      await documentWorkstreamService.findOrCreateWorkstream(
        organizationId,
        artifact,
        userId
      );

    if (!(workstream || artifact.projectId)) {
      return {
        success: false,
        error: "Artifact must have a project to execute",
        status: 400,
      };
    }

    if (!(workstream && source?.content)) {
      return {
        success: false,
        error: "No PRD found for this plan. Cannot execute.",
        status: 400,
      };
    }

    const targetRepo = source.targetRepo ?? artifact.targetRepo;
    const targetBranch = source.targetBranch ?? DEFAULT_BRANCH;

    if (!targetRepo) {
      return {
        success: false,
        error: "No repository configured for this project or source artifact",
        status: 400,
      };
    }

    const repositoryId = await findInstallationRepoId(
      organizationId,
      targetRepo
    );
    if (!repositoryId) {
      return {
        success: false,
        error:
          "Repository not found in GitHub installation — ensure the GitHub App has access to this repository",
        status: 400,
      };
    }

    const existingRun = await documentGenerationService.findPendingWorkflowRun(
      workstream.id,
      "symphony-dispatch"
    );

    if (existingRun) {
      return {
        success: false,
        error: "A workflow is already in progress for this plan",
        status: 409,
      };
    }

    const correlationId = createId();

    const latestVersion = await documentVersionService.getLatest(documentId);
    const context = latestVersion?.content ?? "";

    // Create the action run records BEFORE triggering the workflow to avoid
    // races where the webhook fires before the records exist.
    await withDb(async (db) => {
      await Promise.all([
        db.gitHubActionRun.create({
          data: {
            workstreamId: workstream.id,
            repositoryId,
            runId: null,
            workflowName: "symphony-dispatch",
            status: "PENDING",
            htmlUrl: "",
            triggerEvent: "workflow_dispatch",
            triggerData: {
              correlationId: `${process.env.WEBAPP_ENV}-${correlationId}`,
              documentId,
              sourceId: source.id,
              sourceType: source.type,
              command: "execute",
            },
            sessionId: source.id,
            jobType: "execute",
            startedAt: new Date(),
          },
        }),
        db.workstreamEvent.create({
          data: {
            workstreamId: workstream.id,
            type: "GITHUB_ACTION_TRIGGERED",
            actorType: "system",
            data: {
              workflowName: "symphony-dispatch",
              command: "execute",
              correlationId,
              documentId,
              sourceId: source.id,
              sourceType: source.type,
              targetRepo,
              targetBranch,
            },
          },
        }),
      ]);
    });

    const committer = await getCommitterInfo(userId);

    const result = await triggerWorkflowDispatch({
      targetRepo,
      ref: targetBranch,
      command: "execute",
      context,
      correlationId,
      sessionId: source.id,
      ...committer,
    });

    if (!result.success) {
      return {
        success: false,
        error: `Failed to trigger plan execution: ${result.error}`,
        status: 500,
      };
    }

    return { success: true, correlationId };
  },

  /**
   * Assert that launching a Loop is allowed for this document. Returns a
   * descriptive message when the document was originally planned via GH
   * Actions (caller should return conflictResponse). Returns null when Loops
   * are allowed.
   */
  async assertLoopBackendAllowed(
    documentId: string,
    organizationId: string,
    workstreamId: string | null
  ): Promise<string | null> {
    const earliestGhAction = await findEarliestGhActionRun(
      documentId,
      workstreamId
    );

    if (!earliestGhAction) {
      return null;
    }

    const earlierLoop = await withDb((db) =>
      db.loop.findFirst({
        where: {
          artifactId: documentId,
          organizationId,
          status: "COMPLETED",
          createdAt: { lte: earliestGhAction.createdAt },
        },
        select: { id: true },
      })
    );

    if (earlierLoop) {
      return null;
    }

    return "This artifact was originally planned via GitHub Actions. Use the GitHub Actions path for subsequent operations to maintain state continuity.";
  },

  /**
   * Find or create an implementation-plan artifact for a feature, check for
   * an active PLAN loop, and return the information needed for the route
   * handler to launch a real PLAN loop. Called by
   * POST /plans/start-loop-from-local.
   */
  async startPlanLoopFromLocal(
    organizationId: string,
    userId: string,
    input: {
      featureId: string;
      ticketTitle?: string;
      computeTargetId: string;
      localRepoPath: string;
      repo?: { fullName: string; branch: string };
      selectedDocumentId?: string;
    }
  ): Promise<StartPlanLoopFromLocalResult> {
    const { featureId, ticketTitle, selectedDocumentId } = input;

    const feature = await withDb((db) =>
      db.artifact.findFirst({
        where: {
          id: featureId,
          organizationId,
          type: ArtifactType.DOCUMENT,
          subtype: DocumentType.Feature,
        },
        select: { id: true, name: true, projectId: true },
      })
    );
    if (!feature?.projectId) {
      throw new Error(`Feature not found: ${featureId}`);
    }
    const featureDoc = {
      id: feature.id,
      title: feature.name,
      projectId: feature.projectId,
    };

    const targetLinks = await artifactLinksService.findTargetLinks(
      organizationId,
      featureId,
      LinkType.Produces
    );

    const linkedDocumentIds = targetLinks.map((l) => l.targetId);

    let linkedPlans: { id: string; title: string }[] = [];
    if (linkedDocumentIds.length > 0) {
      const artifacts = await withDb((db) =>
        db.artifact.findMany({
          where: {
            id: { in: linkedDocumentIds },
            organizationId,
            type: ArtifactType.DOCUMENT,
            subtype: DocumentType.ImplementationPlan,
          },
          select: { id: true, name: true },
        })
      );
      linkedPlans = artifacts.map((a: { id: string; name: string }) => ({
        id: a.id,
        title: a.name,
      }));
    }

    const documentIdResult = await resolveOrCreatePlanDocument({
      organizationId,
      userId,
      featureId,
      feature: featureDoc,
      linkedPlans,
      selectedDocumentId,
      ticketTitle,
    });
    if ("outcome" in documentIdResult) {
      return documentIdResult;
    }
    const documentId = documentIdResult.documentId;

    const activeLoop = await loopsService.findOperationallyActiveLoop(
      documentId,
      LoopCommand.Plan,
      organizationId
    );
    if (activeLoop) {
      if (activeLoop.computeTargetId !== input.computeTargetId) {
        return {
          outcome: "already-active-conflict",
          activeLoop: {
            id: activeLoop.id,
            command: activeLoop.command,
            status: activeLoop.status,
          },
        };
      }

      const existingLocalRepoPath =
        typeof activeLoop.metadata?.localRepoPath === "string"
          ? activeLoop.metadata.localRepoPath
          : null;

      const slugResult = await withDb((db) =>
        db.artifact.findUnique({
          where: { id: documentId, organizationId },
          select: { slug: true },
        })
      );
      const documentSlug = slugResult?.slug ?? documentId;
      if (!existingLocalRepoPath) {
        return { outcome: "error", reason: "missing-local-path" };
      }
      return {
        outcome: "already-running",
        loopId: activeLoop.id,
        documentId,
        documentSlug,
        localRepoPath: existingLocalRepoPath,
      };
    }

    const artifact =
      await documentGenerationService.findWithRegenerationContext(
        documentId,
        organizationId
      );
    if (!artifact) {
      throw new Error(`Artifact not found after create/find: ${documentId}`);
    }

    return {
      outcome: "ready-to-launch",
      documentId,
      documentSlug: artifact.slug,
      document: artifact,
    };
  },
};
