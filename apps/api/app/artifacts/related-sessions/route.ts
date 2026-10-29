import {
  RELATED_SESSIONS_DISPLAY_CAP,
  RELATED_SESSIONS_PAGE_ARTIFACT_CAP,
  type RelatedSessionsBatchResponse,
  supportsRelatedSessionsField,
} from "@repo/api/src/types/related-session";
import { z } from "zod";
import { agentSessionsService } from "@/app/agent-sessions/service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { artifactService } from "../artifact-service";

const relatedSessionsBatchRequestSchema = z
  .object({
    artifactIds: z
      .array(z.uuid())
      .transform((artifactIds) => [...new Set(artifactIds)]),
    sessionArtifactIds: z
      .array(z.uuid())
      .min(1)
      .max(RELATED_SESSIONS_PAGE_ARTIFACT_CAP)
      .transform((ids) => [...new Set(ids)].sort())
      .optional(),
    sessionSearch: z.string().trim().min(1).max(256).optional(),
  })
  .superRefine((request, context) => {
    if (request.artifactIds.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["artifactIds"],
        message: "At least one artifact id is required.",
      });
    }
    if (request.artifactIds.length > RELATED_SESSIONS_PAGE_ARTIFACT_CAP) {
      context.addIssue({
        code: "custom",
        path: ["artifactIds"],
        message: `Artifact id count must be at most ${RELATED_SESSIONS_PAGE_ARTIFACT_CAP}.`,
      });
    }
  });

/**
 * POST /artifacts/related-sessions — page-shaped Related Sessions batch read.
 *
 * The route intentionally omits missing, foreign-org, and Session artifact ids
 * from `results` so callers cannot distinguish those cases by response shape.
 * A present key with an empty result means the artifact resolved and had no
 * eligible related sessions.
 */
export const POST = withAnyAuth<
  RelatedSessionsBatchResponse,
  "/artifacts/related-sessions"
>(
  async ({ user }, request) => {
    try {
      const parsed = await parseBody(
        request,
        relatedSessionsBatchRequestSchema
      );
      if (parsed.errorResponse) {
        return parsed.errorResponse;
      }

      const artifacts = await artifactService.findByIds(
        parsed.body.artifactIds,
        user.organizationId
      );
      const supportedArtifactIds = artifacts
        .filter((artifact) => supportsRelatedSessionsField(artifact.type))
        .map((artifact) => artifact.id);
      const sessionArtifactIds = parsed.body.sessionArtifactIds;
      const sessionSearch = parsed.body.sessionSearch;
      const results =
        await agentSessionsService.listRelatedSessionsForArtifacts(
          user.organizationId,
          supportedArtifactIds,
          RELATED_SESSIONS_DISPLAY_CAP,
          {
            ...(sessionArtifactIds ? { sessionArtifactIds } : {}),
            ...(sessionSearch ? { sessionSearch } : {}),
          }
        );

      return successResponse({
        results,
        ...(sessionArtifactIds
          ? { appliedSessionArtifactIds: sessionArtifactIds }
          : {}),
        ...(sessionSearch ? { appliedSessionSearch: sessionSearch } : {}),
      });
    } catch (error) {
      return errorResponse("Failed to fetch related sessions", error);
    }
  },
  { requiredScopes: ["read"] }
);
