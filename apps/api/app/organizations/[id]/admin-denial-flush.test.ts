/**
 * #5485 review (whitlockk) — the admin denial is flushed EXACTLY ONCE, by the auth
 * wrapper's terminal path.
 *
 * WHY THIS FILE EXISTS RATHER THAN A CASE IN THE SIBLING SUITE.
 * `settings-write-authorization.test.ts` replaces `@/lib/auth/with-auth` with a
 * pass-through so it can inject an auth context. That mock does not call
 * `logRequestCompleted`, so the only `log.flush` it could ever observe was the
 * route's own — which made its "flushes the denial" case look load-bearing
 * while being structurally incapable of exercising the production terminal
 * flush, or of noticing a duplicate one. It has been deleted, not weakened.
 *
 * This suite mounts the REAL `withAuth` (stubbing only what sits beneath it:
 * Clerk `auth()`, the user lookup, and the org-header resolution) so the
 * `finally` → `logRequestCompleted` → `scheduleLogFlush` chain actually runs.
 * That is what makes the count assertion able to fail in both directions:
 *
 *   • re-add `scheduleLogFlush()` to `denyNonAdmin` → 2 flushes, red;
 *   • drop `logRequestCompleted` from `withAuth`'s `finally` → 0 flushes, red.
 *
 * The duplicate mattered beyond the redundant log drain: `scheduleLogFlush`
 * also schedules a span flush, so a second call meant a second span-flush
 * callback on every denial.
 */
import type { User } from "@repo/api/src/types/user";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  findOrCreateUser: vi.fn(),
  resolveOrgHeader: vi.fn(),
  getOrgAdminStatus: vi.fn(),
  logFlush: vi.fn(async () => undefined),
  logWarn: vi.fn(),
  organizationsService: {
    findById: vi.fn(),
    findBySlug: vi.fn(),
    findDetailById: vi.fn(),
    update: vi.fn(),
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

vi.mock("@repo/observability/error", () => ({
  parseError: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
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

vi.mock("@/lib/auth/org-admin", () => ({
  getOrgAdminStatus: mocks.getOrgAdminStatus,
}));

vi.mock("@/lib/auth/clerk-service", () => ({
  clerkService: { updateOrganization: vi.fn() },
}));

vi.mock("../service", () => ({
  organizationsService: mocks.organizationsService,
}));

import {
  ORG_ADMIN_GATE_DENIED_EVENT,
  orgAdminDenialThrottle,
} from "@/lib/observability/admin-denial-telemetry";
import {
  EmissionRollupCause,
  FIXED_WINDOW_EMISSION_WINDOW_MS,
} from "@/lib/observability/fixed-window-emission-throttle";
import { PUT } from "./route";

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

const ORGANIZATION = {
  active: true,
  clerkId: CLERK_ORG_ID,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  id: ORG_ID,
  name: "Acme",
  searchIncludeTranscripts: false,
  settings: { maxConcurrentLoops: 25 },
  slug: "acme",
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

describe("PUT /organizations/[id] admin denial — terminal flush (#5485)", () => {
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
    mocks.getOrgAdminStatus.mockResolvedValue({
      isAdmin: false,
      reason: "not_admin",
    });
    mocks.organizationsService.findById.mockResolvedValue(ORGANIZATION);
    mocks.organizationsService.findDetailById.mockResolvedValue(ORGANIZATION);
    mocks.organizationsService.findBySlug.mockResolvedValue(null);
    mocks.organizationsService.update.mockResolvedValue(ORGANIZATION);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushes the denial exactly once, through the auth wrapper", async () => {
    const response = await putOrganization({
      settings: { maxConcurrentLoops: 4 },
    });

    expect(response.status).toBe(403);
    // The denial really was emitted — without this, a route that logged
    // nothing would still satisfy the count below.
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    // ONE flush. Two means a route-local `scheduleLogFlush` came back; zero
    // means the wrapper's terminal flush stopped covering this path.
    expect(mocks.logFlush).toHaveBeenCalledTimes(1);
  });

  it("flushes once on the slug gate too, not once per gate", async () => {
    const response = await putOrganization({ slug: "renamed-acme" });

    expect(response.status).toBe(403);
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    expect(mocks.logFlush).toHaveBeenCalledTimes(1);
  });

  it("still flushes once when the denial emission is throttled away", async () => {
    await putOrganization({ settings: { maxConcurrentLoops: 4 } });
    mocks.logWarn.mockClear();
    mocks.logFlush.mockClear();

    const response = await putOrganization({
      settings: { maxConcurrentLoops: 4 },
    });

    // The flush belongs to the REQUEST, not to the emission, so suppressing
    // the second denial's line must not suppress its request's flush.
    expect(response.status).toBe(403);
    expect(mocks.logWarn).not.toHaveBeenCalled();
    expect(mocks.logFlush).toHaveBeenCalledTimes(1);
  });

  /**
   * #5508 review (whitlockk) — the suppressed count is materialised by a TERMINAL
   * PATH, not by a timer.
   *
   * A suppressed count used to reach the monitor only when the same
   * (org, gate, reason) was hit again after rollover, or when the map
   * overflowed 10,000 keys. A burst followed by quiet — the shape abuse
   * actually takes — therefore left its occurrences in process memory until the
   * instance froze, and the monitor undercounted exactly the volume the
   * throttle claims to preserve.
   *
   * `withAuth`'s `finally` now drains, so ANY later authenticated request
   * carries the rollup out. This suite mounts the real `withAuth`, so deleting
   * `drainOrgAdminDenials()` from that `finally` turns this red; a suite that
   * called the drain directly could not tell wired from unwired.
   */
  it("drains a quiet gate's suppressed denials on a later request's terminal path", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-20T00:00:00Z"));

    const body = { settings: { maxConcurrentLoops: 4 } };
    await putOrganization(body);
    await putOrganization(body);
    await putOrganization(body);
    // One line for three denials: two are pending in memory at this point.
    expect(monitoredWarns()).toHaveLength(1);

    // Time passes and the gate is never touched again. The next request is an
    // ADMIN one on the same route, so it emits no denial of its own — anything
    // that shows up now came from the drain.
    vi.setSystemTime(
      new Date(Date.now() + FIXED_WINDOW_EMISSION_WINDOW_MS * 2)
    );
    mocks.getOrgAdminStatus.mockResolvedValue({
      isAdmin: true,
      reason: "admin",
    });

    const response = await putOrganization(body);

    expect(response.status).toBe(200);
    expect(monitoredWarns()).toHaveLength(2);
    expect(monitoredWarns()[1][1]).toMatchObject({
      occurrences: 2,
      aggregated: true,
      flushedBy: EmissionRollupCause.Expiry,
    });
  });
});

function monitoredWarns(): [string, Record<string, unknown>][] {
  const calls = mocks.logWarn.mock.calls as unknown as [
    string,
    Record<string, unknown>,
  ][];
  return calls.filter(([name]) => name === ORG_ADMIN_GATE_DENIED_EVENT);
}

function putOrganization(body: Record<string, unknown>): Promise<Response> {
  const request = new NextRequest(
    `http://localhost:3002/organizations/${ORG_ID}`,
    {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }
  );
  return PUT(request, { params: Promise.resolve({ id: ORG_ID }) });
}
