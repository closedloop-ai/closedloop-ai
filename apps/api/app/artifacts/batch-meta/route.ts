import {
  type ArtifactTitleMap,
  BATCH_META_MAX_SLUGS,
} from "@repo/api/src/types/artifact";
import { z } from "zod";
import { withAuth } from "@/lib/auth/with-auth";
import {
  badRequestResponse,
  errorResponse,
  successResponse,
} from "@/lib/route-utils";
import { artifactsService } from "../service";

const MAX_SLUGS = BATCH_META_MAX_SLUGS;

const batchMetaQueryValidator = z.object({
  slugs: z
    .string()
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    )
    .pipe(z.array(z.string()).min(1, "slugs must not be empty")),
});

/**
 * GET /artifacts/batch-meta?slugs=slug1,slug2,...
 * Returns a map of slug -> title for all provided slugs found in the organization.
 * Accepts a comma-separated list of artifact slugs (max 50).
 * Slugs not found in the org are omitted from the response.
 * Authentication required.
 */
export const GET = withAuth<ArtifactTitleMap, "/artifacts/batch-meta">(
  async ({ user }, request) => {
    try {
      const rawSlugs = request.nextUrl.searchParams.get("slugs");

      if (!rawSlugs) {
        return badRequestResponse("slugs query parameter is required");
      }

      const parseResult = batchMetaQueryValidator.safeParse({
        slugs: rawSlugs,
      });

      if (!parseResult.success) {
        return badRequestResponse(
          `Invalid query parameters: ${parseResult.error.message}`
        );
      }

      const slugs = parseResult.data.slugs;

      if (slugs.length > MAX_SLUGS) {
        return badRequestResponse(
          `Too many slugs: maximum ${MAX_SLUGS} allowed, got ${slugs.length}`
        );
      }

      const titlesMap = await artifactsService.batchFetchArtifactTitles(
        user.organizationId,
        slugs
      );

      return successResponse<ArtifactTitleMap>(titlesMap);
    } catch (error) {
      return errorResponse("Failed to fetch artifact titles", error);
    }
  }
);
