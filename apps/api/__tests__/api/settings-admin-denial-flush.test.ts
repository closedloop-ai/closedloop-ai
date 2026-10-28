/**
 * ISS-7350 — the settings admin gate flushes its denial EXACTLY ONCE, by the
 * auth wrapper's terminal path.
 *
 * WHY THIS EXISTS. ISS-7200 (#5485, whitlockk) established that a route-local
 * `scheduleLogFlush()` on a `withAuth` handler is a SECOND flush: the wrapper's
 * `finally` already calls `logRequestCompleted`, which calls `scheduleLogFlush`
 * once the handler returns — and `scheduleLogFlush` has no idempotency guard,
 * so the second call issues a second `log.flush` and, with tracing on, a second
 * span-flush callback on every denial. That review removed the duplicate from
 * `PUT /organizations/[id]`; `[id]/admin-denial-flush.test.ts` pins it there.
 *
 * ISS-7350 converged all four routes onto one emitter and left three of them
 * still carrying the duplicate — one contract, three violations of it. Two of
 * those routes are gone (ISS-12435); keeping the remaining one at one flush is
 * what this suite protects, and it can fail in BOTH
 * directions, which is the whole point:
 *
 *   • re-add `scheduleLogFlush()` to any denial branch → 2 flushes, red;
 *   • drop `logRequestCompleted` from `withAuth`'s `finally` → 0 flushes, red.
 *
 * A count-only assertion would pass against a route that logged nothing at all,
 * so every case also asserts the denial was actually emitted.
 *
 * This mounts the REAL `withAuth`, stubbing only what sits beneath it (Clerk
 * `auth()`, the user lookup, the org-header resolution). The sibling suite
 * `admin-denial-monitored-event.test.ts` replaces `withAuth` with a
 * pass-through so it can inject an auth context — which structurally cannot
 * observe the wrapper's terminal flush, or notice a duplicate one.
 */
import type { User } from "@repo/api/src/types/user";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  findOrCreateUser: vi.fn(),
  resolveOrgHeader: vi.fn(),
  getOrganizationMembershipRole: vi.fn(),
  logFlush: vi.fn(async () => undefined),
  logWarn: vi.fn(),
  frustrationSettingService: {
    isFrustrationEnabled: vi.fn(),
    setFrustrationEnabled: vi.fn(),
  },
}));

vi.mock("@repo/auth/server", () => ({ auth: mocks.auth }));

vi.mock("@repo/observability/log", () => ({
  log: {
    error: vi.fn(),
    flush: mocks.logFlush,
    info: vi.fn(),
    warn: mocks.logWarn,
  },
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: (promise: Promise<unknown>) => promise,
}));

vi.mock("@/lib/auth/find-or-create-user", () => ({
  findOrCreateUser: mocks.findOrCreateUser,
}));

vi.mock("@/lib/auth/resolve-org-header", () => ({
  resolveOrgHeader: mocks.resolveOrgHeader,
}));

// Frustration refuses through the Settings command gate, which reads Clerk
// itself (ISS-8716).
vi.mock("@/lib/auth/clerk-service", () => ({
  clerkService: {
    getOrganizationMembershipRole: mocks.getOrganizationMembershipRole,
  },
}));

vi.mock("@/app/settings/frustration-setting-service", () => ({
  frustrationSettingService: mocks.frustrationSettingService,
}));

import { ClerkOrgRoleFixture } from "@/__tests__/utils/auth-helpers";
import { PUT as putFrustration } from "@/app/settings/frustration/route";
import { orgAdminDenialThrottle } from "@/lib/observability/admin-denial-telemetry";

const ORG_ID = "org-1";
const CLERK_ORG_ID = "clerk-org-1";
const CLERK_USER_ID = "clerk-user-1";

const MEMBER: User = {
  id: "user-1",
  clerkId: CLERK_USER_ID,
  organizationId: ORG_ID,
  email: "member@example.test",
  firstName: "Member",
  lastName: "User",
  avatarUrl: null,
  phoneNumber: null,
  role: "ENGINEER",
  linearId: null,
  slackId: null,
  githubUsername: null,
  active: true,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

const NO_PARAMS = { params: Promise.resolve({}) };

function settingsRequest(
  path: string,
  method: string,
  body?: unknown
): NextRequest {
  return new NextRequest(`http://localhost:3002${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }),
  });
}

const denialSites = [
  {
    name: "PUT /settings/frustration",
    invoke: () =>
      putFrustration(
        settingsRequest("/settings/frustration", "PUT", {
          calculateSessionFrustration: true,
        }),
        NO_PARAMS
      ),
  },
];

describe("settings admin denials — terminal flush (ISS-7350)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orgAdminDenialThrottle.clear();
    mocks.auth.mockResolvedValue({
      userId: CLERK_USER_ID,
      orgId: CLERK_ORG_ID,
      orgRole: "org:member",
    });
    mocks.resolveOrgHeader.mockResolvedValue({
      kind: "session",
      clerkOrgId: CLERK_ORG_ID,
      orgRole: "org:member",
    });
    mocks.findOrCreateUser.mockResolvedValue(MEMBER);
    mocks.getOrganizationMembershipRole.mockResolvedValue(
      ClerkOrgRoleFixture.Member
    );
  });

  it.each(denialSites)(
    "flushes the denial exactly once, through the auth wrapper, at $name",
    async ({ invoke }) => {
      const response = await invoke();

      expect(response.status).toBe(403);
      // The denial really was emitted — without this, a route that logged
      // nothing would still satisfy the count below.
      expect(mocks.logWarn).toHaveBeenCalledTimes(1);
      // ONE flush. Two means a route-local `scheduleLogFlush` came back; zero
      // means the wrapper's terminal flush stopped covering this path.
      expect(mocks.logFlush).toHaveBeenCalledTimes(1);
    }
  );

  it("still flushes once when the denial emission is throttled away", async () => {
    await denialSites[0].invoke();
    mocks.logWarn.mockClear();
    mocks.logFlush.mockClear();

    const response = await denialSites[0].invoke();

    // The flush belongs to the REQUEST, not to the emission, so suppressing
    // the second denial's line must not suppress its request's flush.
    expect(response.status).toBe(403);
    expect(mocks.logWarn).not.toHaveBeenCalled();
    expect(mocks.logFlush).toHaveBeenCalledTimes(1);
  });
});
