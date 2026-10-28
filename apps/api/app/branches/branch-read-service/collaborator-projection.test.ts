import {
  BranchCollaboratorSource,
  BranchIdentityAvailability,
  BranchPersonProvider,
} from "@repo/api/src/types/branch-identity";
import { describe, expect, it } from "vitest";
import { githubShadowClerkId } from "@/app/comments/github-shadow-identity";
import {
  type NativeUser,
  projectBranchCollaborators,
} from "./collaborator-projection";

const HUMAN_ID = "11111111-1111-4111-8111-111111111111";
const SHADOW_ID = "22222222-2222-4222-8222-222222222222";
const users = new Map<string, NativeUser>([
  [
    HUMAN_ID,
    {
      id: HUMAN_ID,
      clerkId: "user_human",
      email: "human@example.test",
      firstName: "Human",
      lastName: "Author",
      avatarUrl: null,
    },
  ],
  [
    SHADOW_ID,
    {
      id: SHADOW_ID,
      clerkId: githubShadowClerkId("org-1", "123"),
      email: "shadow@example.test",
      firstName: "Provider",
      lastName: "Shadow",
      avatarUrl: null,
    },
  ],
]);

describe("Branch native collaborator actor admission", () => {
  it("keeps the human and marks each source with a shadow author incomplete", () => {
    const collaborators = projectBranchCollaborators({
      associatedPullRequestCount: 0,
      ownerIdentity: {
        availability: BranchIdentityAvailability.Complete,
        person: null,
      },
      evidence: {
        branchComments: [{ authorId: HUMAN_ID }, { authorId: SHADOW_ID }],
        sessionComments: [{ authorId: SHADOW_ID }],
        githubComments: [],
        branchCapped: false,
        sessionCapped: false,
        githubCapped: false,
        pullRequestAvailability: BranchIdentityAvailability.Complete,
      },
      contributors: {
        authors: [],
        pushes: [],
        authorAvailability: BranchIdentityAvailability.Complete,
        pushAvailability: BranchIdentityAvailability.Complete,
      },
      usersById: users,
      verifiedGitHubUserIds: new Map(),
    });

    expect(collaborators.people).toEqual([
      expect.objectContaining({
        provider: BranchPersonProvider.ClosedLoop,
        userId: HUMAN_ID,
      }),
    ]);
    expect(collaborators.sources).toMatchObject({
      [BranchCollaboratorSource.BranchComments]:
        BranchIdentityAvailability.Incomplete,
      [BranchCollaboratorSource.SessionComments]:
        BranchIdentityAvailability.Incomplete,
    });
    expect(collaborators.availability).toBe(
      BranchIdentityAvailability.Incomplete
    );
  });

  it("does not promote a shadow Owner into a human pusher", () => {
    const collaborators = projectBranchCollaborators({
      associatedPullRequestCount: 0,
      ownerIdentity: {
        availability: BranchIdentityAvailability.Complete,
        person: {
          provider: BranchPersonProvider.ClosedLoop,
          id: SHADOW_ID,
          userId: SHADOW_ID,
        },
      },
      contributors: {
        authors: [],
        pushes: [],
        authorAvailability: BranchIdentityAvailability.Complete,
        pushAvailability: BranchIdentityAvailability.Complete,
      },
      usersById: users,
      verifiedGitHubUserIds: new Map(),
    });

    expect(collaborators.people).toEqual([]);
    expect(collaborators.sources[BranchCollaboratorSource.Pushes]).toBe(
      BranchIdentityAvailability.Incomplete
    );
    expect(collaborators.availability).toBe(
      BranchIdentityAvailability.Incomplete
    );
  });
});
