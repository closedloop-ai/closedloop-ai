/**
 * The authenticated cloud routes Settings v2 → Connected Devices reads, and the
 * flag that registers the panel at all.
 *
 * Extracted from `guided-onboarding-settings-sync.spec.ts` (ISS-10195): once
 * the workspace-experience gate retired, the desktop Settings "Data & Sync" tab
 * stopped being reachable and the same picker's only remaining home is this
 * panel, so the specs that own the picker's contracts need the same stand-in
 * that spec already stood up. One copy, because three specs asserting one panel
 * must not disagree about what the cloud told it.
 *
 * `/settings/view-model` is the load-bearing one: the panel body mounts only on
 * a capability read that RESOLVED, so a spec that forgets this route asserts
 * against the shell's CapabilityError screen instead of the panel.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  BROWSER_SESSION_PAGE_LIMIT_DEFAULT,
  BROWSER_SESSION_PAGE_LIMIT_MAX,
  type BrowserSessionListResponse,
} from "@repo/api/src/types/browser-session.ts";
import type { DesktopIdentity } from "@repo/api/src/types/desktop-identity.ts";
import {
  SettingsActorRole,
  SettingsActorRoleStatus,
} from "@repo/api/src/types/settings-actor-role.ts";
import { projectSettingsViewModel } from "@repo/api/src/types/settings-view-model.ts";
import {
  AUTHENTICATED_ACCESS_TOKEN,
  AUTHENTICATED_ORGANIZATION_ID,
  AUTHENTICATED_USER_ID,
  rejectUnauthorized,
  writeApiResult,
} from "./branch-details-authenticated-cloud";

/**
 * `SETTINGS_DEVICE_PANELS_FEATURE_FLAG_KEY`, spelled as a literal rather than
 * imported from `@repo/app/shared/lib/feature-flags`: that module's
 * extension-less internal specifiers do not resolve under Playwright's ESM
 * loader, and a spec-level import failure aborts the WHOLE desktop-e2e suite at
 * load time (`apps/desktop/test/AGENTS.md`).
 */
export const SETTINGS_DEVICE_PANELS_FLAG_KEY = "settings-device-panels";

const DESKTOP_IDENTITY_EMAIL = "desktop-e2e@example.test";
const DESKTOP_ORGANIZATION_NAME = "Desktop E2E Org";

const CONNECTED_DEVICES_PATHS = new Set([
  "/compute-targets",
  "/desktop/identity",
  "/settings/browser-sessions",
  "/settings/view-model",
]);

/**
 * Serve the Connected Devices reads, or report that this request was not one of
 * them. Shaped for `startAuthenticatedBranchCloudServer`'s `extraRoutes`.
 */
export function routeConnectedDevicesRequest(
  request: IncomingMessage,
  response: ServerResponse
): boolean {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  if (!CONNECTED_DEVICES_PATHS.has(requestUrl.pathname)) {
    return false;
  }
  if (
    request.headers.authorization !== `Bearer ${AUTHENTICATED_ACCESS_TOKEN}`
  ) {
    rejectUnauthorized(response);
    return true;
  }
  if (request.method !== "GET") {
    return false;
  }
  if (requestUrl.pathname === "/desktop/identity") {
    writeApiResult(response, desktopIdentity());
    return true;
  }
  if (requestUrl.pathname === "/settings/view-model") {
    writeApiResult(response, memberSettingsViewModel());
    return true;
  }
  if (requestUrl.pathname === "/settings/browser-sessions") {
    writeApiResult(response, browserSessionsResponse(requestUrl));
    return true;
  }
  writeApiResult(response, []);
  return true;
}

/**
 * A resolved MEMBER actor — the least-privileged role that still resolves — so
 * the panel mounts on a capability answer rather than on a read that failed.
 */
export function memberSettingsViewModel() {
  return projectSettingsViewModel({
    resolution: {
      role: SettingsActorRole.Member,
      status: SettingsActorRoleStatus.Resolved,
    },
    staleSessionRole: false,
  });
}

function desktopIdentity(): DesktopIdentity {
  return {
    email: DESKTOP_IDENTITY_EMAIL,
    firstName: "Desktop",
    lastName: "User",
    organizationId: AUTHENTICATED_ORGANIZATION_ID,
    organizationName: DESKTOP_ORGANIZATION_NAME,
    organizationSlug: "desktop-e2e",
    userId: AUTHENTICATED_USER_ID,
  };
}

function browserSessionsResponse(requestUrl: URL): BrowserSessionListResponse {
  return {
    currentSessionKnown: false,
    limit: clampPageLimit(requestUrl.searchParams.get("limit")),
    offset: clampPageOffset(requestUrl.searchParams.get("offset")),
    sessions: [],
    totalCount: 0,
  };
}

function clampPageLimit(raw: string | null): number {
  const requested = Number(raw);
  if (!Number.isInteger(requested)) {
    return BROWSER_SESSION_PAGE_LIMIT_DEFAULT;
  }
  return Math.min(Math.max(requested, 1), BROWSER_SESSION_PAGE_LIMIT_MAX);
}

function clampPageOffset(raw: string | null): number {
  const requested = Number(raw);
  if (!Number.isInteger(requested)) {
    return 0;
  }
  return Math.max(requested, 0);
}
