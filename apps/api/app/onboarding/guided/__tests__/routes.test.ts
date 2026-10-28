/**
 * ISS-8375: the boundary the guided onboarding routes enforce, and the statuses
 * they map service outcomes onto.
 *
 * Scope note, deliberately narrow: these cases replace the services, so they
 * prove the request validation and the status mapping and NOTHING about
 * authorization or org scoping — the predicates that decide those live in the
 * modules mocked out here. `service-org-scoping.test.ts` is where the two-org
 * question is decidable.
 */

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authContext: {
    clerkOrgId: "clerk-org-a",
    clerkUserId: "clerk_user_a",
    user: { id: "user-a", organizationId: "org-a", clerkId: "clerk_user_a" },
  },
  getSnapshot: vi.fn(),
  applyTransition: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, context: { params: Promise<unknown> }) =>
      handler(mocks.authContext, request, context?.params),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    flush: vi.fn(async () => undefined),
  },
}));

vi.mock("../snapshot-service", () => ({
  guidedOnboardingSnapshotService: { getSnapshot: mocks.getSnapshot },
}));

vi.mock("../transition-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../transition-service")>()),
  guidedOnboardingTransitionService: { apply: mocks.applyTransition },
}));

import { OnboardingEvent } from "@repo/api/src/types/onboarding-events";
import {
  GUIDED_ONBOARDING_MAX_REVISION,
  GUIDED_ONBOARDING_STALE_REVISION_ERROR,
  GUIDED_ONBOARDING_UNREACHABLE_STATE_ERROR,
  type GuidedOnboardingSnapshot,
} from "@repo/api/src/types/onboarding-guided";
import { OnboardingRestoreOutcome } from "@repo/api/src/types/onboarding-persistence";
import {
  AccountStatus,
  KnownFlag,
  OnboardingHost,
  OrganizationMembership,
} from "@repo/api/src/types/onboarding-phase";
import { Result, Status } from "@repo/api/src/types/result";
import {
  EXPERIENCE_VARIANT,
  initialPersistedState,
  persistedAccountState,
  transitionCommand,
} from "@/__tests__/support/onboarding-guided/guided-onboarding.test-fixtures";
import { GET } from "../snapshot/route";
import { POST } from "../transition/route";
import { GuidedTransitionOutcome } from "../transition-service";

const SNAPSHOT: GuidedOnboardingSnapshot = {
  attemptId: "attempt-1",
  revision: 4,
  experienceVariant: EXPERIENCE_VARIANT,
  state: initialPersistedState(),
  restoreOutcome: OnboardingRestoreOutcome.Absent,
  context: {
    membership: OrganizationMembership.FirstUser,
    accountStatus: AccountStatus.Established,
    accountProvider: null,
    githubConnected: false,
    desktopAppDownloaded: false,
    organizationHasSyncedSessionData: KnownFlag.No,
    teamInvited: false,
    tourCompleted: false,
  },
};

const ROUTE_PARAMS = { params: Promise.resolve({}) };

function snapshotRequest(query: string): NextRequest {
  return new NextRequest(`http://localhost/onboarding/guided/snapshot${query}`);
}

function transitionRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/onboarding/guided/transition", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /onboarding/guided/snapshot", () => {
  it("returns the snapshot for the requested host", async () => {
    mocks.getSnapshot.mockResolvedValue(SNAPSHOT);

    const response = await GET(
      snapshotRequest(`?host=${OnboardingHost.Desktop}`),
      ROUTE_PARAMS
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data).toEqual(JSON.parse(JSON.stringify(SNAPSHOT)));
    expect(mocks.getSnapshot).toHaveBeenCalledWith({
      organizationId: "org-a",
      userId: "user-a",
      clerkUserId: "clerk_user_a",
      host: OnboardingHost.Desktop,
    });
  });

  it("rejects an unknown host without asking the service", async () => {
    const response = await GET(snapshotRequest("?host=tablet"), ROUTE_PARAMS);

    expect(response.status).toBe(400);
    expect(mocks.getSnapshot).not.toHaveBeenCalled();
  });

  it("rejects a missing host without asking the service", async () => {
    const response = await GET(snapshotRequest(""), ROUTE_PARAMS);

    expect(response.status).toBe(400);
    expect(mocks.getSnapshot).not.toHaveBeenCalled();
  });

  it("maps a failed producer to a 500 rather than a partial snapshot", async () => {
    mocks.getSnapshot.mockRejectedValue(new Error("producer unavailable"));

    const response = await GET(
      snapshotRequest(`?host=${OnboardingHost.Web}`),
      ROUTE_PARAMS
    );

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.data).toBeUndefined();
  });
});

describe("POST /onboarding/guided/transition", () => {
  it("returns 200 with the new snapshot when the transition is accepted", async () => {
    mocks.applyTransition.mockResolvedValue(
      Result.ok({
        outcome: GuidedTransitionOutcome.Accepted,
        snapshot: SNAPSHOT,
      })
    );
    const command = transitionCommand();

    const response = await POST(transitionRequest(command), ROUTE_PARAMS);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data.revision).toBe(SNAPSHOT.revision);
    expect(mocks.applyTransition).toHaveBeenCalledWith(
      {
        organizationId: "org-a",
        userId: "user-a",
        clerkUserId: "clerk_user_a",
        command,
      },
      undefined
    );
  });

  it("returns 200 for a redelivered command that already landed", async () => {
    mocks.applyTransition.mockResolvedValue(
      Result.ok({
        outcome: GuidedTransitionOutcome.Replayed,
        snapshot: SNAPSHOT,
      })
    );

    const response = await POST(
      transitionRequest(transitionCommand()),
      ROUTE_PARAMS
    );

    expect(response.status).toBe(200);
  });

  it("returns 409 carrying the current snapshot when the revision is stale", async () => {
    mocks.applyTransition.mockResolvedValue(
      Result.err({ status: Status.Conflict, snapshot: SNAPSHOT })
    );

    const response = await POST(
      transitionRequest(transitionCommand()),
      ROUTE_PARAMS
    );

    expect(response.status).toBe(409);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe(GUIDED_ONBOARDING_STALE_REVISION_ERROR);
    expect(json.data.revision).toBe(SNAPSHOT.revision);
    expect(json.data.state).toEqual(JSON.parse(JSON.stringify(SNAPSHOT.state)));
  });

  it("returns 400 for a state the machine cannot produce", async () => {
    mocks.applyTransition.mockResolvedValue(
      Result.err({ status: Status.BadRequest, snapshot: null })
    );

    const response = await POST(
      transitionRequest(transitionCommand()),
      ROUTE_PARAMS
    );

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe(GUIDED_ONBOARDING_UNREACHABLE_STATE_ERROR);
  });

  it("acknowledges a durable write with a null snapshot rather than a 500", async () => {
    mocks.applyTransition.mockResolvedValue(
      Result.ok({
        outcome: GuidedTransitionOutcome.Accepted,
        snapshot: null,
      })
    );

    const response = await POST(
      transitionRequest(transitionCommand()),
      ROUTE_PARAMS
    );

    // The write landed; only the read that describes it failed. A 500 here would
    // tell the client its transition did not happen.
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    // `null`, so it can never be read as a snapshot whose fields are false.
    expect(json.data).toBeNull();
  });

  it("answers a conflict with a null snapshot rather than a 500", async () => {
    mocks.applyTransition.mockResolvedValue(
      Result.err({ status: Status.Conflict, snapshot: null })
    );

    const response = await POST(
      transitionRequest(transitionCommand()),
      ROUTE_PARAMS
    );

    expect(response.status).toBe(409);
    const json = await response.json();
    expect(json.error).toBe(GUIDED_ONBOARDING_STALE_REVISION_ERROR);
    expect(json.data).toBeNull();
  });

  it("rejects an unknown key inside `state` and persists nothing", async () => {
    const response = await POST(
      transitionRequest({
        ...transitionCommand(),
        state: { ...persistedAccountState(), somethingNewer: true },
      }),
      ROUTE_PARAMS
    );

    expect(response.status).toBe(400);
    expect(mocks.applyTransition).not.toHaveBeenCalled();
  });

  it("rejects a state written by an unreadable version", async () => {
    const response = await POST(
      transitionRequest({
        ...transitionCommand(),
        state: { ...persistedAccountState(), version: 99 },
      }),
      ROUTE_PARAMS
    );

    expect(response.status).toBe(400);
    expect(mocks.applyTransition).not.toHaveBeenCalled();
  });

  it("rejects an event type a newer client invented, without a partial write", async () => {
    const response = await POST(
      transitionRequest({
        ...transitionCommand(),
        event: { type: "teleport_to_dashboard" },
      }),
      ROUTE_PARAMS
    );

    expect(response.status).toBe(400);
    expect(mocks.applyTransition).not.toHaveBeenCalled();
  });

  it("rejects an event carrying a payload its type does not declare", async () => {
    const response = await POST(
      transitionRequest({
        ...transitionCommand(),
        event: { type: OnboardingEvent.Back, provider: "github" },
      }),
      ROUTE_PARAMS
    );

    expect(response.status).toBe(400);
    expect(mocks.applyTransition).not.toHaveBeenCalled();
  });

  it("rejects a command id that is not a uuid", async () => {
    const response = await POST(
      transitionRequest({ ...transitionCommand(), commandId: "not-a-uuid" }),
      ROUTE_PARAMS
    );

    expect(response.status).toBe(400);
    expect(mocks.applyTransition).not.toHaveBeenCalled();
  });

  it("rejects a negative or fractional revision", async () => {
    const negative = await POST(
      transitionRequest({ ...transitionCommand(), revision: -1 }),
      ROUTE_PARAMS
    );
    const fractional = await POST(
      transitionRequest({ ...transitionCommand(), revision: 1.5 }),
      ROUTE_PARAMS
    );

    expect(negative.status).toBe(400);
    expect(fractional.status).toBe(400);
    expect(mocks.applyTransition).not.toHaveBeenCalled();
  });

  it("rejects a revision past the column's range as a 400, not a Prisma 500", async () => {
    const response = await POST(
      transitionRequest({
        ...transitionCommand(),
        revision: GUIDED_ONBOARDING_MAX_REVISION + 1,
      }),
      ROUTE_PARAMS
    );

    expect(response.status).toBe(400);
    // Unclamped, this value reaches `updateMany` and Prisma rejects it for the
    // INTEGER column — a malformed client command answered as a server error.
    expect(mocks.applyTransition).not.toHaveBeenCalled();
  });

  it("admits the largest revision a command may carry", async () => {
    mocks.applyTransition.mockResolvedValue(
      Result.err({ status: Status.Conflict, snapshot: SNAPSHOT })
    );

    await POST(
      transitionRequest({
        ...transitionCommand(),
        revision: GUIDED_ONBOARDING_MAX_REVISION,
      }),
      ROUTE_PARAMS
    );

    // The bound itself is legal, so the cap cannot be satisfied by rejecting
    // everything large.
    expect(mocks.applyTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          revision: GUIDED_ONBOARDING_MAX_REVISION,
        }),
      }),
      undefined
    );
  });

  it("rejects an unknown top-level key", async () => {
    const response = await POST(
      transitionRequest({ ...transitionCommand(), analysisStarted: true }),
      ROUTE_PARAMS
    );

    expect(response.status).toBe(400);
    expect(mocks.applyTransition).not.toHaveBeenCalled();
  });

  it("maps an unexpected service failure to a 500", async () => {
    mocks.applyTransition.mockRejectedValue(new Error("database unavailable"));

    const response = await POST(
      transitionRequest(transitionCommand()),
      ROUTE_PARAMS
    );

    expect(response.status).toBe(500);
  });
});
