import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  desktopOnboardingAttemptsService: { create: vi.fn() },
  resolveSessionUser: vi.fn(),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(async () => undefined),
  },
  scheduleLogFlush: vi.fn(),
}));

vi.mock("./service", () => ({
  desktopOnboardingAttemptsService: mocks.desktopOnboardingAttemptsService,
}));
vi.mock("@/lib/auth/session-user", () => ({
  resolveSessionUser: mocks.resolveSessionUser,
}));
vi.mock("@repo/observability/log", () => ({ log: mocks.log }));
vi.mock("@/lib/route-utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/route-utils")>()),
  scheduleLogFlush: mocks.scheduleLogFlush,
}));

import {
  oneDesktopConnectRejection,
  readDesktopConnectRejection,
} from "@/__tests__/utils/desktop-connect-rejected.test-helpers";
import {
  stubTrustedOriginEnv,
  TRUSTED_APP_ORIGIN,
  TRUSTED_WEB_ORIGIN,
} from "@/__tests__/utils/trusted-origin.test-helpers";
import { desktopConnectRejectionThrottle } from "@/app/desktop/contract";
import { POST } from "./route";

const ORG_ID = "org-1";

function rawAttemptRequest(body: string, originHeader = TRUSTED_APP_ORIGIN) {
  return new Request("https://api.closedloop.ai/desktop/onboarding-attempt", {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: originHeader },
    body,
  });
}

function attemptRequest(body: unknown, originHeader = TRUSTED_APP_ORIGIN) {
  return rawAttemptRequest(JSON.stringify(body), originHeader);
}

function signedInSession() {
  return { user: { id: "user-1", organizationId: ORG_ID } };
}

function arrangeSignedIn() {
  mocks.resolveSessionUser.mockResolvedValue(signedInSession());
}

/**
 * ISS-6343. Each row drives ONE rejection branch of the production handler and
 * pins the reason it reports. The reason/stage/cause strings are written here
 * independently of the route so a swapped or dropped constant reddens a row.
 */
const rejectionBranches = [
  {
    name: "session resolution faults",
    arrange: () => {
      mocks.resolveSessionUser.mockRejectedValue(new Error("clerk down"));
    },
    request: () => attemptRequest({ webAppOrigin: TRUSTED_APP_ORIGIN }),
    status: 503,
    retryable: true,
    // `cause` is what keeps this apart from the persistence failure below: both
    // must report the same wire code, but they are not the same incident.
    fields: {
      reason: "ONBOARDING_ATTEMPT_PERSIST_FAILED",
      stage: "onboarding_attempt",
      cause: "session_lookup_faulted",
    },
  },
  {
    name: "no signed-in session",
    arrange: () => {
      mocks.resolveSessionUser.mockResolvedValue(null);
    },
    request: () => attemptRequest({ webAppOrigin: TRUSTED_APP_ORIGIN }),
    status: 401,
    retryable: false,
    fields: { reason: "SESSION_REQUIRED", stage: "onboarding_attempt" },
  },
  {
    name: "the body is not valid JSON",
    arrange: arrangeSignedIn,
    // A literal malformed payload, so `request.json()` throws. Without its own
    // row this branch degrades from a 400 to an unhandled 500 undetected.
    request: () => rawAttemptRequest("{not json"),
    status: 400,
    retryable: false,
    fields: {
      reason: "INVALID_ONBOARDING_ATTEMPT_REQUEST",
      stage: "onboarding_attempt",
      orgId: ORG_ID,
    },
  },
  {
    name: "the body fails schema validation",
    arrange: arrangeSignedIn,
    request: () => attemptRequest({}),
    status: 400,
    retryable: false,
    fields: {
      reason: "INVALID_ONBOARDING_ATTEMPT_REQUEST",
      stage: "onboarding_attempt",
      orgId: ORG_ID,
    },
  },
  {
    name: "request Origin does not match webAppOrigin",
    arrange: arrangeSignedIn,
    // Both origins are allowlisted, so this isolates the mismatch branch.
    request: () =>
      attemptRequest({ webAppOrigin: TRUSTED_APP_ORIGIN }, TRUSTED_WEB_ORIGIN),
    status: 403,
    retryable: false,
    fields: {
      reason: "ONBOARDING_ATTEMPT_FORBIDDEN",
      stage: "onboarding_attempt",
      orgId: ORG_ID,
    },
  },
  {
    name: "attempt persistence throws",
    arrange: () => {
      arrangeSignedIn();
      mocks.desktopOnboardingAttemptsService.create.mockRejectedValue(
        new Error("database unavailable")
      );
    },
    request: () => attemptRequest({ webAppOrigin: TRUSTED_APP_ORIGIN }),
    status: 503,
    retryable: true,
    fields: {
      reason: "ONBOARDING_ATTEMPT_PERSIST_FAILED",
      stage: "onboarding_attempt",
      orgId: ORG_ID,
      cause: "attempt_persist_faulted",
    },
  },
];

describe("POST /desktop/onboarding-attempt rejection telemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubTrustedOriginEnv();
    // Two rows share one throttle key — same stage, reason and org — so
    // without this the second is suppressed and reports nothing.
    desktopConnectRejectionThrottle.clear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(rejectionBranches)(
    "reports $fields.reason when $name",
    async ({ arrange, request, status, retryable, fields }) => {
      arrange();

      const response = await POST(request());

      // Pins that the intended branch ran, and that the reason the counter
      // reports is the same string the caller receives as `code`.
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toEqual({
        code: fields.reason,
        retryable,
      });
      expect(readDesktopConnectRejection(mocks.log.warn)).toEqual(
        oneDesktopConnectRejection(fields)
      );
    }
  );

  it("flushes the log buffer so the rejection survives the function freeze", async () => {
    mocks.resolveSessionUser.mockResolvedValue(null);

    await POST(attemptRequest({ webAppOrigin: TRUSTED_APP_ORIGIN }));

    expect(mocks.scheduleLogFlush).toHaveBeenCalledTimes(1);
  });

  it("reports nothing when the attempt is created", async () => {
    arrangeSignedIn();
    mocks.desktopOnboardingAttemptsService.create.mockResolvedValue({
      onboardingAttemptId: "attempt-1",
      expiresAt: new Date("2026-06-29T12:15:00.000Z"),
    });

    const response = await POST(
      attemptRequest({ webAppOrigin: TRUSTED_APP_ORIGIN })
    );

    expect(response.status).toBe(200);
    expect(mocks.log.warn).not.toHaveBeenCalled();
    expect(mocks.scheduleLogFlush).not.toHaveBeenCalled();
  });
});
