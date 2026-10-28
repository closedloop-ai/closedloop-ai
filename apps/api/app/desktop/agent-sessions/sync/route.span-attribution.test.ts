/**
 * @file route.span-attribution.test.ts
 * @description ISS-7767: the desktop sync route's 500s must reach the
 * `request_completed` span with BOTH `app.error.source` and `error.type`.
 *
 * ISS-7217 put the attribution recorder inside `errorResponse`, which reduces
 * its error argument to a class name via `resolveSpanErrorType`. That resolver
 * can only name an OBJECT, so this route's ingest-rejection branch — which
 * handed it the bare `reason` string — recorded a source with no type. That
 * branch is also the route's *unclassified* 500 fallthrough (ISS-7730), which
 * made the platform's largest 5xx source its least diagnosable one.
 *
 * These drive the REAL route handler, the REAL `errorResponse`, and the REAL
 * attribution store (the scope each auth wrapper opens per request); only the
 * service and the auth wrapper are doubles. The reason-derived suffix and the
 * differently-shaped-error case are here on purpose: a test that only pinned
 * the one fixed string would stay green if the resolver were replaced by a
 * constant.
 */

import { SpanErrorSource } from "@closedloop-ai/telemetry-contract/span";
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  DesktopAgentSessionsAckReason,
  DesktopAgentSessionsSyncErrorCode,
} from "@repo/api/src/types/agent-session";
import { Result, Status } from "@repo/api/src/types/result";
import type { RequestCompletedSpanAttribution } from "@repo/observability/telemetry/request-completed";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: {
    clerkUserId: "clerk-user-1",
    user: {
      id: "user-1",
      organizationId: "org-1",
    },
  },
  sync: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest) =>
      handler(mocks.auth, request),
}));

vi.mock("./service", () => ({
  desktopAgentSessionsSyncService: {
    sync: mocks.sync,
  },
}));

import {
  getRequestSpanAttribution,
  runWithRequestSpanAttribution,
} from "@/lib/observability/request-span-attribution";
import { POST } from "./route";

const COMPUTE_TARGET_ID = "11111111-1111-7111-8111-111111111111";

/**
 * The class name `errorResponse` must be able to read off this route's ingest
 * rejection. Spelled out rather than read off the production class, so the
 * assertion cannot agree with a renamed or re-shaped error by construction.
 */
const SYNC_ERROR_CLASS = "DesktopAgentSessionsSyncError";

describe("POST /desktop/agent-sessions/sync span attribution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sync.mockResolvedValue(Result.ok({ synced: true }));
  });

  it("records both a source and a reason-classified type for an ingest rejection", async () => {
    mocks.sync.mockResolvedValueOnce(
      Result.err({ reason: DesktopAgentSessionsAckReason.IngestionFailed })
    );

    const { response, body, attribution } = await postWithAttribution();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      success: false,
      error: "Failed to sync agent session",
      code: DesktopAgentSessionsSyncErrorCode.IngestionFailed,
    });
    expect(attribution?.errorSource).toBe(SpanErrorSource.RouteHandler);
    expect(attribution?.errorType).toBe(
      `${SYNC_ERROR_CLASS}.${DesktopAgentSessionsAckReason.IngestionFailed}`
    );
  });

  /**
   * The suffix is DERIVED from the rejection, not baked into the class. A
   * reason the span's code shape cannot carry (a numeric `StatusCode`) must
   * still leave the class name behind rather than drop the attribute — the
   * degrade `resolveSpanErrorType` promises.
   */
  it("derives the type suffix from the reason, degrading to the bare class", async () => {
    mocks.sync.mockResolvedValueOnce(Result.err({ reason: Status.Error }));

    const { response, attribution } = await postWithAttribution();

    expect(response.status).toBe(500);
    expect(attribution?.errorSource).toBe(SpanErrorSource.RouteHandler);
    expect(attribution?.errorType).toBe(SYNC_ERROR_CLASS);
  });

  /**
   * The positive sibling: the resolver is still the thing doing the naming on
   * this route. A thrown value of a different shape reaches the same span with
   * ITS own class, so a later change that bypassed the classifier for anything
   * but the branch above would be caught here.
   */
  it("classifies a differently-shaped thrown error on the same route", async () => {
    mocks.sync.mockRejectedValueOnce(new TypeError("boom"));

    const { response, body, attribution } = await postWithAttribution();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      success: false,
      error: "Failed to sync agent session",
      code: DesktopAgentSessionsSyncErrorCode.InternalError,
    });
    expect(attribution?.errorSource).toBe(SpanErrorSource.RouteHandler);
    expect(attribution?.errorType).toBe("TypeError");
  });

  /**
   * A 4xx is an outcome the route deliberately returned, so it must attribute
   * nothing — otherwise every rejected payload inflates the 5xx population the
   * RCA reads. Graded against the two positive cases above.
   */
  it("attributes nothing when the route returns a client rejection", async () => {
    mocks.sync.mockResolvedValueOnce(
      Result.err({ reason: DesktopAgentSessionsAckReason.ValidationFailed })
    );

    const { response, attribution } = await postWithAttribution();

    expect(response.status).toBe(400);
    expect(attribution?.errorSource).toBeUndefined();
    expect(attribution?.errorType).toBeUndefined();
  });
});

/**
 * Drive the route inside an attribution scope and read the store from INSIDE
 * it — `getRequestSpanAttribution()` answers `undefined` outside the
 * AsyncLocalStorage run, which is what the auth wrapper's emitter is inside of.
 */
async function postWithAttribution(): Promise<{
  response: Response;
  body: unknown;
  attribution: RequestCompletedSpanAttribution | undefined;
}> {
  let attribution: RequestCompletedSpanAttribution | undefined;
  const response = await runWithRequestSpanAttribution(async () => {
    const result = await POST(request(), routeContext());
    attribution = getRequestSpanAttribution();
    return result;
  });
  return { response, body: await response.json(), attribution };
}

function request(): NextRequest {
  return new NextRequest(
    `https://api.example.test/desktop/agent-sessions/sync?computeTargetId=${COMPUTE_TARGET_ID}`,
    {
      body: JSON.stringify({
        schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
        sessions: [],
      }),
      method: "POST",
    }
  );
}

function routeContext(): { params: Promise<Record<string, string>> } {
  return { params: Promise.resolve({}) };
}
