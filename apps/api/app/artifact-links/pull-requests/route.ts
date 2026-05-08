import type { JsonObject } from "@repo/api/src/types/common";
import { GitHubPRState } from "@repo/api/src/types/github";
import { withDb } from "@repo/database";
import { z } from "zod";
import { loadProjectRepoDefaults } from "@/app/projects/repository-resolver";
import { pullRequestService } from "@/app/pull-requests/pull-request-service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";

const createPrArtifactValidator = z.object({
  projectId: z.uuid(),
  workstreamId: z.uuid().nullable().optional(),
  title: z.string().min(1),
  externalUrl: z.string().min(1),
  number: z.number().int().positive(),
  githubId: z.string().min(1),
  headBranch: z.string().min(1),
  baseBranch: z.string().min(1),
  state: z.enum(GitHubPRState),
  isDraft: z.boolean().optional(),
});

type CreatePrArtifactResponse = { id: string };

/**
 * POST /artifact-links/pull-requests
 *
 * Idempotently create (or update) a PULL_REQUEST artifact for an existing
 * GitHub PR and return its id so the caller can follow up with a
 * POST /artifact-links to produce the source→PR link. Dedup is enforced in
 * `pullRequestService.upsertPullRequestArtifact` via the
 * PullRequestDetail.githubId unique constraint.
 *
 * The repositoryId is derived server-side from the project's default
 * repository setting so the client doesn't have to thread it through.
 */
export const POST = withAnyAuth<
  CreatePrArtifactResponse,
  "/artifact-links/pull-requests"
>(
  async ({ user }, request) => {
    try {
      const { body, errorResponse: parseError } = await parseBody(
        request,
        createPrArtifactValidator
      );
      if (parseError) {
        return parseError;
      }

      const project = await withDb((db) =>
        db.project.findUnique({
          where: { id: body.projectId, organizationId: user.organizationId },
          select: { id: true, settings: true },
        })
      );
      if (!project) {
        return notFoundResponse("Project");
      }

      const resolved = await loadProjectRepoDefaults({
        projectId: project.id,
        organizationId: user.organizationId,
        projectSettings: (project.settings ?? {}) as JsonObject,
      });
      if (!resolved) {
        return badRequestResponse(
          "Project has no primary repository configured"
        );
      }

      const result = await pullRequestService.upsertPullRequestArtifact({
        organizationId: user.organizationId,
        repositoryId: resolved.primary.installationRepositoryId,
        githubId: body.githubId,
        number: body.number,
        title: body.title,
        htmlUrl: body.externalUrl,
        headBranch: body.headBranch,
        baseBranch: body.baseBranch,
        prState: body.state,
        isDraft: body.isDraft ?? false,
        projectId: body.projectId,
        workstreamId: body.workstreamId ?? null,
      });

      if (!result.ok) {
        return notFoundResponse("Pull request artifact");
      }

      return successResponse({ id: result.value.id });
    } catch (error) {
      return errorResponse("Failed to create pull request artifact", error);
    }
  },
  { requiredScopes: ["write"] }
);
