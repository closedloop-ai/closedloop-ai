import { ArtifactStatus, ArtifactType } from "@repo/api/src/types/artifact";
import type {
  GDriveContextImportResult,
  ImportGDriveContextResponse,
} from "@repo/api/src/types/context-attachment";
import { EntityType, LinkType } from "@repo/api/src/types/entity-link";
import { exportDocAsMarkdown, getDocName } from "@repo/google";
import { log } from "@repo/observability/log";
import pLimit from "p-limit";
import sanitizeHtml from "sanitize-html";
import { artifactsService } from "@/app/artifacts/service";
import { entityLinksService } from "@/app/entity-links/service";
import {
  ensureValidAccessToken,
  googleService,
} from "@/app/integrations/google/service";
import { issuesService } from "@/app/issues/service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { importGDriveContextValidator } from "../validators";

/**
 * POST /issues/[id]/context-attachments/gdrive
 *
 * Import one or more Google Drive documents as PRD artifacts linked to an issue.
 * Requires docIds and projectId in request body.
 * Returns per-document success/failure results.
 */
export const POST = withAnyAuth<
  ImportGDriveContextResponse,
  "/issues/[id]/context-attachments/gdrive"
>(async ({ user }, request, params) => {
  const { id: issueId } = await params;

  const { body, errorResponse: parseError } = await parseBody(
    request,
    importGDriveContextValidator
  );

  if (parseError) {
    return parseError;
  }

  // Validate issue exists
  const issue = await issuesService.findById(issueId, user.organizationId);
  if (!issue) {
    return notFoundResponse("Issue");
  }

  // Fetch Google integration
  const googleIntegration = await googleService.getIntegration(
    user.organizationId
  );

  if (!googleIntegration) {
    return errorResponse(
      "Google Drive is not connected. Please connect in settings.",
      null,
      400
    );
  }

  const tokenResult = await ensureValidAccessToken(
    googleIntegration,
    user.organizationId,
    "[google/gdrive-context]"
  );

  if (!tokenResult.success) {
    return errorResponse(tokenResult.error, null, 401);
  }

  const { accessToken } = tokenResult;
  const limit = pLimit(5);
  const successResults: GDriveContextImportResult[] = [];
  const failures: GDriveContextImportResult[] = [];

  const MAX_CONTENT_SIZE = 1024 * 1024; // 1MB
  const SANITIZE_OPTIONS = {
    allowedTags: [
      "b", "i", "em", "strong", "p", "ul", "ol", "li",
      "h1", "h2", "h3", "h4", "h5", "h6", "a", "code",
      "pre", "blockquote", "br", "hr",
      "table", "thead", "tbody", "tr", "th", "td",
    ],
    allowedAttributes: { a: ["href"] },
    allowedSchemes: ["http", "https"],
  };

  const importPromises = body.docIds.map((docId) =>
    limit(async () => {
      try {
        // Fetch doc name and content in parallel
        const [docName, markdown] = await Promise.all([
          getDocName(docId, accessToken),
          exportDocAsMarkdown(docId, accessToken),
        ]);

        // Sanitize and enforce size limit
        let content = sanitizeHtml(markdown, SANITIZE_OPTIONS);
        if (content.length > MAX_CONTENT_SIZE) {
          content = content.substring(0, MAX_CONTENT_SIZE);
          log.warn("[gdrive-context] Truncated doc to 1MB", {
            docId,
            originalSize: markdown.length,
          });
        }

        // Create PRD artifact with actual doc content
        const artifact = await artifactsService.create(
          user.organizationId,
          user.id,
          {
            type: ArtifactType.Prd,
            status: ArtifactStatus.Draft,
            projectId: body.projectId,
            title: docName ?? docId,
            content,
            fileName: `${docName ?? docId}.md`,
          }
        );

        if (!artifact) {
          failures.push({
            docId,
            error: "Failed to create artifact",
          });
          return;
        }

        // Link artifact to issue — clean up artifact on failure
        try {
          await entityLinksService.createLink(user.organizationId, {
            sourceId: artifact.id,
            sourceType: EntityType.Artifact,
            targetId: issueId,
            targetType: EntityType.Issue,
            linkType: LinkType.RelatesTo,
          });
        } catch (linkError) {
          await artifactsService.delete(artifact.id, user.organizationId);
          throw linkError;
        }

        successResults.push({ docId, artifactId: artifact.id });
      } catch (error) {
        failures.push({
          docId,
          error:
            error instanceof Error
              ? error.message
              : "Failed to import document",
        });
      }
    })
  );

  await Promise.all(importPromises);

  return successResponse({
    results: [...successResults, ...failures],
  });
});
