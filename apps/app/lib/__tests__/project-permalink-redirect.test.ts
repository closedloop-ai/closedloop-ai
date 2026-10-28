import { describe, expect, test } from "vitest";
import {
  appendLocationHash,
  projectTeamIdsOf,
  resolveProjectPermalinkRedirect,
} from "../project-permalink-redirect";

/**
 * ISS-8588. A project permalink embeds `teamId`, a mutable ancestor, so a link
 * shared before the project was re-teamed names a team the project has left.
 *
 * Every expectation below is written as a LITERAL destination rather than
 * derived from the same inputs the resolver reads, so a resolver that stopped
 * emitting a path — or emitted a differently-shaped one — fails here instead of
 * agreeing with itself.
 */

const ORG_SLUG = "acme";
const PROJECT_ID = "project-1";
const OLD_TEAM_ID = "team-old";
const NEW_TEAM_ID = "team-new";

describe("resolveProjectPermalinkRedirect", () => {
  test("canonicalizes a permalink whose team segment the project has left", () => {
    expect(
      resolveProjectPermalinkRedirect({
        orgSlug: ORG_SLUG,
        requestedTeamId: OLD_TEAM_ID,
        projectId: PROJECT_ID,
        projectTeamIds: [NEW_TEAM_ID],
        search: "",
      })
    ).toBe("/acme/teams/team-new/projects/project-1");
  });

  test("carries the caller's query string onto the destination", () => {
    // The stale link is frequently a deep link — a tab, a filter, a version.
    // Dropping the query would land the reader on the project but not on the
    // thing the link was sent to show them.
    expect(
      resolveProjectPermalinkRedirect({
        orgSlug: ORG_SLUG,
        requestedTeamId: OLD_TEAM_ID,
        projectId: PROJECT_ID,
        projectTeamIds: [NEW_TEAM_ID],
        search: "tab=issues&q=login",
      })
    ).toBe("/acme/teams/team-new/projects/project-1?tab=issues&q=login");
  });

  test("stays silent when the URL already names one of the project's teams", () => {
    expect(
      resolveProjectPermalinkRedirect({
        orgSlug: ORG_SLUG,
        requestedTeamId: OLD_TEAM_ID,
        projectId: PROJECT_ID,
        // A project may belong to several teams; naming ANY of them is
        // canonical, so a multi-team project must not be dragged to team[0].
        projectTeamIds: [NEW_TEAM_ID, OLD_TEAM_ID],
        search: "",
      })
    ).toBeNull();
  });

  test("the destination it emits is itself terminal — one hop, never a loop", () => {
    // AC5's loop case, proven by feeding the resolver its own answer rather than
    // by asserting the guard exists. Re-entering with the team the first pass
    // chose must produce no second redirect.
    const projectTeamIds = [NEW_TEAM_ID];
    const first = resolveProjectPermalinkRedirect({
      orgSlug: ORG_SLUG,
      requestedTeamId: OLD_TEAM_ID,
      projectId: PROJECT_ID,
      projectTeamIds,
      search: "",
    });
    expect(first).toBe("/acme/teams/team-new/projects/project-1");

    const second = resolveProjectPermalinkRedirect({
      orgSlug: ORG_SLUG,
      requestedTeamId: NEW_TEAM_ID,
      projectId: PROJECT_ID,
      projectTeamIds,
      search: "",
    });
    expect(second).toBeNull();
  });

  test("a project that does not exist still 404s — no redirect is invented", () => {
    // AC5. `null` is "the read has not produced a project", which is what an
    // unknown project id settles to. Answering with a path here would replace a
    // truthful not-found with a redirect to a destination nobody can justify.
    expect(
      resolveProjectPermalinkRedirect({
        orgSlug: ORG_SLUG,
        requestedTeamId: OLD_TEAM_ID,
        projectId: "project-that-does-not-exist",
        projectTeamIds: null,
        search: "",
      })
    ).toBeNull();
  });

  test("a settled project with NO teams is left alone rather than sent somewhere", () => {
    // Distinct from the unsettled case above: the project exists, but it has no
    // canonical location to offer. Guessing one would be a misleading
    // destination, which AC5 rules out as firmly as the loop.
    expect(
      resolveProjectPermalinkRedirect({
        orgSlug: ORG_SLUG,
        requestedTeamId: OLD_TEAM_ID,
        projectId: PROJECT_ID,
        projectTeamIds: [],
        search: "",
      })
    ).toBeNull();
  });

  test("emits nothing while the org slug is unresolved", () => {
    // Building from a null slug yields "//teams/...", a protocol-relative path
    // that navigates off-origin. `app-route-redirects.ts` guards the same case.
    expect(
      resolveProjectPermalinkRedirect({
        orgSlug: null,
        requestedTeamId: OLD_TEAM_ID,
        projectId: PROJECT_ID,
        projectTeamIds: [NEW_TEAM_ID],
        search: "",
      })
    ).toBeNull();
  });
});

describe("projectTeamIdsOf", () => {
  test("reads the project's current team ids", () => {
    expect(
      // Only `id` is read, and the parameter type says so — the route's own
      // suite covers the full `ProjectWithDetails` shape.
      projectTeamIdsOf({ teams: [{ id: "team-new" }, { id: "team-other" }] })
    ).toEqual(["team-new", "team-other"]);
  });

  test("reports 'not known' for an unsettled read rather than an empty set", () => {
    // `[]` would read downstream as "settled, belongs to no team" and is a
    // different fact from "the project has not loaded".
    expect(projectTeamIdsOf(undefined)).toBeNull();
    expect(projectTeamIdsOf(null)).toBeNull();
  });

  test("degrades to 'not known' when the API omits the field entirely", () => {
    // `teams` is a wire field. An older API deploy that does not send it must
    // not throw inside a render, and must not move anyone either.
    expect(projectTeamIdsOf({})).toBeNull();
  });
});

describe("appendLocationHash", () => {
  test("re-attaches the caller's deep-link fragment", () => {
    // A fragment never reaches the server, so a client-side replacement drops it
    // unless it is carried explicitly.
    expect(
      appendLocationHash("/acme/teams/team-new/projects/project-1", "#risks")
    ).toBe("/acme/teams/team-new/projects/project-1#risks");
  });

  test("keeps a destination that already carries a fragment intact", () => {
    expect(appendLocationHash("/acme/projects/p#a", "#b")).toBe(
      "/acme/projects/p#a"
    );
  });

  test("leaves the href untouched when there is no fragment", () => {
    expect(appendLocationHash("/acme/teams/team-new/projects/p", "")).toBe(
      "/acme/teams/team-new/projects/p"
    );
  });
});
