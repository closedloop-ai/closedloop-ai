import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import type { IssueWithWorkstream } from "@repo/api/src/types/issue";
import { withAuth } from "@/lib/auth/with-auth";
import {
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { mergeCustomFieldsIntoResponse } from "../../../custom-fields/route-helpers";
import { issuesService } from "../../service";

export const GET = withAuth<IssueWithWorkstream, "/issues/by-slug/[slug]">(
  async ({ user }, _, params) => {
    try {
      const { slug } = await params;

      const issue = await issuesService.findBySlug(slug, user.organizationId);

      if (!issue) {
        return notFoundResponse("Issue");
      }

      const response = await mergeCustomFieldsIntoResponse(
        issue,
        CustomFieldEntityType.Issue,
        user.organizationId
      );

      return successResponse(response);
    } catch (error) {
      return errorResponse("Failed to fetch issue", error);
    }
  }
);
