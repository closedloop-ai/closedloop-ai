import type { IssueWithWorkstream } from "@repo/api/src/types/issue";
import { withAuth } from "@/lib/auth/with-auth";
import {
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { issuesService } from "../../service";

export const GET = withAuth<IssueWithWorkstream, "/issues/by-slug/[slug]">(
  async ({ user }, _, params) => {
    try {
      const { slug } = await params;

      const issue = await issuesService.findBySlug(slug, user.organizationId);

      if (!issue) {
        return notFoundResponse("Issue");
      }

      return successResponse(issue);
    } catch (error) {
      return errorResponse("Failed to fetch issue", error);
    }
  }
);
