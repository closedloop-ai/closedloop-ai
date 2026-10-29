import type { ProjectWithDetails } from "@repo/api/src/types/project";
import type { ProjectTeamOption } from "@repo/api/src/types/teams";
import type { DocumentRowData } from "@repo/app/documents/lib/artifact-row-adapter";

/**
 * The terminal-state decisions the project detail route makes before it renders,
 * extracted so the route itself stays under the complexity ceiling and these stay
 * readable next to `project-artifacts-pagination.ts`.
 */

/**
 * The project descriptor the artifact-row adapter needs, or `null` before the
 * project has loaded.
 *
 * Typed against `DocumentRowData["project"]` and `ProjectTeamOption` rather than
 * a hand-written shape, so a change to either canonical type fails here instead
 * of silently disagreeing with the table this feeds.
 *
 * `teams` is omitted rather than emitted empty whenever the team is unknown —
 * still loading, or a read that settled and FAILED, which is the ISS-8588 case.
 * An empty array would tell the row adapter the project belongs to no team,
 * which is a claim; absence is only "not known here".
 */
export function buildRowProject(
  project: ProjectWithDetails | undefined,
  teamData: ProjectTeamOption | undefined
): DocumentRowData["project"] {
  if (!project) {
    return null;
  }
  if (teamData) {
    return {
      id: project.id,
      name: project.name,
      teams: [{ id: teamData.id, name: teamData.name }],
    };
  }
  return { id: project.id, name: project.name };
}

/**
 * A pending ISS-8588 canonicalization counts as in-flight: the team read has
 * genuinely failed by then, so treating it as settled would flash "Project not
 * found" over a project that exists and is one history replacement away.
 */
export function isProjectPagePending(
  loading: boolean,
  permalinkRedirect: string | null
): boolean {
  return loading || permalinkRedirect !== null;
}
