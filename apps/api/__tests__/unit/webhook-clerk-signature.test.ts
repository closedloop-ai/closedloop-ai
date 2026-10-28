import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockAnalyticsShutdown,
  mockEnv,
  mockHandleOrganizationCreated,
  mockHandleOrganizationDeleted,
  mockHandleOrganizationMembershipCreated,
  mockHandleOrganizationMembershipDeleted,
  mockHandleOrganizationMembershipUpdated,
  mockHandleOrganizationUpdated,
  mockHandleUserCreated,
  mockHandleUserDeleted,
  mockHandleUserUpdated,
  mockHeaders,
  mockLogError,
  mockLogFlush,
  mockLogInfo,
  mockLogWarn,
  mockVerify,
  mockWebhookConstructor,
} = vi.hoisted(() => {
  return {
    mockAnalyticsShutdown: vi.fn(),
    mockEnv: { CLERK_WEBHOOK_SECRET: "whsec_test" },
    mockHandleOrganizationCreated: vi.fn(),
    mockHandleOrganizationDeleted: vi.fn(),
    mockHandleOrganizationMembershipCreated: vi.fn(),
    mockHandleOrganizationMembershipDeleted: vi.fn(),
    mockHandleOrganizationMembershipUpdated: vi.fn(),
    mockHandleOrganizationUpdated: vi.fn(),
    mockHandleUserCreated: vi.fn(),
    mockHandleUserDeleted: vi.fn(),
    mockHandleUserUpdated: vi.fn(),
    mockHeaders: vi.fn(),
    mockLogError: vi.fn(),
    mockLogFlush: vi.fn(),
    mockLogInfo: vi.fn(),
    mockLogWarn: vi.fn(),
    mockVerify: vi.fn(),
    mockWebhookConstructor: vi.fn(),
  };
});

vi.mock("@/env", () => ({ env: mockEnv }));

vi.mock("next/headers", () => ({ headers: mockHeaders }));

vi.mock("svix", () => ({
  Webhook: class {
    verify = mockVerify;

    constructor(secret: string) {
      mockWebhookConstructor(secret);
    }
  },
}));

vi.mock("@repo/analytics/server", () => ({
  analytics: { shutdown: mockAnalyticsShutdown },
}));

// `log.flush` is the flush COUNT this suite asserts on (ISS-9053). Every arm
// below pins exactly one per delivery — `withRequestCompleted`'s `finally` is
// the sole terminal flush owner, so a receiver-side `scheduleLogFlush()` added
// back to `auth/route.ts` would read as two here.
vi.mock("@repo/observability/log", () => ({
  log: {
    error: mockLogError,
    flush: mockLogFlush,
    info: mockLogInfo,
    warn: mockLogWarn,
  },
}));

vi.mock("@/app/webhooks/auth/auth-hooks", () => ({
  handleOrganizationCreated: mockHandleOrganizationCreated,
  handleOrganizationDeleted: mockHandleOrganizationDeleted,
  handleOrganizationMembershipCreated: mockHandleOrganizationMembershipCreated,
  handleOrganizationMembershipDeleted: mockHandleOrganizationMembershipDeleted,
  handleOrganizationMembershipUpdated: mockHandleOrganizationMembershipUpdated,
  handleOrganizationUpdated: mockHandleOrganizationUpdated,
  handleUserCreated: mockHandleUserCreated,
  handleUserDeleted: mockHandleUserDeleted,
  handleUserUpdated: mockHandleUserUpdated,
}));

import {
  erroringBody,
  streamRequest,
} from "@/__tests__/utils/bounded-body.test-helpers";
import { POST } from "@/app/webhooks/auth/route";
import { CLERK_WEBHOOK_MAX_BYTES } from "@/app/webhooks/webhook-body";

const WEBHOOK_URL = "http://localhost:3002/webhooks/auth";

const SVIX_ID_HEADER = "svix-id";
const SVIX_TIMESTAMP_HEADER = "svix-timestamp";
const SVIX_SIGNATURE_HEADER = "svix-signature";

const SIGNED_HEADERS: Record<string, string> = {
  [SVIX_ID_HEADER]: "msg_123",
  [SVIX_TIMESTAMP_HEADER]: "1614588800",
  [SVIX_SIGNATURE_HEADER]: "v1,signature",
};

const USER_CREATED_EVENT = {
  data: { id: "user_123" },
  type: "user.created",
};

const MEMBERSHIP_DELETED_EVENT = {
  data: { id: "orgmem_123" },
  type: "organizationMembership.deleted",
};

// A real Clerk event type this route does not handle, for the `default:` arm.
const SESSION_REVOKED_EVENT = {
  data: { id: "sess_123" },
  type: "session.revoked",
};

const HANDLER_FAILURE = "membership delete failed";
const SHUTDOWN_FAILURE = "posthog shutdown timed out";
const UNHANDLED_ERROR_LOG = "[webhook/auth] Unhandled error processing webhook";
const SHUTDOWN_FAILURE_LOG = "[webhook/auth] analytics shutdown failed";
const SERVER_ERROR_BODY = { message: "Something went wrong", ok: false };

// USER_CREATED_EVENT as Clerk would put it on the wire, deliberately spaced so
// that JSON.parse + JSON.stringify yields a different string: that difference
// is what distinguishes verifying the raw body from verifying a re-serialized
// copy. Every rejection case sends this same dispatchable payload, so "no
// handler ran" means the gate held rather than that the payload was inert.
const RAW_EVENT_BODY = `{
  "data": { "id": "user_123" },
  "type": "user.created"
}`;

// A NAME, not an email or a token: in production `redactSensitiveText` strips
// emails and secret-shaped values from every logged string, so an email canary
// would come back clean whether or not the field was dropped. A name is the
// class of Clerk PII that survives redaction, which is why dropping the field
// is the fix (ISS-7972).
const PII_CANARY = "CanaryFirstName7972";

const RAW_EVENT_BODY_WITH_PII = `{
  "data": { "id": "user_123", "first_name": "${PII_CANARY}" },
  "type": "user.created"
}`;

const NOTHING_DISPATCHED = {
  handlerCalls: 0,
  verifyCalls: 0,
  webhookConstructions: 0,
} as const;

const ALL_HANDLERS = [
  mockHandleOrganizationCreated,
  mockHandleOrganizationDeleted,
  mockHandleOrganizationMembershipCreated,
  mockHandleOrganizationMembershipDeleted,
  mockHandleOrganizationMembershipUpdated,
  mockHandleOrganizationUpdated,
  mockHandleUserCreated,
  mockHandleUserDeleted,
  mockHandleUserUpdated,
];

describe("POST /webhooks/auth signature gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.CLERK_WEBHOOK_SECRET = "whsec_test";
    mockHeaders.mockResolvedValue(new Headers(SIGNED_HEADERS));
    mockVerify.mockReturnValue(USER_CREATED_EVENT);
    mockHandleUserCreated.mockResolvedValue(new Response("", { status: 200 }));
    mockLogFlush.mockResolvedValue(undefined);
  });

  it.each([[SVIX_ID_HEADER], [SVIX_TIMESTAMP_HEADER], [SVIX_SIGNATURE_HEADER]])(
    "rejects a payload missing %s",
    async (omitted) => {
      mockHeaders.mockResolvedValue(new Headers(withoutHeader(omitted)));

      const response = await POST(makeRequest());

      expect(response.status).toBe(400);
      expect(dispatchCalls()).toEqual(NOTHING_DISPATCHED);
      expect(mockLogFlush).toHaveBeenCalledTimes(1);
    }
  );

  it("rejects a payload carrying no svix headers at all", async () => {
    mockHeaders.mockResolvedValue(new Headers());

    const response = await POST(makeRequest());

    expect(response.status).toBe(400);
    expect(dispatchCalls()).toEqual(NOTHING_DISPATCHED);
    expect(mockLogFlush).toHaveBeenCalledTimes(1);
  });

  it("rejects a forged signature that fails verification", async () => {
    mockVerify.mockImplementation(() => {
      throw new Error("No matching signature found");
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(400);
    expect(mockWebhookConstructor).toHaveBeenCalledWith("whsec_test");
    expect(dispatchCalls()).toEqual({
      handlerCalls: 0,
      verifyCalls: 1,
      webhookConstructions: 1,
    });
    expect(mockLogFlush).toHaveBeenCalledTimes(1);
  });

  it("verifies the raw body, then dispatches to the handler", async () => {
    expect(RAW_EVENT_BODY).not.toBe(JSON.stringify(JSON.parse(RAW_EVENT_BODY)));

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockVerify).toHaveBeenCalledWith(RAW_EVENT_BODY, SIGNED_HEADERS);
    expect(mockHandleUserCreated).toHaveBeenCalledWith(USER_CREATED_EVENT.data);
    expect(mockAnalyticsShutdown).toHaveBeenCalledTimes(1);
  });

  it("never verifies or dispatches when no webhook secret is configured", async () => {
    mockEnv.CLERK_WEBHOOK_SECRET = "";

    const response = await POST(makeRequest());

    // An unconfigured Clerk integration auto-disables with a 200 rather than a
    // 400, which providers read as a delivery failure and retry.
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: false });
    expect(dispatchCalls()).toEqual(NOTHING_DISPATCHED);
    expect(mockLogFlush).toHaveBeenCalledTimes(1);
  });

  it("returns a 500 instead of rejecting when a handler throws", async () => {
    mockVerify.mockReturnValue(MEMBERSHIP_DELETED_EVENT);
    mockHandleOrganizationMembershipDeleted.mockRejectedValueOnce(
      new Error(HANDLER_FAILURE)
    );

    const inFlight = POST(makeRequest());
    await expect(inFlight).resolves.toBeInstanceOf(Response);
    const response = await inFlight;

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual(SERVER_ERROR_BODY);
    expect(mockLogError).toHaveBeenCalledWith(UNHANDLED_ERROR_LOG, {
      error: HANDLER_FAILURE,
    });
    expect(mockHandleOrganizationMembershipDeleted).toHaveBeenCalledWith(
      MEMBERSHIP_DELETED_EVENT.data
    );
    expect(mockLogFlush).toHaveBeenCalledTimes(1);
    expect(mockAnalyticsShutdown).toHaveBeenCalledTimes(1);
  });

  it("returns the 500 envelope when the analytics shutdown also fails on the error path", async () => {
    mockVerify.mockReturnValue(MEMBERSHIP_DELETED_EVENT);
    mockHandleOrganizationMembershipDeleted.mockRejectedValueOnce(
      new Error(HANDLER_FAILURE)
    );
    mockAnalyticsShutdown.mockRejectedValueOnce(new Error(SHUTDOWN_FAILURE));

    const inFlight = POST(makeRequest());
    await expect(inFlight).resolves.toBeInstanceOf(Response);
    const response = await inFlight;

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual(SERVER_ERROR_BODY);
    expect(mockLogError).toHaveBeenCalledWith(UNHANDLED_ERROR_LOG, {
      error: HANDLER_FAILURE,
    });
    expect(mockLogError).toHaveBeenCalledWith(SHUTDOWN_FAILURE_LOG, {
      error: SHUTDOWN_FAILURE,
    });
  });

  it("returns a 500 when the body read fails before verification", async () => {
    const response = await POST(
      streamRequest(WEBHOOK_URL, erroringBody("stream aborted"))
    );

    expect(response.status).toBe(500);
    expect(dispatchCalls()).toEqual(NOTHING_DISPATCHED);
    expect(mockLogFlush).toHaveBeenCalledTimes(1);
    expect(mockAnalyticsShutdown).not.toHaveBeenCalled();
  });

  it("returns a 500 when reading the request headers fails", async () => {
    mockHeaders.mockRejectedValueOnce(new Error("headers unavailable"));
    const request = makeRequest();

    const response = await POST(request);

    expect(response.status).toBe(500);
    // The wrapper opens before `await headers()`: nothing downstream of it ran,
    // and an untouched body is the only observable proof (the bounded reader is
    // not mocked, so there is no spy to count).
    expect(request.bodyUsed).toBe(false);
    expect(dispatchCalls()).toEqual(NOTHING_DISPATCHED);
    expect(mockLogFlush).toHaveBeenCalledTimes(1);
    expect(mockAnalyticsShutdown).not.toHaveBeenCalled();
  });

  it("returns a 500 when the svix client cannot be constructed", async () => {
    mockWebhookConstructor.mockImplementationOnce(() => {
      throw new Error("Base64Coder: incorrect characters for decoding");
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(500);
    expect(dispatchCalls()).toEqual({
      handlerCalls: 0,
      verifyCalls: 0,
      webhookConstructions: 1,
    });
    expect(mockLogFlush).toHaveBeenCalledTimes(1);
    expect(mockAnalyticsShutdown).not.toHaveBeenCalled();
  });

  it("logs the event identity without the raw request body", async () => {
    const response = await POST(makeRequest(RAW_EVENT_BODY_WITH_PII));

    expect(response.status).toBe(200);
    expect(mockLogInfo).toHaveBeenCalledWith("[webhook/auth] Webhook", {
      eventType: USER_CREATED_EVENT.type,
      id: USER_CREATED_EVENT.data.id,
    });
    expect(everyLoggedArgument()).not.toContain(PII_CANARY);
  });

  it("returns 201 without dispatching for an unsupported event type", async () => {
    // Pins CURRENT behaviour, not a fix. `webhooks/AGENTS.md` (Rules) asks for a
    // 200 with `ok: true` and one `outcome: "unsupported_event"` log; this
    // receiver returns the 201 its response variable was initialised with and
    // logs nothing. ISS-7972 deliberately deferred that conversion (it is a wire
    // change against a live provider), so a red here is a behaviour change
    // someone made, not a regression this test failed to catch.
    mockVerify.mockReturnValue(SESSION_REVOKED_EVENT);

    const response = await POST(makeRequest());

    expect(response.status).toBe(201);
    expect(dispatchCalls()).toEqual({
      handlerCalls: 0,
      verifyCalls: 1,
      webhookConstructions: 1,
    });
    expect(mockLogFlush).toHaveBeenCalledTimes(1);
    // No handler ran, so nothing captured analytics: the arm returns the 201
    // ahead of the shutdown instead of joining the shared client's queue.
    expect(mockAnalyticsShutdown).not.toHaveBeenCalled();
  });

  it("keeps the handler's response when the analytics shutdown fails", async () => {
    mockAnalyticsShutdown.mockRejectedValueOnce(new Error(SHUTDOWN_FAILURE));

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockLogError).toHaveBeenCalledWith(SHUTDOWN_FAILURE_LOG, {
      error: SHUTDOWN_FAILURE,
    });
  });

  it("does not return the response until the analytics shutdown settles", async () => {
    let openGate: () => void = () => {
      throw new Error("gate never installed");
    };
    mockAnalyticsShutdown.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        openGate = resolve;
      })
    );

    let settled = false;
    const inFlight = POST(makeRequest()).then((response) => {
      settled = true;
      return response;
    });
    await yieldToEventLoop();

    // An un-awaited call would already have let POST return: invoking an async
    // function runs it synchronously only up to its first await, so "called
    // once" cannot distinguish awaited from fire-and-forget.
    expect(mockAnalyticsShutdown).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    openGate();
    const response = await inFlight;

    expect(response.status).toBe(200);
  });

  it("does not return the 500 until the analytics shutdown settles", async () => {
    mockVerify.mockReturnValue(MEMBERSHIP_DELETED_EVENT);
    mockHandleOrganizationMembershipDeleted.mockRejectedValueOnce(
      new Error(HANDLER_FAILURE)
    );
    let openGate: () => void = () => {
      throw new Error("gate never installed");
    };
    mockAnalyticsShutdown.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        openGate = resolve;
      })
    );

    let settled = false;
    const inFlight = POST(makeRequest()).then((response) => {
      settled = true;
      return response;
    });
    await yieldToEventLoop();

    // The error path needs its own gate: the success-tail case cannot reach
    // this call site, so an un-awaited shutdown here would return the 500 while
    // the analytics flush was still in flight.
    expect(mockAnalyticsShutdown).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    openGate();
    const response = await inFlight;

    expect(response.status).toBe(500);
  });

  it.each([
    {
      arrange: () => {
        mockEnv.CLERK_WEBHOOK_SECRET = "";
      },
      label: "the integration is not configured",
      request: () => makeRequest(),
      status: 200,
    },
    {
      arrange: () => {
        mockHeaders.mockResolvedValue(new Headers());
      },
      label: "the svix headers are missing",
      request: () => makeRequest(),
      status: 400,
    },
    {
      arrange: () => {
        mockVerify.mockImplementation(() => {
          throw new Error("No matching signature found");
        });
      },
      label: "the signature does not verify",
      request: () => makeRequest(),
      status: 400,
    },
    {
      arrange: () => {
        mockHeaders.mockResolvedValue(new Headers(SIGNED_HEADERS));
      },
      label: "the body is over the cap",
      request: () => makeRequest("a".repeat(CLERK_WEBHOOK_MAX_BYTES + 1)),
      status: 413,
    },
  ])(
    "never shuts analytics down when $label",
    async ({ arrange, request, status }) => {
      arrange();

      const response = await POST(request());

      // The status is asserted per arm so that an arm which silently took some
      // other path cannot satisfy "shutdown was not called" for the wrong reason.
      expect(response.status).toBe(status);
      expect(mockAnalyticsShutdown).not.toHaveBeenCalled();
    }
  );
});

function withoutHeader(omitted: string): Record<string, string> {
  const headers = { ...SIGNED_HEADERS };
  Reflect.deleteProperty(headers, omitted);
  return headers;
}

function makeRequest(body = RAW_EVENT_BODY) {
  return new Request(WEBHOOK_URL, {
    body,
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

function dispatchCalls(): Record<string, number> {
  return {
    handlerCalls: ALL_HANDLERS.reduce(
      (total, handler) => total + handler.mock.calls.length,
      0
    ),
    verifyCalls: mockVerify.mock.calls.length,
    webhookConstructions: mockWebhookConstructor.mock.calls.length,
  };
}

function everyLoggedArgument(): string {
  return JSON.stringify([
    ...mockLogInfo.mock.calls,
    ...mockLogWarn.mock.calls,
    ...mockLogError.mock.calls,
  ]);
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
