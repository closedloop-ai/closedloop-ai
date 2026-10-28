import type { TeamRepository } from "@repo/api/src/types/teams";
import { v7 as uuidv7 } from "uuid";

export function buildTeamRepository(
  overrides: Partial<TeamRepository> = {}
): TeamRepository {
  return {
    id: uuidv7(),
    teamId: "team-1",
    installationRepositoryId: uuidv7(),
    isDefaultSelected: false,
    isPrimary: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    repository: {
      id: uuidv7(),
      installationId: uuidv7(),
      githubRepoId: "12345",
      fullName: "acme/repo",
      name: "repo",
      owner: "acme",
      private: false,
    },
    ...overrides,
  };
}
