import type {
  BrowserSession,
  BrowserSessionListResponse,
} from "@repo/api/src/types/browser-session";
import type { ComputeTarget } from "@repo/api/src/types/compute-target";
import {
  DesktopSecurityStatus,
  HarnessType,
} from "@repo/api/src/types/compute-target";

/**
 * @file device-panel-fixtures.ts
 * @description The two domain shapes the ISS-8366 device panels render, owned
 * once for the panels' tests and their stories.
 *
 * `ComputeTarget` alone carries fourteen fields and `BrowserSessionListResponse`
 * five envelope fields around its rows — hand-copied into every file that needs
 * one, adding a field to either contract would mean finding several literals to
 * keep in step, with nothing failing until somebody noticed.
 */

export const DEVICE_FIXTURE_TIMESTAMP = new Date("2026-04-28T12:00:00.000Z");

/**
 * `activity` is the parameter that matters: a session WITH one exercises the
 * shaped browser/device/location labels, and `activity: null` exercises the
 * provider-said-nothing path, which must render explicit unknowns rather than
 * blanks beside real values.
 */
export function buildBrowserSessionFixture(
  overrides: Partial<BrowserSession> = {}
): BrowserSession {
  return {
    activity: {
      browserName: "Chrome",
      browserVersion: "148.0.7778.96",
      city: "Berlin",
      country: "Germany",
      deviceType: "Macintosh",
      isMobile: false,
    },
    expireAt: "2026-05-05T12:00:00.000Z",
    id: "sess_1",
    isCurrentSession: false,
    lastActiveAt: "2026-04-28T11:00:00.000Z",
    ...overrides,
  };
}

/**
 * A whole list response. `totalCount` defaults to the number of rows given, so
 * a caller that says nothing gets a `Complete` page rather than an accidental
 * `Truncated` or `Unknown` one — the states a test must ask for deliberately.
 */
export function buildBrowserSessionListFixture(
  overrides: Partial<BrowserSessionListResponse> = {}
): BrowserSessionListResponse {
  const sessions = overrides.sessions ?? [buildBrowserSessionFixture()];
  return {
    currentSessionKnown: true,
    limit: 20,
    offset: 0,
    totalCount: sessions.length,
    ...overrides,
    sessions,
  };
}

/**
 * `ownerName` is the parameter that matters: absent means the viewer owns the
 * target and every write control is offered, present means somebody else's
 * machine and none is (D4).
 */
export function buildComputeTargetFixture(
  overrides: Partial<ComputeTarget> = {}
): ComputeTarget {
  return {
    capabilities: {},
    createdAt: DEVICE_FIXTURE_TIMESTAMP,
    id: "target-1",
    isOnline: true,
    isSharedWithOrg: false,
    lastSeenAt: DEVICE_FIXTURE_TIMESTAMP,
    machineName: "Ada-MBP",
    organizationId: "org-1",
    platform: "darwin",
    security: {
      reason: "FEATURE_DISABLED",
      status: DesktopSecurityStatus.Unknown,
      upgradeSupported: false,
    },
    selectedHarness: HarnessType.Claude,
    supportedOperations: [],
    updatedAt: DEVICE_FIXTURE_TIMESTAMP,
    userId: "user-1",
    ...overrides,
  };
}
