/**
 * The team repository picker offers only what the team repository write can
 * actually persist.
 *
 * `stageAddRepo` writes the picked row's id as `installationRepositoryId`, a
 * required FK to `GitHubInstallationRepository` that `teamsService.addRepository`
 * re-validates against an ACTIVE installation. Every other `source` the
 * repositories response can carry has an id from a different table, so an
 * unfiltered picker offers a save that always comes back `RepoNotAvailable`.
 * PLN-1775 M7 made that reachable by adding `observed` to the same response.
 *
 * This covers the predicate, not the rendered dropdown: the options live inside
 * a Radix `SelectContent`, which does not mount in jsdom.
 */

import {
  type GetRepositoriesResponse,
  GitHubRepositorySource,
} from "@repo/api/src/types/github";
import { describe, expect, it } from "vitest";
import { persistableTeamRepositories } from "../team-repositories-section";

function repository(
  overrides: Partial<GetRepositoriesResponse[number]> = {}
): GetRepositoriesResponse[number] {
  return {
    id: "installation-repo-1",
    fullName: "closedloop-ai/closedloop-ai",
    name: "closedloop-ai",
    owner: "closedloop-ai",
    private: true,
    githubRepoId: "1",
    lastPushedAt: null,
    source: GitHubRepositorySource.Installation,
    ...overrides,
  };
}

const OBSERVED = repository({
  id: "observed-repo-1",
  fullName: "closedloop-ai/observed",
  source: GitHubRepositorySource.Observed,
});

const PUBLIC = repository({
  id: "public-repo-1",
  fullName: "closedloop-ai/public",
  source: GitHubRepositorySource.Public,
});

describe("persistableTeamRepositories", () => {
  it("keeps installation repositories", () => {
    expect(persistableTeamRepositories([repository()])).toEqual([repository()]);
  });

  it("drops every source whose id the team write cannot persist", () => {
    const kept = persistableTeamRepositories([repository(), OBSERVED, PUBLIC]);

    expect(kept.map((repo) => repo.id)).toEqual(["installation-repo-1"]);
  });

  it("returns nothing for an installation-free org, rather than an unsavable row", () => {
    // The org PLN-1775 M7 serves: its whole repository list is observed rows,
    // every one of which would come back RepoNotAvailable on save.
    expect(persistableTeamRepositories([OBSERVED])).toEqual([]);
  });

  it("drops a row carrying a source this build does not know", () => {
    // `source` is an open set on the wire; an unknown member is not evidence
    // that the id is an installation-repository id.
    const future = repository({
      id: "future-1",
      source: "some_future_lane" as GitHubRepositorySource,
    });

    expect(persistableTeamRepositories([future])).toEqual([]);
  });
});
