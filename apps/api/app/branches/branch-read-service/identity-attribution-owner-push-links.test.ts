import {
  BranchIdentityAvailability,
  BranchPersonProvider,
} from "@repo/api/src/types/branch-identity";
import { describe, expect, it, vi } from "vitest";
import { createMockDb } from "@/__tests__/support/branches/branch-read-service.test-helpers";
import { projectOwner } from "./branch-owner-projection";
import { resolveBranchIdentities } from "./identity-attribution";
import type { SessionBranchIdentityEvidence } from "./session-usage-window";

/**
 * ISS-11737 — the branch owner is the session owner of the EARLIEST PUSH
 * (operator ruling 2026-09-30), derived from the push links themselves.
 *
 * `projectOwner` used to return early whenever `branch.firstPushedAt` was
 * unset, discarding push links it had in hand. Measured in production
 * 2026-09-30: 183 of 1,045 branches in `closedloop-ai` rendered
 * "Unattributed" (`availability: incomplete`, `person: null`) against 860
 * attributed, and only 2 were the genuine no-evidence case.
 *
 * The ruling does NOT reach a branch with no push link at all — that branch
 * still names nobody, and the last two cases here pin that boundary so the fix
 * cannot drift into attributing every session-linked branch.
 *
 * ISS-12463: the branch Owner is now the branch's assignee, and `projectOwner`
 * keeps only the observed earliest-push rung, whose person the Collaborators
 * read lists as a pusher. These cases call it directly; the assignee read is
 * pinned at the end of the file.
 */

const ORGANIZATION_ID = "org-1";
const BRANCH_ID = "branch-1";
const OWNER_ID = "user-1";
const LATER_OWNER_ID = "user-2";
const CONNECTED_FIRST_NAME = "Kevin";
const CONNECTED_DISPLAY_NAME = `${CONNECTED_FIRST_NAME} Example`;
const CLERK_AVATAR_URL = "https://img.clerk.com/owner-avatar.png";
const LEGACY_CONNECTION_AVATAR_URL =
  "https://avatars.githubusercontent.com/u/1000";
const EARLIEST = new Date("2026-01-01T00:00:00.000Z");
const LATER = new Date("2026-01-02T00:00:00.000Z");

describe("branch owner from push links", () => {
  it("names the earliest push's session owner when firstPushedAt was never stamped", async () => {
    const identity = await projectOwnerIdentity({
      firstPushedAt: null,
      links: [pushLink({ userId: OWNER_ID, observedAt: EARLIEST })],
    });

    // The defect: this was `{ incomplete, null }` with the owner sitting in the
    // link the early return threw away.
    expect(identity?.person?.userId).toBe(OWNER_ID);
    expect(identity?.availability).toBe(BranchIdentityAvailability.Complete);
  });

  it("uses the linked Clerk photo when the GitHub connection has no avatar", async () => {
    const identity = await projectOwnerIdentity({
      firstPushedAt: EARLIEST,
      links: [pushLink({ userId: connectedUserId(0), observedAt: EARLIEST })],
      connectedLogins: ["whitlockk"],
      connectedUserAvatarUrl: CLERK_AVATAR_URL,
    });

    expect(identity?.person?.avatarUrl).toBe(CLERK_AVATAR_URL);
  });

  it("prefers the linked Clerk photo over a legacy GitHub connection avatar", async () => {
    const identity = await projectOwnerIdentity({
      firstPushedAt: EARLIEST,
      links: [pushLink({ userId: connectedUserId(0), observedAt: EARLIEST })],
      connectedLogins: ["whitlockk"],
      connectedUserAvatarUrl: CLERK_AVATAR_URL,
      connectionAvatarUrl: LEGACY_CONNECTION_AVATAR_URL,
    });

    expect(identity?.person?.avatarUrl).toBe(CLERK_AVATAR_URL);
    expect(identity?.person?.provider).toBe(BranchPersonProvider.GitHub);
    expect(identity?.person?.id).toBe("1000");
    expect(identity?.person?.login).toBe("whitlockk");
  });

  it("has no Owner photo when the linked user has no Clerk avatar", async () => {
    const identity = await projectOwnerIdentity({
      firstPushedAt: EARLIEST,
      links: [pushLink({ userId: connectedUserId(0), observedAt: EARLIEST })],
      connectedLogins: ["whitlockk"],
      connectionAvatarUrl: LEGACY_CONNECTION_AVATAR_URL,
    });

    expect(identity?.person?.avatarUrl).toBeUndefined();
  });

  it("picks the earliest of several undated-branch pushes, not the latest", async () => {
    const identity = await projectOwnerIdentity({
      firstPushedAt: null,
      links: [
        pushLink({ userId: LATER_OWNER_ID, observedAt: LATER }),
        pushLink({ userId: OWNER_ID, observedAt: EARLIEST }),
      ],
    });

    // Without a `firstPushedAt` to pin against, the tiebreak reads the links'
    // own earliest instant. A `getTime()` against `undefined` matched neither
    // link and emptied the set, which is why order must be asserted here.
    expect(identity?.person?.userId).toBe(OWNER_ID);
  });

  it("keeps firstPushedAt as the pin when the branch has one", async () => {
    const identity = await projectOwnerIdentity({
      firstPushedAt: LATER,
      links: [
        pushLink({ userId: OWNER_ID, observedAt: EARLIEST }),
        pushLink({ userId: LATER_OWNER_ID, observedAt: LATER }),
      ],
    });

    // The server-observed instant still wins over the links' own view — it can
    // be stamped by a lane that left no session link, so the links are not
    // authoritative about WHICH push was first when the column disagrees.
    expect(identity?.person?.userId).toBe(LATER_OWNER_ID);
  });

  it("still reports a pushless branch as complete and unattributed", async () => {
    const identity = await projectOwnerIdentity({
      firstPushedAt: null,
      links: [
        pushLink({
          userId: OWNER_ID,
          observedAt: EARLIEST,
          method: "checkout",
        }),
      ],
    });

    // "We looked, a push was never observed" is a COMPLETE corpus that names
    // nobody. Folding this into `incomplete` would report every pushless branch
    // as partial — the mirror of the defect being fixed.
    expect(identity?.person).toBeNull();
    expect(identity?.availability).toBe(BranchIdentityAvailability.Complete);
  });

  it("reports a push whose owner does not resolve as incomplete, never complete", async () => {
    const identity = await projectOwnerIdentity({
      firstPushedAt: null,
      links: [pushLink({ userId: null, observedAt: EARLIEST })],
    });

    // A push happened and we cannot say who: partial evidence, not a confident
    // "nobody owns this".
    expect(identity?.person).toBeNull();
    expect(identity?.availability).toBe(BranchIdentityAvailability.Incomplete);
  });

  it("keeps the dated push's owner but reports a mixed push set incomplete", async () => {
    const identity = await projectOwnerIdentity({
      firstPushedAt: null,
      links: [
        pushLink({ userId: OWNER_ID, observedAt: EARLIEST }),
        pushLink({ userId: LATER_OWNER_ID, observedAt: null }),
      ],
    });

    // ISS-11737 (whitlockk review): the undated push is dropped before the
    // earliest-push decision, so with no `firstPushedAt` to pin against it may
    // be the earlier one and its owner unseen. The dated push's owner stays the
    // fallback candidate; claiming Complete here would be a confident answer to
    // a question the evidence cannot settle.
    expect(identity?.person?.userId).toBe(OWNER_ID);
    expect(identity?.availability).toBe(BranchIdentityAvailability.Incomplete);
  });

  it("keeps firstPushedAt authoritative alongside an undated push", async () => {
    const identity = await projectOwnerIdentity({
      firstPushedAt: EARLIEST,
      links: [
        pushLink({ userId: OWNER_ID, observedAt: EARLIEST }),
        pushLink({ userId: LATER_OWNER_ID, observedAt: null }),
      ],
    });

    // The stamp settles which push was first on its own, so an undated link
    // beside it is not a gap — the case above must not widen into this one.
    expect(identity?.person?.userId).toBe(OWNER_ID);
    expect(identity?.availability).toBe(BranchIdentityAvailability.Complete);
  });

  it("reports a push link with no observed instant as incomplete", async () => {
    const identity = await projectOwnerIdentity({
      firstPushedAt: null,
      links: [pushLink({ userId: OWNER_ID, observedAt: null })],
    });

    // Pre-existing behavior this change must not quietly widen: an undated push
    // link is push EVIDENCE, but it cannot say which push was earliest.
    expect(identity?.person).toBeNull();
    expect(identity?.availability).toBe(BranchIdentityAvailability.Incomplete);
  });
});

/** ISS-11752 / ISS-11762 — a branch's PR authors are Collaborator candidates. */
describe("PR-author Collaborator candidates", () => {
  it("names a PR-author collaborator by display name, not by bare login", async () => {
    const projections = await resolveBranchIdentities(
      identityClient(["whitlockk"]),
      ORGANIZATION_ID,
      [
        {
          branchId: BRANCH_ID,
          assigneeId: null,
          firstPushedAt: null,
          associatedPullRequestCount: 1,
          pullRequestAuthorLogins: ["whitlockk"],
        },
      ],
      []
    );

    // ISS-11762 (tamsinb review): the User read used to run in the same tier
    // as the connection read, so a PR author's `connection.userId` — known
    // only once the connection read returns — was never in `profileUserIds`.
    // `gitHubPersonForLogin` then found no user, left `displayName` undefined, and
    // one human appeared under their real name in one place and under their
    // GitHub login in another.
    expect(
      projections
        .get(BRANCH_ID)
        ?.collaborators.people.find((person) => person.login === "whitlockk")
        ?.displayName
    ).toBe(CONNECTED_DISPLAY_NAME);
  });

  it("keeps the GitHub photo for a PR collaborator candidate", async () => {
    const projections = await resolveBranchIdentities(
      identityClient(
        ["whitlockk"],
        CLERK_AVATAR_URL,
        LEGACY_CONNECTION_AVATAR_URL
      ),
      ORGANIZATION_ID,
      [
        {
          branchId: BRANCH_ID,
          assigneeId: null,
          firstPushedAt: null,
          associatedPullRequestCount: 1,
          pullRequestAuthorLogins: ["whitlockk"],
        },
      ],
      []
    );

    expect(
      projections
        .get(BRANCH_ID)
        ?.collaborators.people.find((person) => person.id === "1000")?.avatarUrl
    ).toBe(LEGACY_CONNECTION_AVATAR_URL);
  });
});

/**
 * ISS-12463 — the branch Owner is the branch's own assignee; the push chain
 * above only seeds it and names Collaborators.
 */
describe("branch Owner is the branch's assignee", () => {
  it("names the assignee even when the earliest push names someone else", async () => {
    const identity = await assigneeOwnerFor(OWNER_ID, [
      pushLink({ userId: LATER_OWNER_ID, observedAt: EARLIEST }),
    ]);

    expect(identity?.person?.userId).toBe(OWNER_ID);
    expect(identity?.availability).toBe(BranchIdentityAvailability.Complete);
  });
});

/** `projectOwner`'s chain over this file's users, connections and push links. */
async function projectOwnerIdentity({
  firstPushedAt,
  links,
  connectedLogins = [],
  connectedUserAvatarUrl,
  connectionAvatarUrl,
}: {
  firstPushedAt: Date | null;
  links: readonly SessionBranchIdentityEvidence[];
  connectedLogins?: readonly string[];
  connectedUserAvatarUrl?: string;
  connectionAvatarUrl?: string;
}) {
  const connections = gitHubConnections(connectedLogins, connectionAvatarUrl);
  return await Promise.resolve(
    projectOwner(
      { branchId: BRANCH_ID, firstPushedAt },
      new Map(connections.map((connection) => [connection.userId, connection])),
      userDirectory(connectedLogins, connectedUserAvatarUrl),
      links.map((link) => ({
        ...link,
        pusherUserId: sessionCreators.get(link.sourceId) ?? null,
      }))
    )
  );
}

function gitHubConnections(
  connectedLogins: readonly string[],
  connectionAvatarUrl?: string
) {
  return connectedLogins.map((login, index) => ({
    userId: connectedUserId(index),
    githubUserId: `${1000 + index}`,
    login,
    avatarUrl: connectionAvatarUrl ?? null,
    profileUrl: null,
  }));
}

function userDirectory(
  connectedLogins: readonly string[],
  connectedUserAvatarUrl?: string
) {
  return new Map(
    [
      nativeUser(OWNER_ID, "Avery", "avery@example.com"),
      nativeUser(LATER_OWNER_ID, "Blake", "blake@example.com"),
      ...connectedLogins.map((login, index) =>
        nativeUser(
          connectedUserId(index),
          CONNECTED_FIRST_NAME,
          `${login || "blank"}@example.com`,
          connectedUserAvatarUrl ?? null
        )
      ),
    ].map((user) => [user.id, user])
  );
}

function identityClient(
  connectedLogins: readonly string[] = [],
  connectedUserAvatarUrl?: string,
  connectionAvatarUrl?: string
) {
  const connections = gitHubConnections(connectedLogins, connectionAvatarUrl);
  const directory = userDirectory(connectedLogins, connectedUserAvatarUrl);
  return {
    ...createMockDb(),
    $queryRaw: vi.fn().mockResolvedValue([]),
    // ISS-12251: the pushing sessions' creators, the person each push names.
    artifact: {
      findMany: vi
        .fn()
        .mockImplementation(
          (args: { where: { id: { in: readonly string[] } } }) =>
            Promise.resolve(
              args.where.id.in
                .filter((id) => sessionCreators.has(id))
                .map((id) => ({ id, createdById: sessionCreators.get(id) }))
            )
        ),
    },
    comment: { findMany: vi.fn().mockResolvedValue([]) },
    gitHubCommentProjection: { findMany: vi.fn().mockResolvedValue([]) },
    gitHubUserConnection: { findMany: vi.fn().mockResolvedValue(connections) },
    user: {
      // ISS-11762 (tamsinb review): the id filter is HONOURED here rather than
      // ignored. A mock that returns the same users whatever it is asked for
      // cannot tell a display name that was resolved from one that was not, so
      // the display-name cases would pass against the defect they exist to
      // catch.
      findMany: vi
        .fn()
        .mockImplementation(
          (args: { where: { id: { in: readonly string[] } } }) =>
            Promise.resolve(
              args.where.id.in
                .map((id) => directory.get(id))
                .filter((user) => user !== undefined)
            )
        ),
    },
  } as never;
}

/** `resolveBranchIdentities`' Owner for one branch with this assignee and these links. */
async function assigneeOwnerFor(
  assigneeId: string | null,
  links: readonly SessionBranchIdentityEvidence[]
) {
  const projections = await resolveBranchIdentities(
    identityClient(),
    ORGANIZATION_ID,
    [
      {
        branchId: BRANCH_ID,
        assigneeId,
        firstPushedAt: EARLIEST,
        associatedPullRequestCount: 0,
      },
    ],
    links
  );
  return projections.get(BRANCH_ID)?.ownerIdentity;
}

/** The user a seeded connection belongs to, keyed by its index in the list. */
function connectedUserId(index: number): string {
  return `gh-user-${index}`;
}

function nativeUser(
  id: string,
  firstName: string,
  email: string,
  avatarUrl: string | null = null
) {
  return {
    id,
    clerkId: `clerk-${id}`,
    email,
    firstName,
    lastName: "Example",
    avatarUrl,
  };
}

let linkSequence = 0;
const sessionCreators = new Map<string, string | null>();

/** `userId` is the pushing session's creator, the person the push names. */
function pushLink({
  userId,
  observedAt,
  method = "git_push",
}: {
  userId: string | null;
  observedAt: Date | null;
  method?: string;
}): SessionBranchIdentityEvidence {
  linkSequence += 1;
  const sourceId = `session-${linkSequence}`;
  sessionCreators.set(sourceId, userId);
  return {
    targetId: BRANCH_ID,
    sourceId,
    branchParticipationMethod: method,
    branchParticipationObservedAt: observedAt,
  };
}
