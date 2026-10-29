import {
  NAVIGATION_DESTINATION_LIMIT,
  NavigationActorStanding,
  NavigationDestinationStatus,
  NavigationProjectionStatus,
  type NavigationViewModel,
} from "@repo/api/src/types/navigation-view-model";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../../../__tests__/utils/auth-helpers";

const { buildNavigationViewModel } = vi.hoisted(() => ({
  buildNavigationViewModel: vi.fn(),
}));

let mockAuthContext: AuthContext = createTestAuthContext();

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (auth: AuthContext, request: Request) => Promise<Response>) =>
    (request: Request) =>
      handler(mockAuthContext, request),
}));

vi.mock("../service", () => ({
  navigationService: { buildNavigationViewModel },
}));

import { DESTINATION_ID_MAX_LENGTH, GET, parseDestinationIds } from "./route";

/** The wire form the route reads, so a case pins the repeated-parameter shape
 * rather than only the helper's array argument. */
function idsFromQuery(query: string): readonly string[] {
  return new URL(
    `https://example.test/navigation/view-model${query}`
  ).searchParams.getAll("destinations");
}

describe("parseDestinationIds", () => {
  it("reads an empty list when the parameter is absent", () => {
    expect(parseDestinationIds(idsFromQuery(""))).toEqual({
      ok: true,
      ids: [],
    });
  });

  it("reads REPEATED destinations parameters, not a comma list", () => {
    expect(
      parseDestinationIds(
        idsFromQuery("?destinations=dashboard&destinations=sessions")
      )
    ).toEqual({ ok: true, ids: ["dashboard", "sessions"] });
  });

  it("treats a comma-joined value as ONE id, so the old form cannot smuggle a list", () => {
    expect(
      parseDestinationIds(idsFromQuery("?destinations=dashboard,sessions"))
    ).toEqual({ ok: true, ids: ["dashboard,sessions"] });
  });

  it("trims, drops blanks, and dedupes while preserving first-seen order", () => {
    expect(
      parseDestinationIds([
        " dashboard ",
        " sessions ",
        "",
        " dashboard ",
        "branches",
      ])
    ).toEqual({
      ok: true,
      ids: ["dashboard", "sessions", "branches"],
    });
  });

  it("REJECTS more ids than the limit instead of truncating them", () => {
    const ids = Array.from(
      { length: NAVIGATION_DESTINATION_LIMIT + 1 },
      (_unused, index) => `destination-${index}`
    );

    const parsed = parseDestinationIds(ids);

    // Truncating would silently drop real destinations, and the fold reads an
    // unmentioned destination as unreadable — so the caller would get a column
    // of inert "Unavailable" rows and no error anywhere naming the cause.
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toContain(String(NAVIGATION_DESTINATION_LIMIT));
    }
  });

  it("accepts exactly the limit", () => {
    const ids = Array.from(
      { length: NAVIGATION_DESTINATION_LIMIT },
      (_unused, index) => `destination-${index}`
    );

    const parsed = parseDestinationIds(ids);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.ids).toHaveLength(NAVIGATION_DESTINATION_LIMIT);
    }
  });

  it("counts the limit AFTER deduping, so a repeated id costs no slot", () => {
    const parsed = parseDestinationIds(
      Array.from({ length: NAVIGATION_DESTINATION_LIMIT + 5 }, () => "sessions")
    );

    expect(parsed).toEqual({ ok: true, ids: ["sessions"] });
  });

  it("accepts an id at exactly the length limit", () => {
    const parsed = parseDestinationIds(["a".repeat(DESTINATION_ID_MAX_LENGTH)]);
    expect(parsed.ok).toBe(true);
  });

  it("rejects an over-long id rather than parsing it", () => {
    const parsed = parseDestinationIds([
      "sessions",
      "a".repeat(DESTINATION_ID_MAX_LENGTH + 1),
    ]);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toContain(String(DESTINATION_ID_MAX_LENGTH));
    }
  });
});

describe("GET /navigation/view-model", () => {
  beforeEach(() => {
    mockAuthContext = createTestAuthContext();
    buildNavigationViewModel.mockReset();
  });

  it("hands the parsed ids and the actor's organization to the service", async () => {
    buildNavigationViewModel.mockResolvedValue(READY_VIEW_MODEL);

    const response = await GET(
      viewModelRequest("?destinations=dashboard&destinations=sessions"),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    expect(buildNavigationViewModel).toHaveBeenCalledWith({
      clerkOrgId: mockAuthContext.clerkOrgId,
      clerkUserId: mockAuthContext.clerkUserId,
      destinationIds: ["dashboard", "sessions"],
      organizationId: mockAuthContext.user.organizationId,
    });
    await expect(response.json()).resolves.toMatchObject({
      data: READY_VIEW_MODEL,
    });
  });

  it("answers 400 without building a projection when more ids than the limit are requested", async () => {
    const query = Array.from(
      { length: NAVIGATION_DESTINATION_LIMIT + 1 },
      (_unused, index) => `destinations=destination-${index}`
    ).join("&");

    const response = await GET(
      viewModelRequest(`?${query}`),
      createMockRouteContext({})
    );

    expect(response.status).toBe(400);
    expect(buildNavigationViewModel).not.toHaveBeenCalled();
  });

  it("answers 500 when the projection cannot be built", async () => {
    buildNavigationViewModel.mockRejectedValue(new Error("projection failed"));

    const response = await GET(
      viewModelRequest("?destinations=dashboard"),
      createMockRouteContext({})
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ success: false });
  });
});

const READY_VIEW_MODEL: NavigationViewModel = {
  projectionStatus: NavigationProjectionStatus.Ready,
  standing: NavigationActorStanding.Member,
  organizationId: "test-org-id",
  destinations: {
    dashboard: { status: NavigationDestinationStatus.Ready },
    sessions: { status: NavigationDestinationStatus.Ready },
  },
};

function viewModelRequest(query: string) {
  return createMockRequest({
    url: `http://localhost:3002/navigation/view-model${query}`,
  });
}
