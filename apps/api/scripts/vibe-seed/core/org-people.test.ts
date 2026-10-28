import type { PrismaClient } from "@repo/database";
import { describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => {
  const members = new Map<string, string>();
  const usersByClerkId = new Map<string, string>();
  const connections = new Map<
    string,
    { login: string; githubUserId: string; avatarUrl: string | null }
  >();
  return {
    members,
    usersByClerkId,
    connections,
    connectionUpsert: vi.fn(
      (input: {
        where: { organizationId_userId: { userId: string } };
        create: {
          login: string;
          githubUserId: string;
          avatarUrl: string | null;
        };
      }) => {
        connections.set(input.where.organizationId_userId.userId, {
          login: input.create.login,
          githubUserId: input.create.githubUserId,
          avatarUrl: input.create.avatarUrl,
        });
        return Promise.resolve({ id: "connection" });
      }
    ),
    teamsService: {
      getMember: vi.fn((_teamId: string, userId: string) =>
        Promise.resolve(
          members.has(userId) ? { role: members.get(userId) } : null
        )
      ),
      addMember: vi.fn((input: { userId: string; role?: string }) => {
        members.set(input.userId, input.role ?? "MEMBER");
        return Promise.resolve({});
      }),
      updateMemberRole: vi.fn((input: { userId: string; role: string }) => {
        members.set(input.userId, input.role);
        return Promise.resolve({});
      }),
    },
    usersService: {
      upsertByClerkIdAndOrg: vi.fn(
        (input: { clerkId: string; avatarUrl?: string | null }) => {
          const id =
            usersByClerkId.get(input.clerkId) ?? `row-${input.clerkId}`;
          usersByClerkId.set(input.clerkId, id);
          return Promise.resolve({ id });
        }
      ),
      update: vi.fn(() => Promise.resolve({})),
    },
  };
});

vi.mock("@/app/teams/service", () => ({ teamsService: fakes.teamsService }));
vi.mock("@/app/users/service", () => ({ usersService: fakes.usersService }));
vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/database")>()),
  withDb: (fn: (db: unknown) => unknown) =>
    fn({ gitHubUserConnection: { upsert: fakes.connectionUpsert } }),
}));
vi.mock("./org-setup", () => ({
  resolveHomeTeamId: vi.fn(() => Promise.resolve("home-team")),
}));

import { TeamRole } from "@repo/api/src/types/teams";
import { gitHubPerson } from "../github/store-work";
import type { VibeSeedContext } from "../stage";
import { relabelGoldenUsers, seedOrgPeople } from "./org-people";
import { vibeSeedAvatar } from "./person-avatars";
import {
  VIBE_SEED_OWNER,
  VIBE_SEED_SIGNED_IN_PERSON,
  VIBE_SEED_TEAMMATES,
} from "./seed-people";

const ORG_ID = "0192f0a0-0000-7000-8000-0000000000a1";
const WEBP_DATA_URI = /^data:image\/webp;base64,/;
const OTHER_ORG_ID = "0192f0a0-0000-7000-8000-0000000000b1";

describe("relabelGoldenUsers", () => {
  it("renames each fixture identity only inside the seeded organization", async () => {
    const rows: UserRow[] = [
      ...["testuser2", "testuser4", "testuser5", "testuser6"].map(
        (firstName, index) => ({
          organizationId: ORG_ID,
          firstName,
          lastName: null,
          email: `source${index}@acmeco.example`,
          avatarUrl: null,
        })
      ),
      {
        organizationId: OTHER_ORG_ID,
        firstName: "testuser2",
        lastName: null,
        email: "outside@acmeco.example",
        avatarUrl: null,
      },
    ];
    const { context, updateMany } = relabelContext(rows);

    await relabelGoldenUsers(context);

    expect(rows.slice(0, 4).map(personFields)).toStrictEqual(RELABELED);
    expect(rows[4]).toEqual({
      organizationId: OTHER_ORG_ID,
      firstName: "testuser2",
      lastName: null,
      email: "outside@acmeco.example",
      avatarUrl: null,
    });
    expect(updateMany).toHaveBeenCalledTimes(4);
  });

  it("gives rows an earlier seed already renamed their portrait (ISS-12135)", async () => {
    const rows: UserRow[] = RELABELED.map((person) => ({
      ...person,
      organizationId: ORG_ID,
      avatarUrl: null,
    }));
    const { context } = relabelContext(rows);

    await relabelGoldenUsers(context);

    expect(rows.map(personFields)).toStrictEqual(RELABELED);
  });
});

// ISS-12135: a fake-named owner owns the home team and the signed-in person
// administers it, so Members lists the person as an admin, not the owner.
describe("seedOrgPeople", () => {
  it("makes the owner the home team's OWNER and moves the signed-in person to ADMIN", async () => {
    const signedInId = "0192f0a0-0000-7000-8000-0000000000c1";
    fakes.members.clear();
    fakes.usersByClerkId.clear();
    // The base seed leaves the signed-in person owning the home team.
    fakes.members.set(signedInId, TeamRole.Owner);
    const context: VibeSeedContext = {
      prisma: Object.create(null) as PrismaClient,
      organizationId: ORG_ID,
      userId: signedInId,
      desktopStorePath: null,
      corpusShiftMs: 0,
      desktopAuth: null,
      now: new Date("2026-10-05T12:00:00.000Z"),
      log: () => undefined,
    };

    await seedOrgPeople(context);

    const ownerId = fakes.usersByClerkId.get(VIBE_SEED_OWNER.clerkId);
    expect(ownerId).toBeDefined();
    expect(fakes.members.get(ownerId ?? "")).toBe(TeamRole.Owner);
    expect(fakes.members.get(signedInId)).toBe(TeamRole.Admin);
    for (const person of VIBE_SEED_TEAMMATES) {
      const id = fakes.usersByClerkId.get(person.clerkId) ?? "";
      expect(fakes.members.get(id)).toBe(TeamRole.Member);
    }
  });

  it("connects each seeded person's GitHub handle to their own user (ISS-12135)", async () => {
    const signedInId = "0192f0a0-0000-7000-8000-0000000000c1";
    fakes.connections.clear();
    fakes.usersByClerkId.clear();
    await seedOrgPeople({
      prisma: Object.create(null) as PrismaClient,
      organizationId: ORG_ID,
      userId: signedInId,
      desktopStorePath: null,
      corpusShiftMs: 0,
      desktopAuth: null,
      now: new Date("2026-10-05T12:00:00.000Z"),
      log: () => undefined,
    });

    const expected = new Map([
      [signedInId, VIBE_SEED_SIGNED_IN_PERSON.githubUsername],
      ...[VIBE_SEED_OWNER, ...VIBE_SEED_TEAMMATES].map(
        (person) =>
          [
            fakes.usersByClerkId.get(person.clerkId) ?? "",
            person.githubUsername,
          ] as const
      ),
    ]);
    for (const [userId, login] of expected) {
      expect(fakes.connections.get(userId), login).toStrictEqual({
        login,
        githubUserId: String(gitHubPerson(login).id),
        avatarUrl: vibeSeedAvatar(login),
      });
    }
  });

  it("gives every seeded teammate a generated picture of their own (ISS-12135)", async () => {
    fakes.usersService.upsertByClerkIdAndOrg.mockClear();
    await seedOrgPeople({
      prisma: Object.create(null) as PrismaClient,
      organizationId: ORG_ID,
      userId: "0192f0a0-0000-7000-8000-0000000000c1",
      desktopStorePath: null,
      corpusShiftMs: 0,
      desktopAuth: null,
      now: new Date("2026-10-05T12:00:00.000Z"),
      log: () => undefined,
    });

    const avatars = fakes.usersService.upsertByClerkIdAndOrg.mock.calls.map(
      ([input]) => input.avatarUrl
    );
    expect(avatars).toHaveLength(VIBE_SEED_TEAMMATES.length + 1);
    for (const avatar of avatars) {
      expect(avatar).toMatch(WEBP_DATA_URI);
    }
    expect(new Set(avatars).size).toBe(avatars.length);
  });
});

type UserRow = {
  organizationId: string;
  firstName: string;
  lastName: string | null;
  email: string;
  avatarUrl: string | null;
};

type UserWhere = {
  organizationId: string;
  OR: Partial<Pick<UserRow, "firstName" | "email">>[];
};

const RELABELED = [
  {
    firstName: "Amara",
    lastName: "Diallo",
    email: "amara.diallo@acmeco.example",
    avatarUrl: vibeSeedAvatar("amaradiallo"),
  },
  {
    firstName: "Elena",
    lastName: "Morales",
    email: "elena.morales@acmeco.example",
    avatarUrl: vibeSeedAvatar("elenamorales"),
  },
  {
    firstName: "Kai",
    lastName: "Nakamura",
    email: "kai.nakamura@acmeco.example",
    avatarUrl: vibeSeedAvatar("kainakamura"),
  },
  {
    firstName: "Leila",
    lastName: "Haddad",
    email: "leila.haddad@acmeco.example",
    avatarUrl: vibeSeedAvatar("leilahaddad"),
  },
];

/** A `user.updateMany` fake with Prisma's semantics for this `where` shape. */
function relabelContext(rows: UserRow[]) {
  const updateMany = vi.fn(
    (input: { where: UserWhere; data: Omit<UserRow, "organizationId"> }) => {
      const matched = rows.filter(
        (row) =>
          row.organizationId === input.where.organizationId &&
          input.where.OR.some((clause) =>
            Object.entries(clause).every(
              ([key, value]) => row[key as keyof UserRow] === value
            )
          )
      );
      for (const row of matched) {
        Object.assign(row, input.data);
      }
      return Promise.resolve({ count: matched.length });
    }
  );
  const context: VibeSeedContext = {
    prisma: Object.assign(Object.create(null), {
      user: { updateMany },
    }) as PrismaClient,
    organizationId: ORG_ID,
    userId: "0192f0a0-0000-7000-8000-0000000000c1",
    desktopStorePath: null,
    corpusShiftMs: 0,
    desktopAuth: null,
    now: new Date("2026-10-05T12:00:00.000Z"),
    log: () => undefined,
  };
  return { context, updateMany };
}

function personFields({ firstName, lastName, email, avatarUrl }: UserRow) {
  return { firstName, lastName, email, avatarUrl };
}
