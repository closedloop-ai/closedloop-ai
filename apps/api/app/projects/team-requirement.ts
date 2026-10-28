import type { ApiResult } from "@repo/api/src/types/common";
import { ProjectErrorCode } from "@repo/api/src/types/project";
import type { ProjectTeamOption } from "@repo/api/src/types/teams";
import { log } from "@repo/observability/log";
import type { NextResponse } from "next/server";
import type { z } from "zod";
import { teamsService } from "@/app/teams/service";
import {
  badRequestResponse,
  formatZodErrors,
  scheduleLogFlush,
} from "@/lib/route-utils";
import { isRecord } from "@/lib/type-guards";
import { TEAM_REQUIRED_MESSAGE } from "./validators";

/**
 * Which route is refusing, so the remediation sentence can name the action the
 * caller was actually attempting.
 */
export const TeamRequirementVerb = {
  Create: "create",
  Update: "update",
} as const;
export type TeamRequirementVerb =
  (typeof TeamRequirementVerb)[keyof typeof TeamRequirementVerb];

/**
 * Character budget for the team roster inside the human-readable message.
 *
 * `details.teams` always carries the complete list, but `apps/mcp` strips
 * `details` (FEA-2550), so this sentence is the only roster an MCP agent
 * actually receives. The budget exists to keep the response bounded, not to
 * curate the choice set, and is sized so a realistic org never reaches it.
 *
 * It is no longer the *complete* choice set, and does not have to be: the
 * `list-teams` MCP tool is (ISS-6966). When the budget bites, the omission is
 * stated with a count and points at that tool, so a team this sentence cannot
 * name is still a team the caller can reach.
 */
const TEAM_ROSTER_MESSAGE_BUDGET = 4000;

/**
 * Upper bound on how many individual Zod issues any message here renders.
 *
 * `teamIds` is caller-supplied and Zod reports one issue per bad element, so an
 * unbounded render lets a write-scoped caller dictate the response size.
 */
const MAX_ISSUES_RENDERED = 10;

const TEAM_IDS_FIELD = "teamIds";

/**
 * Build the 400 for a request that failed because it named no usable team.
 *
 * Returns `null` when the validation failure was something else, so the caller
 * forwards the plain Zod 400 untouched. That gating is the point: `AGENTS.md`
 * forbids attaching remediation metadata to denials the remediation cannot fix,
 * so a bad `name` must not come back carrying a team roster.
 */
export async function teamRequirementErrorResponse(params: {
  issues: z.core.$ZodIssue[] | undefined;
  rawBody: unknown;
  organizationId: string;
  verb: TeamRequirementVerb;
}): Promise<NextResponse<ApiResult<never>> | null> {
  const { issues, rawBody, organizationId, verb } = params;
  if (!issues?.length) {
    return null;
  }

  const { teamIssues, otherIssues, overCapIssue } = partitionIssues(
    issues,
    rawBody
  );

  // Over-cap outranks every other team issue: naming a different team cannot
  // fix "too many teams", so this denial gets no roster (`apps/api/AGENTS.md`
  // L110). It also answers here rather than falling through to the plain Zod
  // 400, because that one renders every bad element and an over-cap array is
  // exactly the request with the most of them.
  if (overCapIssue) {
    return badRequestResponse(
      joinParts([
        renderIssues([overCapIssue]),
        trailingIssues([...teamIssues, ...otherIssues]),
      ])
    );
  }

  if (teamIssues.length === 0) {
    return null;
  }

  const teams = await listTeamOptionsOrNull(organizationId);
  if (!teams) {
    return null;
  }

  // Every other field error rides along, so a caller that fixes the team does
  // not immediately earn a second 400 about a field we already knew was wrong.
  return teamRequirementResponse(
    joinParts([
      teamIssueMessage(teamIssues),
      remediationSentence(teams, verb),
      trailingIssues(otherIssues),
    ]),
    teams
  );
}

/**
 * The 400 for a team id that was well-formed but did not resolve inside the
 * caller's organization — thrown from the service after validation passed.
 *
 * `message` is the service's own text and is passed through verbatim: it
 * deliberately does not distinguish "no such team" from "team in another
 * organization" so a caller cannot probe for foreign team ids, and the rejected
 * id is never echoed back. Keep it that way.
 */
export async function unresolvedTeamErrorResponse(params: {
  message: string;
  organizationId: string;
  verb: TeamRequirementVerb;
}): Promise<NextResponse<ApiResult<never>>> {
  const { message, organizationId, verb } = params;
  const teams = await listTeamOptionsOrNull(organizationId);
  if (!teams) {
    return badRequestResponse(message);
  }
  return teamRequirementResponse(
    `${message} ${remediationSentence(teams, verb)}`,
    teams
  );
}

/**
 * Read the org's teams for remediation, or `null` when that read fails.
 *
 * The roster is remediation, not the denial. The request was invalid either
 * way, so a failure here must not upgrade a client error into a 500 — both
 * callers fall back to the plain 400. This runs inside the POST route's `try`
 * and inside the PUT route's `catch`, so an escaping rejection would surface as
 * "Failed to create project" or as an auth-layer 500 respectively.
 */
async function listTeamOptionsOrNull(
  organizationId: string
): Promise<ProjectTeamOption[] | null> {
  try {
    return await teamsService.listTeamOptions(organizationId);
  } catch (error) {
    log.error("Failed to load team roster for project team remediation", {
      error,
      organizationId,
    });
    scheduleLogFlush();
    return null;
  }
}

/**
 * Split the failure's issues into the ones that mean "you named no usable team",
 * the over-cap issue if present, and everything else — in one pass, because the
 * issue list is caller-sized and a filter-plus-`includes` partition over it is
 * quadratic.
 */
function partitionIssues(
  issues: z.core.$ZodIssue[],
  rawBody: unknown
): {
  teamIssues: z.core.$ZodIssue[];
  otherIssues: z.core.$ZodIssue[];
  overCapIssue: z.core.$ZodIssue | null;
} {
  const teamIssues: z.core.$ZodIssue[] = [];
  const otherIssues: z.core.$ZodIssue[] = [];
  let overCapIssue: z.core.$ZodIssue | null = null;

  for (const issue of issues) {
    if (isOverCapIssue(issue)) {
      overCapIssue ??= issue;
    } else if (isTeamRequirementIssue(issue, rawBody)) {
      teamIssues.push(issue);
    } else {
      otherIssues.push(issue);
    }
  }

  return { teamIssues, otherIssues, overCapIssue };
}

function isOverCapIssue(issue: z.core.$ZodIssue): boolean {
  return (
    issue.path[0] === TEAM_IDS_FIELD &&
    issue.path.length === 1 &&
    issue.code === "too_big"
  );
}

/**
 * True when this issue means "you named no usable team", as opposed to "the
 * value you sent is the wrong shape".
 *
 * A `path.length === 1` match keeps element-level issues out: `teamIds: [123]`
 * reports at `["teamIds", 0]` and is a shape error, not a missing team. The one
 * element-level exception is a malformed UUID, which IS a team the caller named
 * and we cannot resolve, so it earns the same remediation as an unknown id.
 */
function isTeamRequirementIssue(
  issue: z.core.$ZodIssue,
  rawBody: unknown
): boolean {
  if (issue.path[0] !== TEAM_IDS_FIELD) {
    return false;
  }

  if (issue.path.length === 1) {
    // An empty array always means it: the caller cleared the field.
    if (issue.code === "too_small") {
      return true;
    }
    // `invalid_type` covers both "key absent" and "key present but not an
    // array". Only the former is a missing team; `teamIds: null` is a shape
    // error and must fall through to the generic 400.
    return (
      issue.code === "invalid_type" &&
      !(isRecord(rawBody) && Object.hasOwn(rawBody, TEAM_IDS_FIELD))
    );
  }

  return issue.code === "invalid_format";
}

/**
 * Zod's message for an absent key is "Invalid input: expected array, received
 * undefined" — accurate and useless to the headless caller this error exists to
 * unblock. Substitute the same sentence the empty-array case already produces,
 * so both spellings of "you named no team" read identically.
 */
function teamIssueMessage(issues: z.core.$ZodIssue[]): string {
  const shown = issues.slice(0, MAX_ISSUES_RENDERED);
  const rendered = shown
    .map((issue) =>
      issue.code === "invalid_type"
        ? `${TEAM_IDS_FIELD}: ${TEAM_REQUIRED_MESSAGE}`
        : formatZodErrors([issue])
    )
    .join(", ");
  return withOmittedCount(rendered, issues.length - shown.length);
}

function renderIssues(issues: z.core.$ZodIssue[]): string {
  const shown = issues.slice(0, MAX_ISSUES_RENDERED);
  return withOmittedCount(formatZodErrors(shown), issues.length - shown.length);
}

function trailingIssues(issues: z.core.$ZodIssue[]): string {
  return issues.length > 0 ? `Also invalid — ${renderIssues(issues)}.` : "";
}

function withOmittedCount(rendered: string, omitted: number): string {
  return omitted > 0 ? `${rendered} (and ${omitted} more)` : rendered;
}

function joinParts(parts: string[]): string {
  return parts.filter((part) => part.length > 0).join(" ");
}

function remediationSentence(
  teams: ProjectTeamOption[],
  verb: TeamRequirementVerb
): string {
  if (teams.length === 0) {
    const action =
      verb === TeamRequirementVerb.Create
        ? "before a project can be created"
        : "before a project's teams can be changed";
    // POST /teams is Clerk-session only, so an API-key caller cannot create one
    // even though it can now list them. Naming who can act keeps this from
    // instructing a headless agent to do something it structurally cannot.
    return `This organization has no teams; one must be created in the web app ${action}. API keys cannot create teams.`;
  }

  const { named, omitted } = namedWithinBudget(teams);
  // The pointer names the `list-teams` tool first, not `details.teams`: `details`
  // is stripped before an MCP agent sees it (FEA-2550), so for the caller most
  // likely to hit this budget that field is not a recovery path at all.
  const truncation =
    omitted > 0
      ? ` (${named.length} of ${teams.length} shown; ${omitted} omitted for length — call the list-teams MCP tool, or GET /teams, for the complete set; details.teams also carries it)`
      : "";
  return `Teams in this organization${truncation}: ${named.join(", ")}.`;
}

/**
 * Name as many teams as the character budget allows. Always names at least one
 * even if that single entry exceeds the budget, because a roster sentence that
 * lists nothing is worse than a long one.
 */
function namedWithinBudget(teams: ProjectTeamOption[]): {
  named: string[];
  omitted: number;
} {
  const named: string[] = [];
  let used = 0;

  for (const team of teams) {
    const entry = `${team.name} (${team.id})`;
    const cost = entry.length + (named.length > 0 ? 2 : 0);
    if (named.length > 0 && used + cost > TEAM_ROSTER_MESSAGE_BUDGET) {
      break;
    }
    named.push(entry);
    used += cost;
  }

  return { named, omitted: teams.length - named.length };
}

function teamRequirementResponse(
  message: string,
  teams: ProjectTeamOption[]
): NextResponse<ApiResult<never>> {
  return badRequestResponse(message, {
    code: ProjectErrorCode.ProjectTeamRequired,
    details: { teams },
  });
}
