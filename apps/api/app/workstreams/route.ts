import type { CustomFieldValueDetail } from "@repo/api/src/types/custom-field";
import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import type {
  Workstream,
  WorkstreamState,
} from "@repo/api/src/types/workstream";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { customFieldValuesService } from "../custom-fields/values-service";
import { projectsService } from "../projects/service";
import { workstreamsService } from "./service";
import { createWorkstreamValidator } from "./validators";

/**
 * GET /workstreams - List workstreams for a project
 * Accepts API key authentication (sk_live_) or Clerk session authentication.
 */
export const GET = withAnyAuth<
  (Workstream & { customFields: CustomFieldValueDetail[] })[],
  "/workstreams"
>(async ({ user }, request) => {
  try {
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get("projectId");
    const state = searchParams.get("state");
    const search = searchParams.get("search");
    const limit = searchParams.get("limit");

    if (!projectId) {
      return badRequestResponse("projectId is required");
    }

    const project = await projectsService.findById(
      projectId,
      user.organizationId
    );

    if (!project) {
      return notFoundResponse("Project");
    }

    const workstreams = await workstreamsService.findByProject({
      organizationId: user.organizationId,
      projectId,
      state: state as WorkstreamState | undefined,
      search: search ?? undefined,
      limit: limit ? Number.parseInt(limit, 10) : undefined,
    });

    // Batch-load custom field values for all workstreams in a single query
    const workstreamIds = workstreams.map((w) => w.id);
    const allValues =
      workstreamIds.length > 0
        ? await customFieldValuesService.getValuesForEntity(
            CustomFieldEntityType.Workstream,
            workstreamIds,
            user.organizationId
          )
        : [];

    const valuesByEntityId = new Map(
      workstreams.map((w) => [w.id, [] as CustomFieldValueDetail[]])
    );
    for (const value of allValues) {
      const list = valuesByEntityId.get(value.entityId);
      if (list) {
        list.push(value);
      }
    }

    const workstreamsWithFields = workstreams.map((w) => ({
      ...w,
      customFields: valuesByEntityId.get(w.id) ?? [],
    }));

    return successResponse(workstreamsWithFields);
  } catch (error) {
    return errorResponse("Failed to fetch workstreams", error);
  }
});

export const POST = withAnyAuth<Workstream, "/workstreams">(
  async ({ user }, request) => {
    try {
      const { body, errorResponse: parseError } = await parseBody(
        request,
        createWorkstreamValidator
      );
      if (parseError) {
        return parseError;
      }

      const project = await projectsService.findById(
        body.projectId,
        user.organizationId
      );

      if (!project) {
        return notFoundResponse("Project");
      }

      const workstream = await workstreamsService.create(
        user.organizationId,
        user.id,
        body
      );

      return successResponse(workstream);
    } catch (error) {
      return errorResponse("Failed to create workstream", error);
    }
  },
  { requiredScopes: ["write"] }
);
