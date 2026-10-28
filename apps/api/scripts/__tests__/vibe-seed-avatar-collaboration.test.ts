import type { User } from "@repo/api/src/types/user";
import { ApproverRole } from "@repo/api/src/types/user";
import { getConsistentColor } from "@repo/collaboration/shared/user-colors";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { POST } from "@/app/collaboration/auth/route";
import { vibeSeedAvatar } from "../vibe-seed/core/person-avatars";
import {
  VIBE_GOLDEN_USERS,
  VIBE_SEED_OWNER,
  VIBE_SEED_SIGNED_IN_PERSON,
  VIBE_SEED_TEAMMATES,
} from "../vibe-seed/core/seed-people";

const mocks = vi.hoisted(() => ({
  resolveAuth: vi.fn(),
  findUser: vi.fn(),
  authenticate: vi.fn(),
}));

vi.mock("@/lib/auth/resolve-any-auth-context", () => ({
  resolveAnyAuthContext: mocks.resolveAuth,
}));
vi.mock("@/app/users/service", () => ({
  usersService: { findById: mocks.findUser },
}));
vi.mock("@repo/collaboration/server/auth", () => ({
  authenticate: mocks.authenticate,
}));
vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), flush: vi.fn(async () => undefined), info: vi.fn() },
}));

const PEOPLE = [
  VIBE_SEED_OWNER,
  VIBE_SEED_SIGNED_IN_PERSON,
  ...VIBE_SEED_TEAMMATES,
].map((person) => ({ ...person, avatarHandle: person.githubUsername }));
const ALL_PEOPLE = [...PEOPLE, ...VIBE_GOLDEN_USERS];
const AUTHENTICATE_INPUT = z.object({
  userInfo: z.record(z.string(), z.unknown()),
});

describe("Vibe seed collaboration avatars", () => {
  // ISS-12406: exercise the unchanged route's builder, including future fields,
  // rather than maintaining a second userInfo projection in the seed suite.
  it("keeps all 11 people's full route-built userInfo below 2048 UTF-8 bytes", async () => {
    expect(ALL_PEOPLE).toHaveLength(11);
    // Cover the longest current color spelling regardless of persisted user ids.
    const userId = Array.from(
      { length: 256 },
      (_, index) => `person-${index}`
    ).sort(
      (left, right) =>
        getConsistentColor(right).length - getConsistentColor(left).length ||
        left.localeCompare(right)
    )[0];
    const organizationId = "avatar-org";
    const measurements: {
      handle: string;
      avatarBytes: number;
      userInfoBytes: number;
    }[] = [];
    for (const person of ALL_PEOPLE) {
      const avatarUrl = vibeSeedAvatar(person.avatarHandle);
      expect(avatarUrl).not.toBeNull();
      const user: User = {
        id: userId,
        clerkId: "avatar-clerk-user",
        organizationId,
        email: person.email,
        firstName: person.firstName,
        lastName: person.lastName,
        avatarUrl,
        phoneNumber: null,
        role: ApproverRole.Engineer,
        linearId: null,
        slackId: null,
        githubUsername: null,
        active: true,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      };
      mocks.authenticate.mockClear();
      mocks.resolveAuth.mockResolvedValue({
        ok: true,
        context: { userId, organizationId },
      });
      mocks.findUser.mockResolvedValue(user);
      mocks.authenticate.mockResolvedValue({ token: "{}", status: 200 });

      const response = await POST(
        new Request("http://localhost/collaboration/auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ room: `${organizationId}:artifact:portrait` }),
        })
      );

      expect(response.status).toBe(200);
      expect(mocks.authenticate).toHaveBeenCalledTimes(1);
      const { userInfo } = AUTHENTICATE_INPUT.parse(
        mocks.authenticate.mock.calls[0][0]
      );
      expect(userInfo.avatar).toBe(avatarUrl);
      expect(userInfo.name).toBe(`${person.firstName} ${person.lastName}`);
      measurements.push({
        handle: person.avatarHandle,
        avatarBytes: Buffer.byteLength(avatarUrl ?? "", "utf8"),
        userInfoBytes: Buffer.byteLength(JSON.stringify(userInfo), "utf8"),
      });
    }
    const maxUserInfoBytes = Math.max(
      ...measurements.map((person) => person.userInfoBytes)
    );
    process.stdout.write(
      `${JSON.stringify({ measurements, maxUserInfoBytes })}\n`
    );
    expect(maxUserInfoBytes).toBeLessThan(2048);
  });
});
