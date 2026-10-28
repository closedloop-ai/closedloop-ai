import {
  BRANCH_NAME_MAX_LENGTH,
  BranchBaseBranchSource,
  BranchHeadShaSource,
  CLIENT_ASSERTABLE_BASE_BRANCH_SOURCE_ERROR,
  isClientAssertableBaseBranchSource,
} from "@repo/api/src/types/artifact";
import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import type { JsonObject } from "@repo/api/src/types/common";
import { withDb } from "@repo/database";
import { z } from "zod";
import { upsertBranchArtifactWithAttribution } from "@/app/branches/branch-upsert-with-attribution";
import { loadProjectRepoDefaults } from "@/app/projects/repository-resolver";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { branchUpsertReceiptWrite } from "./upsert-receipt";

const createBranchArtifactValidator = z.object({
  projectId: z.uuid(),
  sourceArtifactId: z.uuid().nullable().optional(),
  branchName: z.string().trim().min(1).max(BRANCH_NAME_MAX_LENGTH),
  defaultBranch: z.string().trim().min(1).nullable().optional(),
  baseBranch: z.string().trim().min(1).nullable().optional(),
  baseBranchSource: z
    .enum(BranchBaseBranchSource)
    .refine(isClientAssertableBaseBranchSource, {
      message: CLIENT_ASSERTABLE_BASE_BRANCH_SOURCE_ERROR,
    })
    .nullable()
    .optional(),
  headSha: z.string().trim().min(1).nullable().optional(),
  headShaSource: z.enum(BranchHeadShaSource).nullable().optional(),
});

type CreateBranchArtifactResponse = { id: string };

/**
 * POST /artifact-links/branches
 *
 * Branch-native materialization endpoint. The repository is derived from the
 * project default repository and the service owns org/source validation before
 * creating or updating the BRANCH artifact.
 */
export const POST = withAnyAuth<
  CreateBranchArtifactResponse,
  "/artifact-links/branches"
>(
  withOperationReceipts(
    OperationKind.Create,
    async ({ user }, request, _params, receipts) => {
      try {
        const { body, errorResponse: parseError } = await parseBody(
          request,
          createBranchArtifactValidator
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

        const result = await upsertBranchArtifactWithAttribution(
          {
            organizationId: user.organizationId,
            repositoryId: resolved.primary.installationRepositoryId,
            repositoryFullName: resolved.primary.fullName,
            branchName: body.branchName,
            defaultBranch: body.defaultBranch ?? null,
            projectId: body.projectId,
            sourceArtifactId: body.sourceArtifactId ?? null,
            baseBranch: body.baseBranch ?? null,
            baseBranchSource:
              body.baseBranchSource ?? BranchBaseBranchSource.RepositoryDefault,
            headSha: body.headSha ?? null,
            headShaSource: body.headShaSource ?? null,
          },
          receipts.whenRecording((tx, branch) =>
            receipts.record(tx, branchUpsertReceiptWrite(branch))
          )
        );

        if (!result.ok) {
          if (result.error === 400) {
            return badRequestResponse("Branch artifact input is invalid");
          }
          if (result.error === 403) {
            return badRequestResponse("Source artifact is not eligible");
          }
          return notFoundResponse("Branch artifact");
        }

        return successResponse(
          withOperationReceipt({ id: result.value.id }, receipts)
        );
      } catch (error) {
        return errorResponse("Failed to create branch artifact", error);
      }
    }
  ),
  { requiredScopes: ["write"] }
);
