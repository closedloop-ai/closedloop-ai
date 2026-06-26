import { LinkType } from "@repo/api/src/types/artifact";
import {
  type CreateDocumentInput,
  DocumentStatus,
  DocumentType,
} from "@repo/api/src/types/document";
import { LoopCommand } from "@repo/api/src/types/loop";
import { ArtifactType, withDb } from "@repo/database";
import { artifactLinksService } from "../artifact-links/service";
import { loopsService } from "../loops/service";
import { createDocumentRecord } from "./document-service";
import type { StartPlanLoopFromLocalResult } from "./document-utils";
import { documentGenerationService } from "./generation-service";
import { createDocumentRoom } from "./room-utils";

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
 * Document execution service. Owns the flow that launches a plan loop for a
 * feature from a local repository via the Loops runtime.
 */
export const documentExecutionService = {
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
