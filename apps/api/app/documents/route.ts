import type {
  CreateDocumentResponse,
  DocumentListPage,
  DocumentWithProject,
} from "@repo/api/src/types/document";
import { forbiddenAttachmentUploadResponse } from "@/app/documents/attachment-route-responses";
import { isMcpAttachmentUploadEnabled } from "@/app/documents/attachment-upload-feature";
import { documentListService } from "@/app/documents/document-list-service";
import { documentService } from "@/app/documents/document-service";
import { captureArtifactCreation } from "@/lib/artifact-activity-capture";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  resolveArtifactIdentifier,
  resolveProjectId,
} from "@/lib/identifier-utils";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import {
  mapCreateDocumentFailure,
  parseCreateDocumentBody,
  shapeCreateDocumentResponse,
} from "./create-document-route-helpers";
import { findDocumentsQueryValidator } from "./validators";

/**
 * GET /documents - List documents
 * Accepts API key authentication (sk_live_) or Clerk session authentication.
 *
 * Returns a bare `DocumentWithProject[]` by default. A caller that pages passes
 * `includeTotal=true` and gets a {@link DocumentListPage} envelope instead — the
 * page plus a real server-side total (ISS-4576). The default shape is unchanged
 * so existing consumers (Documents index, pickers, MCP, version-skewed API
 * clients) are unaffected.
 *
 * FEA-1626 (epic FEA-908) added two OPT-IN narrowing dimensions that let a
 * client keep a power user's first paint bounded: `recencyDays=<n>` windows the
 * result to `updatedAt >= now - n days`, and `includeArchivedProjects=false`
 * drops artifacts whose parent project is `ARCHIVED`. Neither is a server-side
 * default: omitting a param means the long-standing full-history behavior, on
 * every arm. That polarity is required by the deploy boundary — `apps/app` and
 * this app ship independently, so a default applied here would narrow the
 * already-deployed old app's response before its feature flag could control it
 * (wongk review). Today the My Tasks board is the only caller that opts in, and
 * only behind `my-tasks-recency-window`.
 */
export const GET = withAnyAuth<
  DocumentWithProject[] | DocumentListPage,
  "/documents"
>(async ({ user }, request) => {
  try {
    const searchParams = request.nextUrl.searchParams;

    // Convert searchParams to plain object for validation
    const queryParams = Object.fromEntries(searchParams.entries());

    // Validate query parameters
    const parseResult = findDocumentsQueryValidator.safeParse(queryParams);

    if (!parseResult.success) {
      return badRequestResponse(
        `Invalid query parameters: ${parseResult.error.message}`
      );
    }

    const { projectId, includeTotal, ...restQuery } = parseResult.data;
    let resolvedProjectId: string | undefined;
    if (projectId) {
      const pId = await resolveProjectId(projectId, user.organizationId);
      if (!pId) {
        return notFoundResponse("Project");
      }
      resolvedProjectId = pId;
    }

    const findOptions = {
      organizationId: user.organizationId,
      projectId: resolvedProjectId,
      ...restQuery,
    };

    if (includeTotal) {
      return successResponse(
        await documentListService.findPageWithCustomFields(findOptions)
      );
    }

    const documents =
      await documentService.findAllWithCustomFields(findOptions);

    return successResponse(documents);
  } catch (error) {
    return errorResponse("Failed to fetch documents", error);
  }
});

export const POST = withAnyAuth<CreateDocumentResponse, "/documents">(
  async ({ authMethod, clerkUserId, user }, request) => {
    try {
      const { body, errorResponse: parseError } =
        await parseCreateDocumentBody(request);
      if (parseError) {
        return parseError;
      }

      const { inlineImages = [], ...createDocumentBody } = body;
      // Org-level artifacts (a generic Document or a Template) carry no
      // project (FEA-4345); the validator only requires a projectId for the
      // project-bound subtypes, so resolve one only when the body supplies it.
      let resolvedProjectId: string | undefined;
      if (createDocumentBody.projectId) {
        const pId = await resolveProjectId(
          createDocumentBody.projectId,
          user.organizationId
        );
        if (!pId) {
          return notFoundResponse("Project");
        }
        resolvedProjectId = pId;
      }
      let resolvedSourceId: string | undefined;
      if (createDocumentBody.sourceId) {
        const sId = await resolveArtifactIdentifier(
          createDocumentBody.sourceId,
          user.organizationId
        );
        if (!sId) {
          return notFoundResponse("Source artifact");
        }
        resolvedSourceId = sId;
      }

      const createInput = {
        ...createDocumentBody,
        projectId: resolvedProjectId,
        sourceId: resolvedSourceId,
      };
      const hasInlineImages = inlineImages.length > 0;
      if (
        hasInlineImages &&
        authMethod === "api_key" &&
        !(await isMcpAttachmentUploadEnabled({
          clerkUserId,
          userId: user.id,
        }))
      ) {
        return forbiddenAttachmentUploadResponse();
      }

      if (hasInlineImages) {
        const result = await documentService.createWithInlineImages(
          user.organizationId,
          user.id,
          createInput,
          inlineImages
        );
        if (!result.ok) {
          return mapCreateDocumentFailure(result.error);
        }
        // Capture the creation into the activity feed (FEA-3864). Best-effort,
        // non-blocking — never fails this write (defense-in-depth guard).
        try {
          captureArtifactCreation({
            organizationId: user.organizationId,
            artifactId: result.value.document.id,
            actor: { userId: user.id, authMethod },
            after: {
              status: result.value.document.status,
              title: result.value.document.title,
            },
          });
        } catch {
          // Swallowed by design: activity capture must never fail the write.
        }
        return successResponse(
          shapeCreateDocumentResponse(result.value.document, result.value)
        );
      }

      const document = await documentService.create(
        user.organizationId,
        user.id,
        createInput
      );
      if (!document) {
        return badRequestResponse("Failed to create document");
      }

      // Capture the creation into the activity feed (FEA-3864). Best-effort,
      // non-blocking — never fails this write (defense-in-depth guard).
      try {
        captureArtifactCreation({
          organizationId: user.organizationId,
          artifactId: document.id,
          actor: { userId: user.id, authMethod },
          after: { status: document.status, title: document.title },
        });
      } catch {
        // Swallowed by design: activity capture must never fail the write.
      }

      return successResponse(document);
    } catch (error) {
      return errorResponse("Failed to create document", error);
    }
  },
  { requiredScopes: ["write"] }
);
