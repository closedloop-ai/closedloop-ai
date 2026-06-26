import { z } from "zod";
import { authenticateLoopRunnerRequest } from "@/lib/auth/loop-runner-jwt";
import { resolveGitHubToken } from "@/lib/loops/loop-orchestrator";
import { errorResponse, successResponse } from "@/lib/route-utils";
import { loopsService } from "../../service";
import { tokenRefreshAdditionalReposSchema } from "../../validators";

const githubTokenBodySchema = z.object({
  additionalRepos: tokenRefreshAdditionalReposSchema,
});

/**
 * POST /api/loops/:id/github-token - Issue a fresh GitHub installation token.
 *
 * Called by the container harness when its pre-generated token is about to
 * expire (GitHub App installation tokens last 1 hour). Authenticated via the
 * same loop-runner JWT used for event reporting.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const { id: loopId } = await params;

    const claims = await authenticateLoopRunnerRequest(
      request,
      loopId,
      "loops/[id]/github-token"
    );
    if (claims instanceof Response) {
      return claims;
    }

    const loop = await loopsService.findById(loopId, claims.organizationId);
    if (!loop) {
      return errorResponse("Loop not found", new Error("Not Found"), 404);
    }

    if (!loop.repo?.fullName) {
      return errorResponse(
        "Loop has no linked repository",
        new Error("Bad Request"),
        400
      );
    }

    // Parse optional request body — body may be absent on older harness versions.
    // A missing/empty/invalid body is not an error; fall back to the DB record.
    let bodyAdditionalRepos: z.infer<typeof tokenRefreshAdditionalReposSchema>;
    try {
      const rawBody = await request.json();
      const parsed = githubTokenBodySchema.safeParse(rawBody);
      if (parsed.success) {
        bodyAdditionalRepos = parsed.data.additionalRepos;
      }
    } catch {
      // Body absent or not valid JSON — use DB value as fallback
    }

    // Body-provided additionalRepos must be a strict subset of the loop's
    // DB-authorized list (authorized via authorizeAdditionalRepos at loop
    // creation). Without this check, a compromised harness holding a valid
    // loop-runner JWT could request tokens for any repo the org's GitHub App
    // installation covers, escalating beyond the loop's authorized scope.
    const authorizedAdditionalRepos = loop.additionalRepos ?? [];
    if (bodyAdditionalRepos !== undefined) {
      const authorizedKeys = new Set(
        authorizedAdditionalRepos.map((r) => `${r.fullName}:${r.branch}`)
      );
      const unauthorized = bodyAdditionalRepos.filter(
        (r) => !authorizedKeys.has(`${r.fullName}:${r.branch}`)
      );
      if (unauthorized.length > 0) {
        return errorResponse(
          "Additional repos not authorized for this loop",
          new Error("Forbidden"),
          403
        );
      }
    }

    // Resolve the primary and additional-repo tokens in parallel. Each
    // resolveGitHubToken() call is an independent GitHub App installation-token
    // round-trip, so serializing them would add 100-500ms per additional repo
    // to a latency-sensitive refresh path (the harness calls this endpoint
    // when its installation token is near expiry).
    const additionalRepos =
      bodyAdditionalRepos === undefined
        ? authorizedAdditionalRepos
        : bodyAdditionalRepos;
    const [freshToken, additionalRepoTokens] = await Promise.all([
      resolveGitHubToken(claims.organizationId, loop.repo.fullName),
      Promise.all(
        additionalRepos.map(async (ref) => ({
          fullName: ref.fullName,
          token: await resolveGitHubToken(claims.organizationId, ref.fullName),
        }))
      ),
    ]);

    return successResponse({ token: freshToken, additionalRepoTokens });
  } catch (error) {
    return errorResponse("Failed to generate GitHub token", error);
  }
}
