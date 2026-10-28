/**
 * Fixtures shared by the `createInsightsHandler` suites.
 *
 * Split out when the section-latency cases moved to their own file (#5818
 * review) and `route-handler.test.ts` crossed the 1,000-line ceiling. Two
 * suites now drive the same handler with the same caller identity, and a
 * second copy of that identity is how they start disagreeing about which org
 * the assertions are about.
 *
 * The `vi.mock` / `vi.hoisted` blocks deliberately do NOT live here: they are
 * hoisted per module graph, so each test file declares its own.
 */

import { ApproverRole } from "@repo/api/src/types/user";
import type { FilterToken } from "@repo/observability/telemetry/filter-tokens";
import { NextRequest } from "next/server";

export const USER = {
  active: true,
  avatarUrl: null,
  clerkId: "clerk_user_1",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  email: "test@example.com",
  firstName: "Test",
  githubUsername: null,
  id: "019f0fcb-8336-7c4d-9f64-528fb9520c31",
  lastName: "User",
  linearId: null,
  organizationId: "019f0fcb-8336-7c4d-9f64-528fb9520c30",
  phoneNumber: null,
  role: ApproverRole.Engineer,
  slackId: null,
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

export const TEAM_ID = "019f0fcb-8336-7c4d-9f64-528fb9520c32";

export function identity(): {
  user: typeof USER;
  clerkOrgId: string;
  clerkUserId: string;
} {
  return {
    user: USER,
    clerkOrgId: "org_clerk_1",
    clerkUserId: "user_clerk_1",
  };
}

export function request(path: string): NextRequest {
  return new NextRequest(`http://localhost:3002${path}`);
}

/**
 * Every telemetry payload of one metric that reached `log.info`, parsed back
 * from JSON.
 *
 * Takes the calls rather than the mock so this module stays free of any
 * particular suite's hoisted mock. Asserting through the REAL sink is the point
 * (see the latency suite's header): a mock of our own emitter would stay green
 * if the `_telemetryMetric` marker, the metric name, or the origin were
 * dropped, and those are the three fields the Datadog pipeline filters on.
 */
export function metricPayloads(
  logInfoCalls: unknown[][],
  token: FilterToken
): Record<string, unknown>[] {
  return logInfoCalls
    .map(([message]) => message)
    .filter((message): message is string => typeof message === "string")
    .map((message) => JSON.parse(message) as Record<string, unknown>)
    .filter((payload) => payload.metric === token);
}
