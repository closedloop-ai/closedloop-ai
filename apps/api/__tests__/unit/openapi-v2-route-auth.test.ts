/**
 * The `requiredScopes` reader behind the OpenAPI auth guard (ISS-11409): it
 * must name every scope a route requires, however the route spells them, and
 * name none for a session-only route.
 */
import path from "node:path";
import { ApiKeyScope } from "@repo/api/src/types/api-key";
import { describe, expect, it } from "vitest";
import {
  RouteAuthMode,
  routeAuth,
} from "@/__tests__/support/unit/openapi-v2-route-auth.test-helpers";

const apiRoot = path.resolve(import.meta.dirname, "../..");

describe("routeAuth requiredScopes reader", () => {
  it("reads a session-only route as session with no scopes, as POST /documents/merge is wrapped (ISS-11795)", () => {
    expect(routeAuth(apiRoot, "/documents/merge")).toEqual({
      mode: RouteAuthMode.Session,
    });
  });

  it("reads a shared bulk-action scope lookup, as POST /documents/batch-move/v2 writes it", () => {
    expect(routeAuth(apiRoot, "/documents/batch-move/v2")).toEqual({
      mode: RouteAuthMode.ApiKeyOrSession,
      requiredScopes: [ApiKeyScope.Write],
    });
  });
});
