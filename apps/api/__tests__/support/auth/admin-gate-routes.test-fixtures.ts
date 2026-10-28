/**
 * Shared fixtures for the suites that drive every `getOrgAdminStatus`-gated
 * route through a pass-through `withAuth`.
 *
 * Two suites do this — `__tests__/api/admin-gate-privileged-roles.test.ts`
 * (ISS-6934: does each gate ADMIT both privileged Clerk roles?) and
 * `__tests__/api/admin-denial-monitored-event.test.ts` (ISS-7350: does each
 * gate's REFUSAL reach the monitor?). They ask opposite questions of the same
 * routes, so they had grown two copies of the same org row, auth ids, and
 * per-gate request bodies. `AGENTS.md`: "When the same helper logic, object
 * shape, protocol type, or nontrivial test fixture appears in multiple files,
 * extract it into the nearest shared module or shared test fixture owned by
 * that surface."
 *
 * WHAT IS DELIBERATELY *NOT* HERE. The `vi.hoisted` block and the `vi.mock`
 * factories stay in each suite. `vi.mock` is hoisted to the top of the file it
 * appears in and its factory closes over that file's own hoisted mocks, so it
 * cannot be shared through an import without changing what it mocks. Pretending
 * otherwise would move the boilerplate somewhere it does not work; what is
 * shared here is the data and the request-shaping, which is the part that
 * actually drifts.
 *
 * The drift this prevents is concrete: {@link ADMIN_GATE_ORG_ROW} must satisfy
 * whatever columns the org routes read, so the next required column added to
 * `Organization` would otherwise have to be remembered in two files.
 */
import type { NextRequest } from "next/server";
import {
  createMockRequest,
  createMockRouteContext,
} from "@/__tests__/utils/auth-helpers";

export const ADMIN_GATE_CLERK_ORG_ID = "org_clerk_admin_gate";
export const ADMIN_GATE_CLERK_USER_ID = "clerk_user_admin_gate";

/**
 * Must match `createTestAuthContext`'s default `user.organizationId`: the org
 * route refuses outright when the path id is not the caller's own org, which
 * would answer 403 for a reason that has nothing to do with the admin role.
 */
export const ADMIN_GATE_ORG_ROW_ID = "test-org-id";

export const ADMIN_GATE_ORG_ROW = {
  active: true,
  clerkId: ADMIN_GATE_CLERK_ORG_ID,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  id: ADMIN_GATE_ORG_ROW_ID,
  name: "Acme",
  searchIncludeTranscripts: false,
  settings: {},
  slug: "acme",
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

export const ADMIN_GATE_NO_PARAMS = createMockRouteContext({});

/**
 * The request each gated verb is driven with, apart from the invocation list
 * below so a suite covering a DIFFERENT set of gates can still send the
 * byte-identical request for the ones they share.
 *
 * `settings-command-gate-routes.test.ts` (ISS-8716) is that suite: it drives
 * the boundaries migrated onto `authorizeSettingsCommand`, which overlaps this
 * list only at frustration. Without this split that request shape would exist
 * in three files, which is exactly the drift the module docstring above says
 * this fixture prevents.
 */
export const ADMIN_GATE_REQUESTS = {
  frustration: {
    url: "https://api.example.test/settings/frustration",
    method: "PUT",
    body: { calculateSessionFrustration: true },
  },
} as const;

/**
 * The route handlers a suite imports, passed in rather than imported here.
 *
 * Each consuming suite must import the handlers ITSELF, after its own
 * `vi.mock` calls, so the module it gets is the mocked one. Importing them in
 * this shared module would bind them against whatever mocks happened to be
 * registered when this module first loaded.
 */
export type AdminGateHandlers = {
  putOrganization: RouteHandler;
  putFrustration: RouteHandler;
};

type RouteHandler = (
  request: NextRequest,
  context: { params: Promise<Record<string, string>> }
) => Promise<Response>;

export type AdminGateInvocation = {
  /** Route + gate, as the case reads in the test report. */
  name: string;
  /** Drives the real handler through the real `getOrgAdminStatus`. */
  invoke: () => Promise<Response>;
};

/**
 * Every admin-denial exit reachable on the org-policy-write routes: three, not
 * two, because the organization route refuses from more than one gate.
 *
 * Returned as a factory over the caller's handlers so both suites drive
 * byte-identical requests — a difference in request body between them would
 * mean the "admits an admin" case and the "reports a denial" case were not
 * actually exercising the same gate.
 */
export function buildAdminGateInvocations(
  handlers: AdminGateHandlers
): AdminGateInvocation[] {
  return [
    {
      name: "PUT /settings/frustration",
      invoke: () =>
        handlers.putFrustration(
          createMockRequest(ADMIN_GATE_REQUESTS.frustration),
          ADMIN_GATE_NO_PARAMS
        ),
    },
    {
      name: "PUT /organizations/[id] (admin-only field)",
      invoke: () =>
        handlers.putOrganization(
          createMockRequest({
            url: `https://api.example.test/organizations/${ADMIN_GATE_ORG_ROW_ID}`,
            method: "PUT",
            body: { searchIncludeTranscripts: true },
          }),
          createMockRouteContext({ id: ADMIN_GATE_ORG_ROW_ID })
        ),
    },
    {
      name: "PUT /organizations/[id] (slug change)",
      invoke: () =>
        handlers.putOrganization(
          createMockRequest({
            url: `https://api.example.test/organizations/${ADMIN_GATE_ORG_ROW_ID}`,
            method: "PUT",
            body: { slug: "renamed-org" },
          }),
          createMockRouteContext({ id: ADMIN_GATE_ORG_ROW_ID })
        ),
    },
  ];
}
