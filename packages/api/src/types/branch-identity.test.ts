import { describe, expect, it } from "vitest";
import {
  BranchCollaboratorSource,
  BranchIdentityAvailability,
  BranchPersonProvider,
  projectBranchPeople,
} from "./branch-identity.ts";
import { GitHubActorType } from "./github-actor.ts";

const completeSources = {
  [BranchCollaboratorSource.PullRequestComments]:
    BranchIdentityAvailability.Complete,
  [BranchCollaboratorSource.BranchComments]:
    BranchIdentityAvailability.Complete,
  [BranchCollaboratorSource.SessionComments]:
    BranchIdentityAvailability.Complete,
};

describe("projectBranchPeople", () => {
  it("deduplicates linked provider identities and orders by stable identity", () => {
    const result = projectBranchPeople(
      [
        {
          person: {
            provider: BranchPersonProvider.ClosedLoop,
            id: "user-b",
            userId: "user-b",
            displayName: "Same Name",
          },
        },
        {
          actorType: GitHubActorType.User,
          person: {
            provider: BranchPersonProvider.GitHub,
            id: "github-2",
            userId: "user-b",
            login: "second",
            actorType: GitHubActorType.User,
          },
        },
        {
          person: {
            provider: BranchPersonProvider.ClosedLoop,
            id: "user-a",
            userId: "user-a",
            displayName: "Same Name",
          },
        },
      ],
      completeSources
    );

    expect(result.availability).toBe(BranchIdentityAvailability.Complete);
    expect(result.people.map((person) => person.userId)).toEqual([
      "user-a",
      "user-b",
    ]);
    expect(result.people[1]?.provider).toBe(BranchPersonProvider.GitHub);
  });

  it("excludes bots and marks unknown GitHub actor evidence incomplete", () => {
    const result = projectBranchPeople(
      [
        {
          actorType: GitHubActorType.Bot,
          person: {
            provider: BranchPersonProvider.GitHub,
            id: "bot-1",
            actorType: GitHubActorType.Bot,
          },
        },
        {
          person: {
            provider: BranchPersonProvider.GitHub,
            id: "unknown-1",
          },
        },
      ],
      completeSources
    );

    expect(result.people).toEqual([]);
    expect(result.availability).toBe(BranchIdentityAvailability.Incomplete);
  });

  it("does not merge distinct stable identities that share display text", () => {
    const result = projectBranchPeople(
      ["github-1", "github-2"].map((id) => ({
        actorType: GitHubActorType.User,
        person: {
          provider: BranchPersonProvider.GitHub,
          id,
          login: "same-login",
          displayName: "Same Name",
          actorType: GitHubActorType.User,
        },
      })),
      completeSources
    );

    expect(result.people.map((person) => person.id)).toEqual([
      "github-1",
      "github-2",
    ]);
  });

  it("chooses a stable provider identity when linked identities repeat", () => {
    const result = projectBranchPeople(
      ["github-2", "github-1"].map((id) => ({
        actorType: GitHubActorType.User,
        person: {
          provider: BranchPersonProvider.GitHub,
          id,
          userId: "user-1",
          actorType: GitHubActorType.User,
        },
      })),
      completeSources
    );

    expect(result.people).toHaveLength(1);
    expect(result.people[0]?.id).toBe("github-1");
  });

  it("distinguishes a complete empty set from unavailable sources", () => {
    expect(projectBranchPeople([], completeSources)).toMatchObject({
      availability: BranchIdentityAvailability.Complete,
      people: [],
    });
    expect(
      projectBranchPeople([], {
        [BranchCollaboratorSource.PullRequestComments]:
          BranchIdentityAvailability.Unavailable,
        [BranchCollaboratorSource.BranchComments]:
          BranchIdentityAvailability.Unavailable,
        [BranchCollaboratorSource.SessionComments]:
          BranchIdentityAvailability.Unavailable,
      })
    ).toMatchObject({
      availability: BranchIdentityAvailability.Unavailable,
      people: [],
    });
  });
});
