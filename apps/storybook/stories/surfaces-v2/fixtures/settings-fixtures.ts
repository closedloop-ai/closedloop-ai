import type { ApiKey } from "@repo/api/src/types/api-key";
import { DesktopSecurityStatus } from "@repo/api/src/types/compute-target";
import {
  CustomFieldEntityType,
  CustomFieldType,
} from "@repo/api/src/types/custom-field";
import { getPublicDesktopReleaseDownloadUrl } from "@repo/api/src/types/desktop-release";
import type { ElectronReleaseInfo } from "@repo/api/src/types/electron";
import type { Organization } from "@repo/api/src/types/organization";
import {
  SettingsActorRole,
  SettingsActorRoleStatus,
} from "@repo/api/src/types/settings-actor-role";
import { projectSettingsViewModel } from "@repo/api/src/types/settings-view-model";
import { TagColor } from "@repo/api/src/types/tag";
import {
  buildBrowserSessionFixture,
  buildBrowserSessionListFixture,
  buildComputeTargetFixture,
} from "@repo/app/settings/v2/test-fixtures/device-panel-fixtures";
import {
  buildComplianceGapFixture,
  buildCustomFieldFixture,
  buildTagFixture,
} from "@repo/app/settings/v2/test-fixtures/governance-panel-fixtures";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import { LIVE_ORG_SLUG } from "../live-route";
import { currentUserFixture, liveAppShellRoutes } from "./live-app-fixtures";
import { orgUsersRoute } from "./org-people-fixtures";

// API responses the Settings v2 dialog and its panels read, for the Surfaces
// v2.0 Settings pages. The actor is the Clerk stand-in's admin, Dana Reyes, in
// org `org_test`. Domain rows come from the panels' own fixture builders
// (packages/app/settings/v2/test-fixtures).

const ORG_ID = currentUserFixture.organizationId;
const USER_ID = currentUserFixture.id;
const CREATED_AT = new Date("2026-01-12T09:00:00.000Z");
const RECENT = "2026-10-06T08:40:00.000Z";

/** `GET /settings/view-model` for a settled role. */
export function settingsViewModelFor(role: SettingsActorRole) {
  return projectSettingsViewModel({
    resolution: { role, status: SettingsActorRoleStatus.Resolved },
    staleSessionRole: false,
  });
}

export const settingsOrganizationFixture: Organization = {
  active: true,
  clerkId: ORG_ID,
  createdAt: CREATED_AT,
  id: ORG_ID,
  name: "ClosedLoop",
  settings: {},
  slug: LIVE_ORG_SLUG,
  updatedAt: new Date("2026-09-30T16:20:00.000Z"),
};

export const browserSessionsFixture = buildBrowserSessionListFixture({
  sessions: [
    buildBrowserSessionFixture({
      id: "sess_test",
      isCurrentSession: true,
      lastActiveAt: RECENT,
    }),
    buildBrowserSessionFixture({
      activity: {
        browserName: "Safari",
        browserVersion: "19.1",
        city: "Lisbon",
        country: "Portugal",
        deviceType: "iPhone",
        isMobile: true,
      },
      id: "sess_phone",
      lastActiveAt: "2026-10-05T19:12:00.000Z",
    }),
    buildBrowserSessionFixture({
      activity: {
        browserName: "Firefox",
        browserVersion: "142.0",
        city: "Berlin",
        country: "Germany",
        deviceType: "Windows",
        isMobile: false,
      },
      id: "sess_desktop",
      lastActiveAt: "2026-10-02T10:05:00.000Z",
    }),
  ],
});

/** Dana's MacBook: online. */
const macBookTargetFixture = buildComputeTargetFixture({
  gatewayId: "gw_7f3c2a91",
  id: "target-dana-mbp",
  machineName: "Dana-MBP",
  organizationId: ORG_ID,
  security: {
    reason: "NO_BOUND_MANAGED_KEY",
    status: DesktopSecurityStatus.UpgradeAvailable,
    upgradeSupported: true,
  },
  userId: USER_ID,
});

/** Dana's MacBook Air: already on a Desktop-managed key. */
const macBookAirTargetFixture = buildComputeTargetFixture({
  gatewayId: "gw_19ab44e0",
  id: "target-dana-air",
  machineName: "Dana-Air",
  organizationId: ORG_ID,
  security: {
    reason: "BOUND_DESKTOP_MANAGED_KEY",
    status: DesktopSecurityStatus.Protected,
    upgradeSupported: false,
  },
  userId: USER_ID,
});

const offlineTargetFixture = buildComputeTargetFixture({
  id: "target-dana-studio",
  isOnline: false,
  lastSeenAt: new Date("2026-10-03T18:05:00.000Z"),
  machineName: "Dana-Studio",
  organizationId: ORG_ID,
  security: {
    reason: "TARGET_OFFLINE",
    status: DesktopSecurityStatus.Unknown,
    upgradeSupported: false,
  },
  userId: USER_ID,
});

/** `GET /compute-targets` as the wire carries it (ISO timestamps). */
export const computeTargetsFixture = [
  macBookTargetFixture,
  macBookAirTargetFixture,
  offlineTargetFixture,
].map((target) => ({
  ...target,
  createdAt: target.createdAt.toISOString(),
  lastSeenAt: target.isOnline ? RECENT : target.lastSeenAt.toISOString(),
  updatedAt: target.updatedAt.toISOString(),
}));

export const platformApiKeysFixture: ApiKey[] = [
  {
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    expiresAt: null,
    id: "key-ci",
    keyPrefix: "sk_live_",
    lastUsedAt: new Date("2026-10-06T07:55:00.000Z"),
    name: "CI pipeline",
    organizationId: ORG_ID,
    revokedAt: null,
    scopes: ["read", "write"],
    userId: USER_ID,
  },
  {
    createdAt: new Date("2026-09-14T00:00:00.000Z"),
    expiresAt: new Date("2027-03-14T00:00:00.000Z"),
    id: "key-mcp",
    keyPrefix: "sk_live_",
    lastUsedAt: new Date("2026-10-05T16:30:00.000Z"),
    name: "MCP server",
    organizationId: ORG_ID,
    revokedAt: null,
    scopes: ["read"],
    userId: USER_ID,
  },
];

export const customFieldsFixture = [
  buildCustomFieldFixture({
    createdById: USER_ID,
    entityTypes: [
      CustomFieldEntityType.Project,
      CustomFieldEntityType.Document,
    ],
    id: "cf_customer",
  }),
  buildCustomFieldFixture({
    createdById: "user-priya",
    entityTypes: [CustomFieldEntityType.Document],
    fieldType: CustomFieldType.Number,
    id: "cf_effort",
    name: "Effort (days)",
  }),
  buildCustomFieldFixture({
    createdById: "user-marco",
    entityTypes: [CustomFieldEntityType.Project],
    fieldType: CustomFieldType.Date,
    id: "cf_launch",
    name: "Launch date",
  }),
].map((field) => ({ ...field, organizationId: ORG_ID }));

export const tagsFixture = [
  buildTagFixture({ createdById: USER_ID, id: "tag_customer" }),
  buildTagFixture({
    color: TagColor.Green,
    createdById: "user-priya",
    id: "tag_onboarding",
    name: "Onboarding",
  }),
  buildTagFixture({
    color: TagColor.Red,
    createdById: "user-marco",
    id: "tag_incident",
    name: "Incident follow-up",
  }),
].map((tag) => ({ ...tag, organizationId: ORG_ID }));

export const complianceFixture = {
  items: [
    buildComplianceGapFixture(),
    buildComplianceGapFixture({
      catalogItemName: "Release Checklist",
      distributionId: "dist-2",
      installedButUnusedCount: 0,
      kind: "skill",
      notInstalledCount: 1,
      totalTargetCount: 3,
    }),
  ],
  total: 2,
};

const DESKTOP_RELEASE_VERSION = "2.14.0";

/** `GET /electron-release`: the latest desktop build. */
export const electronReleaseFixture: ElectronReleaseInfo = {
  downloadUrl: getPublicDesktopReleaseDownloadUrl(DESKTOP_RELEASE_VERSION),
  releaseNotes: "",
  version: DESKTOP_RELEASE_VERSION,
};

function get(path: string, respond: FixtureRoute["respond"]): FixtureRoute {
  return { method: "GET", path, respond };
}

/** Every read the Settings dialog makes, answered for `role`. */
export function settingsRoutes(
  role: SettingsActorRole = SettingsActorRole.Admin
): FixtureRoute[] {
  return [
    get("/settings/view-model", () => settingsViewModelFor(role)),
    get(`/organizations/${ORG_ID}`, () => settingsOrganizationFixture),
    get("/settings/browser-sessions", () => browserSessionsFixture),
    get("/compute-targets", () => computeTargetsFixture),
    get("/custom-fields", () => customFieldsFixture),
    get("/tags", () => tagsFixture),
    get("/agent-components/compliance", () => complianceFixture),
    get("/api-keys", () => platformApiKeysFixture),
    get("/settings/frustration", () => ({
      calculateSessionFrustration: true,
    })),
    get("/electron-release", () => electronReleaseFixture),
    orgUsersRoute,
    ...liveAppShellRoutes,
  ];
}

export const settingsApiRoutes = settingsRoutes();

/** `settingsRoutes(role)` with some reads answered differently. */
export function withSettingsRoutes(
  overrides: FixtureRoute[],
  role: SettingsActorRole = SettingsActorRole.Admin
): FixtureRoute[] {
  return [...overrides, ...settingsRoutes(role)];
}

/** A read that fails with a server error. */
export function failingRead(path: string): FixtureRoute {
  return { method: "GET", path, respond: () => null, status: 500 };
}

/** A read that never settles. */
export function pendingRead(path: string): FixtureRoute {
  return { method: "GET", path, respond: () => new Promise(() => undefined) };
}
