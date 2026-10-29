import {
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import {
  ProjectStatus as ProjectStatusValues,
  type ProjectWithDetails,
} from "@repo/api/src/types/project";
import { z } from "zod";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import {
  badRequestResponse,
  errorResponse,
  parseBody,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import { customFieldValuesService } from "../custom-fields/values-service";
import { parseProjectStatuses } from "./project-route-helpers";
import {
  InvalidProjectTeamsError,
  InvalidProjectTeamsReason,
  projectsService,
} from "./service";
import {
  TeamRequirementVerb,
  teamRequirementErrorResponse,
  unresolvedTeamErrorResponse,
} from "./team-requirement";
import { createProjectValidator } from "./validators";

/**
 * GET /projects - List all projects
 * Accepts API key authentication (sk_live_) or Clerk session authentication.
 * Query params:
 *   - teamId: Filter by team
 *   - limit: Maximum number of projects to return (1-100, only applies when teamId is provided)
 *   - status: Optional project status filter (comma-delimited)
 *   - excludeStatus: Optional excluded project status filter (comma-delimited)
 */
export const GET = withAnyAuth<ProjectWithDetails[], "/projects">(
  async ({ user }, request) => {
    try {
      const querySchema = z
        .object({
          teamId: z.string().optional(),
          limit: z.coerce.number().int().positive().max(100).optional(),
          status: z.string().optional(),
          excludeStatus: z.string().optional(),
        })
        .strict();

      const { params, errorResponse: queryError } = parseQueryParams(
        request,
        querySchema
      );
      if (queryError) {
        return queryError;
      }

      const { teamId, limit, status, excludeStatus } = params;
      const statusFilter = parseProjectStatuses(status);
      const excludeStatusFilter = parseProjectStatuses(excludeStatus);

      const hasExplicitStatusFilter =
        statusFilter !== undefined || excludeStatusFilter !== undefined;
      const defaultExcludeStatus = hasExplicitStatusFilter
        ? undefined
        : [ProjectStatusValues.Archived];
      const listOptions = {
        ...(limit ? { limit } : {}),
        ...(statusFilter ? { status: statusFilter } : {}),
        ...(excludeStatusFilter ? { excludeStatus: excludeStatusFilter } : {}),
        ...(defaultExcludeStatus
          ? { excludeStatus: defaultExcludeStatus }
          : {}),
      };

      // Determine which service method to call based on parameters
      const projects = teamId
        ? await projectsService.findByTeam(
            teamId,
            user.organizationId,
            listOptions
          )
        : await projectsService.findByOrganization(
            user.organizationId,
            listOptions
          );

      // Batch-load custom field values for all projects in a single query
      const projectIds = projects.map((p) => p.id);
      const allValues =
        projectIds.length > 0
          ? await customFieldValuesService.getValuesForEntity(
              CustomFieldEntityType.Project,
              projectIds,
              user.organizationId
            )
          : [];

      const valuesByEntityId = new Map(
        projects.map((p) => [p.id, [] as typeof allValues])
      );
      for (const value of allValues) {
        const list = valuesByEntityId.get(value.entityId);
        if (list) {
          list.push(value);
        }
      }

      const projectsWithFields = projects.map((p) => ({
        ...p,
        customFields: valuesByEntityId.get(p.id) ?? [],
      }));

      return successResponse(projectsWithFields);
    } catch (error) {
      return errorResponse("Failed to fetch projects", error);
    }
  }
);

/**
 * POST /projects - Create a new project
 */
export const POST = withAnyAuth<ProjectWithDetails, "/projects">(
  withOperationReceipts(
    OperationKind.ProjectWrite,
    async ({ user }, request, _params, receipts) => {
      try {
        const {
          body,
          rawBody,
          errorResponse: parseError,
          issues,
        } = await parseBody(request, createProjectValidator);
        if (parseError) {
          return (
            (await teamRequirementErrorResponse({
              issues,
              rawBody,
              organizationId: user.organizationId,
              verb: TeamRequirementVerb.Create,
            })) ?? parseError
          );
        }

        const created = await projectsService.create(
          user.organizationId,
          user.id,
          body,
          receipts.whenRecording((tx) =>
            receipts.record(tx, {
              operationKind: OperationKind.ProjectWrite,
              outcome: OperationReceiptOutcome.Committed,
            })
          )
        );
        if (!created.ok) {
          return badRequestResponse(created.error.message);
        }
        const project = created.value;

        // Fetch the full project with details
        const projectWithDetails = await projectsService.findById(
          project.id,
          user.organizationId
        );

        if (!projectWithDetails) {
          return errorResponse(
            "Project created but could not be retrieved",
            new Error("Project not found")
          );
        }

        return successResponse(
          withOperationReceipt(projectWithDetails, receipts)
        );
      } catch (error) {
        if (error instanceof InvalidProjectTeamsError) {
          // Only the unresolved reason is fixable by picking a different team;
          // the over-cap refusal gets no roster, since more teams cannot fix it.
          if (error.reason === InvalidProjectTeamsReason.Unresolved) {
            return await unresolvedTeamErrorResponse({
              message: error.message,
              organizationId: user.organizationId,
              verb: TeamRequirementVerb.Create,
            });
          }
          return badRequestResponse(error.message);
        }
        return errorResponse("Failed to create project", error);
      }
    }
  ),
  { requiredScopes: ["write"] }
);
