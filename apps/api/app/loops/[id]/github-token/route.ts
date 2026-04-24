import { verifyLoopRunnerToken } from "@repo/auth/loop-runner-jwt";
import { z } from "zod";
import { extractBearerToken } from "@/lib/auth/loop-runner-jwt";
import { resolveGitHubToken } from "@/lib/loops/loop-orchestrator";
import { errorResponse, successResponse } from "@/lib/route-utils";
import { loopsService } from "../../service";
import { additionalReposSchema } from "../../validators";

const githubTokenBodySchema = z.object({
  additionalRepos: additionalReposSchema,
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

    const token = extractBearerToken(request);
    if (token instanceof Response) {
      return token;
    }

    const claims = await verifyLoopRunnerToken(token);
    if (claims.loopId !== loopId) {
      return errorResponse(
        "Token does not match loop",
        new Error("Forbidden"),
        403
      );
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
    let bodyAdditionalRepos: z.infer<typeof additionalReposSchema>;
    try {
      const rawBody = await request.json();
      const parsed = githubTokenBodySchema.safeParse(rawBody);
      if (parsed.success) {
        bodyAdditionalRepos = parsed.data.additionalRepos;
      }
    } catch {
      // Body absent or not valid JSON — use DB value as fallback
    }

    // Resolve the primary and additional-repo tokens in parallel. Each
    // resolveGitHubToken() call is an independent GitHub App installation-token
    // round-trip, so serializing them would add 100-500ms per additional repo
    // to a latency-sensitive refresh path (the harness calls this endpoint
    // when its installation token is near expiry).
    const additionalRepos =
      bodyAdditionalRepos !== undefined
        ? bodyAdditionalRepos
        : (loop.additionalRepos ?? []);
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
