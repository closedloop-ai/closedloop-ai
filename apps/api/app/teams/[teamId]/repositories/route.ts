import type { TeamRepository } from "@repo/api/src/types/teams";
import { TeamRole } from "@repo/api/src/types/teams";
import { withAuth } from "@/lib/auth/with-auth";
import {
  badRequestResponse,
  conflictResponse,
  errorResponse,
  forbiddenResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { AddRepositoryError, teamsService } from "../../service";
import { addTeamRepositoryValidator } from "../../validators";

/**
 * GET /teams/:teamId/repositories - List repositories configured for a team.
 *
 * Org-readable, NOT team-membership gated (ISS-5095). A team's repository pool
 * is configuration of an org-readable team, and every surface that links here is
 * org-scoped: `GET /teams` lists the whole org (`findByOrganization`, no
 * membership filter), `GET /teams/:id` and `GET /teams/:id/members` have no
 * membership check, and `GET /projects/:id` 404s only out-of-org. Gating this
 * one read on membership inverted that — the Create-document modal fans out to
 * this route for every document type, so any org member opening it on a team
 * they are not on got a 403 that the shared query boundary laundered into a
 * full-shell "Your session expired" card.
 *
 * The real boundary is and stays the organization: `findById(teamId,
 * user.organizationId)` above 404s an out-of-org caller before any repository
 * row is read. Writes are unchanged — POST here and PUT/DELETE on
 * `[teamRepositoryId]` keep their team-admin role gates.
 *
 * SCOPE: this route, not the team. "Org-readable" above describes the repository
 * pool only, and does not generalise to everything reachable from a team.
 * Team-scoped Sessions reads (`GET /agent-sessions`, `/agent-sessions/usage`,
 * `/agent-sessions/analytics`) are still membership-gated by
 * `authorizeTeamScopeRead` (apps/api/lib/team-scope-policy.ts) and still answer
 * a bare 403 to a non-member. That is deliberate — session transcripts are not
 * team configuration — and it is now a per-surface authorization state for those
 * pages to render, rather than something that blanks the shell.
 */
export const GET = withAuth<TeamRepository[], "/teams/[teamId]/repositories">(
  async ({ user }, _, params) => {
    try {
      const { teamId } = await params;

      const team = await teamsService.findById(teamId, user.organizationId);
      if (!team) {
        return notFoundResponse("Team");
      }

      const repositories = await teamsService.getRepositories(teamId);
      return successResponse(repositories);
    } catch (error) {
      return errorResponse("Failed to fetch team repositories", error);
    }
  }
);

/**
 * POST /teams/:teamId/repositories - Add a repository to a team's curated list.
 * Requires team admin role.
 */
export const POST = withAuth<TeamRepository, "/teams/[teamId]/repositories">(
  async ({ user }, request, params) => {
    try {
      const { teamId } = await params;

      const team = await teamsService.findById(teamId, user.organizationId);
      if (!team) {
        return notFoundResponse("Team");
      }

      const hasPermission = await teamsService.hasRole(
        teamId,
        user.id,
        TeamRole.Admin
      );
      if (!hasPermission) {
        return forbiddenResponse();
      }

      const { body, errorResponse: parseError } = await parseBody(
        request,
        addTeamRepositoryValidator
      );
      if (parseError) {
        return parseError;
      }

      const result = await teamsService.addRepository(
        teamId,
        user.organizationId,
        body
      );

      if (!result.ok) {
        if (result.error === AddRepositoryError.RepoNotAvailable) {
          return badRequestResponse(
            "Repository is not available for this organization"
          );
        }
        return conflictResponse("Repository is already added to this team");
      }

      return successResponse(result.value);
    } catch (error) {
      return errorResponse("Failed to add team repository", error);
    }
  }
);
