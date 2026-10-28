import { describe, expect, it } from "vitest";
import { resolveProjectPermalinkRedirect } from "../use-project-permalink-canonicalization";

describe("portable project permalink", () => {
  it("uses the host route builder and retains query state after a project's team changes", () => {
    expect(
      resolveProjectPermalinkRedirect({
        orgSlug: null,
        requestedTeamId: "old",
        projectId: "project",
        projectTeamIds: ["new"],
        search: "layout=board&columns=owner",
        projectHref: (teamId, id) => `/teams/${teamId}/projects/${id}`,
      })
    ).toBe("/teams/new/projects/project?layout=board&columns=owner");
  });
  it("keeps unresolved and already canonical memberships in place", () => {
    const location = {
      orgSlug: null,
      requestedTeamId: "team",
      projectId: "project",
      search: "",
      projectHref: (teamId: string, id: string) =>
        `/teams/${teamId}/projects/${id}`,
    };
    expect(
      resolveProjectPermalinkRedirect({ ...location, projectTeamIds: null })
    ).toBeNull();
    expect(
      resolveProjectPermalinkRedirect({ ...location, projectTeamIds: ["team"] })
    ).toBeNull();
  });
});
