import { readdirSync } from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { ApproverRole } from "@repo/api/src/types/user";
import {
  DESKTOP_SESSION_JWT_SECRET_ENV,
  issueDesktopAccessToken,
} from "@repo/auth/desktop-session-jwt";
import { log } from "@repo/observability/log";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { organizationsService } from "@/app/organizations/service";
import { usersService } from "@/app/users/service";
import {
  DESKTOP_REPLAY_SNAPSHOT_MEASURED_EVENT,
  DESKTOP_REPLAY_SNAPSHOT_REJECTED_EVENT,
} from "./handler";
import { POST } from "./route";
import {
  DESKTOP_REPLAY_DECODED_MAX_BYTES,
  DESKTOP_REPLAY_IDENTITY_UNRESOLVED_EVENT,
  DESKTOP_REPLAY_INSTALL_MAX_BYTES_PER_WINDOW,
  DESKTOP_REPLAY_INSTALL_MAX_REQUESTS_PER_WINDOW,
  DESKTOP_REPLAY_REQUEST_MAX_BYTES,
  DesktopReplayForwardFailure,
  DesktopReplayRejection,
  desktopReplayInstallByteBudget,
  desktopReplayInstallRequestBudget,
} from "./service";

// Literals, not the handler's constants: the deployments this route answers
// on, and PostHog's own capture endpoint, are the contracts under test.
const PROD_DD_ENV = "prod";
const PROD_HOST = "api.closedloop.ai";
const POSTHOG_HOST = "https://posthog.example.test";
const POSTHOG_SNAPSHOT_URL = `${POSTHOG_HOST}/s/?compression=gzip-js`;
const SERVER_TOKEN = "phc_server_held_project_token";
const NODE_UUID = "2f1c8f8e-3b7a-4c1d-9e2f-5a6b7c8d9e0f";
const OTHER_NODE_UUID = "8d0e6b2a-1c3f-4a5b-8c7d-9e0f1a2b3c4d";
const POSTHOG_DEFAULT_UUID_V7 = "01926f0e-8c3a-7b2d-9e4f-1a2b3c4d5e6f";
const SESSION_ID = "01926f0e-8c3a-7000-8000-00000000abcd";
const CLIENT_PLACEHOLDER_TOKEN = "desktop-replay-keyless";
const SNAPSHOT_EVENT_UUID = "01926f0e-8c3a-7000-8000-0000000000ef";
const SNAPSHOT_EVENT_OFFSET_MS = 2994;
const FIXED_NOW = new Date("2026-10-07T12:00:00Z");
const FIXED_NOW_SECONDS = FIXED_NOW.getTime() / 1000;
const JWT_SECRET = "replay-identity-test-secret-0123456789abcdef";
const FORGER_JWT_SECRET = "a-forger-holds-this-other-secret-9876543210";
const CLERK_USER_ID = "user_2replaySignedInClerkId";
const CLERK_ORG_ID = "org_2replaySignedInClerkOrg";
const INTERNAL_USER_ID = "internal-user-1";
const INTERNAL_ORG_ID = "internal-org-1";

const fetchMock = vi.fn((_url: string, _init: RequestInit) =>
  Promise.resolve(new Response("{}"))
);

vi.mock("@/app/users/service", () => ({
  usersService: { findById: vi.fn() },
}));
vi.mock("@/app/organizations/service", () => ({
  organizationsService: { findById: vi.fn() },
}));

describe("POST /r/s (ISS-11946 desktop replay ingress)", () => {
  let info: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIXED_NOW);
    vi.stubEnv("DD_ENV", PROD_DD_ENV);
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", SERVER_TOKEN);
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_HOST", POSTHOG_HOST);
    vi.stubGlobal("fetch", fetchMock);
    desktopReplayInstallRequestBudget.clear();
    desktopReplayInstallByteBudget.clear();
    info = vi.spyOn(log, "info").mockImplementation(() => undefined);
    vi.spyOn(log, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each([
    ["prod", "prod"],
    ["stage", "stage"],
  ])(
    "forwards a gzip-js batch to PostHog /s/ on %s with the server-held token",
    async (_label, ddEnv) => {
      vi.stubEnv("DD_ENV", ddEnv);
      const json = JSON.stringify(snapshotBatch(NODE_UUID));
      const body = gzipSync(json);

      const response = await POST(
        snapshotRequest(body, { compression: "gzip-js" })
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(info).toHaveBeenCalledWith(
        DESKTOP_REPLAY_SNAPSHOT_MEASURED_EVENT,
        {
          wireBytes: body.byteLength,
          decodedBytes: Buffer.byteLength(json),
          compression: "gzip-js",
          events: 2,
          snapshotItems: 3,
          replaySessionId: SESSION_ID,
          sessionCount: 1,
          firstEventAt: 1000,
          lastEventAt: 61_000,
        }
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const forwarded = forwardedCall();
      expect(forwarded.url).toBe(POSTHOG_SNAPSHOT_URL);
      expect(forwarded.method).toBe("POST");
      expect(forwarded.batch.map((event) => event.offset)).toEqual([
        SNAPSHOT_EVENT_OFFSET_MS,
        SNAPSHOT_EVENT_OFFSET_MS,
      ]);
      expect(forwarded.batch).toEqual(
        snapshotBatch(NODE_UUID).map((event) => ({
          ...event,
          properties: { ...event.properties, token: SERVER_TOKEN },
        }))
      );
    }
  );

  it("injects the token into every event even when the client sends none or its own", async () => {
    const batch = snapshotBatch(NODE_UUID);
    batch[0].properties.token = "phc_client_supplied_token";
    Reflect.deleteProperty(batch[1].properties, "token");

    const response = await POST(
      snapshotRequest(Buffer.from(JSON.stringify(batch)))
    );

    expect(response.status).toBe(200);
    expect(
      forwardedCall().batch.map((event) => event.properties.token)
    ).toEqual([SERVER_TOKEN, SERVER_TOKEN]);
  });

  it("forwards no top-level key beyond what posthog-js sends", async () => {
    const batch = snapshotBatch(NODE_UUID).map((event) => ({
      ...event,
      token: "phc_caller_token",
      $token: "phc_caller_token",
      api_key: "phc_caller_token",
      distinct_id: "a-real-person",
      $distinct_id: "a-real-person",
      $set_once: { email: "someone@example.test" },
    }));

    const response = await POST(
      snapshotRequest(Buffer.from(JSON.stringify(batch)))
    );

    expect(response.status).toBe(200);
    for (const event of forwardedCall().batch) {
      expect(Object.keys(event).sort()).toEqual([
        "event",
        "offset",
        "properties",
        "uuid",
      ]);
      expect(event.properties.distinct_id).toBe(NODE_UUID);
      expect(event.properties.token).toBe(SERVER_TOKEN);
    }
  });

  it("bounds the PostHog forward with an abort signal", async () => {
    await POST(
      snapshotRequest(Buffer.from(JSON.stringify(snapshotBatch(NODE_UUID))))
    );

    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
  });

  it("serves only the snapshot path under /r", () => {
    const routeDir = path.join(import.meta.dirname, "..");
    const routes = readdirSync(routeDir, { recursive: true, encoding: "utf8" })
      .filter((file) => path.basename(file).startsWith("route."))
      .filter((file) => !file.includes(".test."));

    expect(routes).toEqual([path.join("s", "route.ts")]);
  });

  it.each([
    ["dev", "dev"],
    ["unset", ""],
  ])("answers 404 when DD_ENV is %s", async (_label, ddEnv) => {
    vi.stubEnv("DD_ENV", ddEnv);

    const response = await POST(
      snapshotRequest(Buffer.from(JSON.stringify(snapshotBatch(NODE_UUID))))
    );

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["posthog's own UUIDv7 anonymous id", POSTHOG_DEFAULT_UUID_V7],
    ["a non-UUID", "not-a-uuid"],
  ])("refuses %s as distinct_id", async (_label, distinctId) => {
    const response = await POST(
      snapshotRequest(Buffer.from(JSON.stringify(snapshotBatch(distinctId))))
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(info).toHaveBeenCalledWith(DESKTOP_REPLAY_SNAPSHOT_REJECTED_EVENT, {
      reason: DesktopReplayRejection.InvalidBatch,
      maxBytes: DESKTOP_REPLAY_REQUEST_MAX_BYTES,
      declaredBytes: null,
      wireBytes: expect.any(Number),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a batch whose events name more than one distinct_id", async () => {
    const batch = snapshotBatch(NODE_UUID);
    batch[1].properties.distinct_id = OTHER_NODE_UUID;

    const response = await POST(
      snapshotRequest(Buffer.from(JSON.stringify(batch)))
    );

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["$identify", "$create_alias", "$pageview"])(
    "refuses a batch carrying %s",
    async (eventName) => {
      const batch = snapshotBatch(NODE_UUID);
      batch[1].event = eventName;

      const response = await POST(
        snapshotRequest(Buffer.from(JSON.stringify(batch)))
      );

      expect(response.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it("logs the declared size of an over-cap request before refusing it", async () => {
    const declaredBytes = DESKTOP_REPLAY_REQUEST_MAX_BYTES + 1;

    const response = await POST(
      snapshotRequest(Buffer.from("[]"), {
        contentLength: String(declaredBytes),
      })
    );

    expect(response.status).toBe(413);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(info).toHaveBeenCalledWith(DESKTOP_REPLAY_SNAPSHOT_REJECTED_EVENT, {
      reason: DesktopReplayRejection.OverCap,
      maxBytes: DESKTOP_REPLAY_REQUEST_MAX_BYTES,
      declaredBytes,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a body that decompresses past the ceiling as too large", async () => {
    const bomb = gzipSync(Buffer.alloc(DESKTOP_REPLAY_DECODED_MAX_BYTES + 1));

    const response = await POST(
      snapshotRequest(bomb, { compression: "gzip-js" })
    );

    expect(response.status).toBe(413);
    expect(info).toHaveBeenCalledWith(
      DESKTOP_REPLAY_SNAPSHOT_REJECTED_EVENT,
      expect.objectContaining({
        reason: DesktopReplayRejection.DecodedOverCap,
      })
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an install past its request budget, and only that install", async () => {
    const body = Buffer.from(JSON.stringify(snapshotBatch(NODE_UUID)));
    for (
      let i = 0;
      i < DESKTOP_REPLAY_INSTALL_MAX_REQUESTS_PER_WINDOW;
      i += 1
    ) {
      expect((await POST(snapshotRequest(body))).status).toBe(200);
    }

    const refused = await POST(snapshotRequest(body));
    const other = await POST(
      snapshotRequest(
        Buffer.from(JSON.stringify(snapshotBatch(OTHER_NODE_UUID)))
      )
    );

    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("60");
    expect(refused.headers.get("access-control-allow-origin")).toBe("*");
    expect(await refused.json()).toMatchObject({
      code: DesktopReplayRejection.OverBudget,
    });
    expect(other.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(
      DESKTOP_REPLAY_INSTALL_MAX_REQUESTS_PER_WINDOW + 1
    );
  });

  it("refuses an install past its byte budget, and only that install", async () => {
    const third = Math.floor(DESKTOP_REPLAY_INSTALL_MAX_BYTES_PER_WINDOW / 3);
    const body = paddedBody(NODE_UUID, third);
    expect(body.byteLength).toBe(third);

    for (let i = 0; i < 3; i += 1) {
      expect((await POST(snapshotRequest(body))).status).toBe(200);
    }
    const refused = await POST(snapshotRequest(body));
    const other = await POST(
      snapshotRequest(paddedBody(OTHER_NODE_UUID, third))
    );

    expect(refused.status).toBe(429);
    expect(info).toHaveBeenCalledWith(DESKTOP_REPLAY_SNAPSHOT_REJECTED_EVENT, {
      reason: DesktopReplayRejection.OverBudget,
      maxBytes: DESKTOP_REPLAY_REQUEST_MAX_BYTES,
      declaredBytes: null,
      wireBytes: body.byteLength,
    });
    expect(other.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each([400, 401, 413])(
    "answers 400 and logs the failure when PostHog refuses the batch with %i",
    async (upstreamStatus) => {
      fetchMock.mockResolvedValueOnce(
        new Response("", { status: upstreamStatus })
      );

      const response = await POST(
        snapshotRequest(Buffer.from(JSON.stringify(snapshotBatch(NODE_UUID))))
      );

      expect(response.status).toBe(400);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(await response.json()).toMatchObject({
        code: DesktopReplayForwardFailure.Refused,
      });
      expect(log.error).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    [
      "PostHog answers 500",
      () => fetchMock.mockResolvedValueOnce(new Response("", { status: 500 })),
      DesktopReplayForwardFailure.Refused,
    ],
    [
      "PostHog is unreachable",
      () => fetchMock.mockRejectedValueOnce(new TypeError("fetch failed")),
      DesktopReplayForwardFailure.Unreachable,
    ],
  ])("answers 502 when %s", async (_label, arrange, code) => {
    arrange();

    const response = await POST(
      snapshotRequest(Buffer.from(JSON.stringify(snapshotBatch(NODE_UUID))))
    );

    expect(response.status).toBe(502);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(await response.json()).toMatchObject({ code });
  });

  it("answers 503 and forwards nothing when the deployment has no PostHog token", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "");

    const response = await POST(
      snapshotRequest(Buffer.from(JSON.stringify(snapshotBatch(NODE_UUID))))
    );

    expect(response.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  describe("signed-in identity (ISS-12222)", () => {
    beforeEach(() => {
      vi.stubEnv(DESKTOP_SESSION_JWT_SECRET_ENV, JWT_SECRET);
      vi.mocked(usersService.findById).mockResolvedValue(signedInUser());
      vi.mocked(organizationsService.findById).mockResolvedValue({
        id: INTERNAL_ORG_ID,
        clerkId: CLERK_ORG_ID,
      });
    });

    it("forwards a signed-in install's batch under its Clerk user id", async () => {
      const accessToken = await desktopAccessToken();

      const response = await POST(
        snapshotRequest(Buffer.from(JSON.stringify(snapshotBatch(NODE_UUID))), {
          authorization: `Bearer ${accessToken}`,
        })
      );

      expect(response.status).toBe(200);
      expect(usersService.findById).toHaveBeenCalledWith(
        INTERNAL_USER_ID,
        INTERNAL_ORG_ID
      );
      expect(
        forwardedCall().batch.map((event) => event.properties.distinct_id)
      ).toEqual([CLERK_USER_ID, CLERK_USER_ID]);
    });

    it("never forwards the access token to PostHog", async () => {
      const accessToken = await desktopAccessToken();

      await POST(
        snapshotRequest(Buffer.from(JSON.stringify(snapshotBatch(NODE_UUID))), {
          authorization: `Bearer ${accessToken}`,
        })
      );

      const [, init] = fetchMock.mock.calls[0];
      const forwardedBody = gunzipSync(init.body as Uint8Array).toString(
        "utf8"
      );
      expect(forwardedBody).not.toContain(accessToken);
      expect(new Headers(init.headers).get("authorization")).toBeNull();
      expect(JSON.stringify(info.mock.calls)).not.toContain(accessToken);
    });

    it("keeps node_uuid for an install that sends no authentication, as older builds do", async () => {
      const response = await POST(
        snapshotRequest(Buffer.from(JSON.stringify(snapshotBatch(NODE_UUID))))
      );

      expect(response.status).toBe(200);
      expect(usersService.findById).not.toHaveBeenCalled();
      expect(
        forwardedCall().batch.map((event) => event.properties.distinct_id)
      ).toEqual([NODE_UUID, NODE_UUID]);
    });

    it.each([
      [
        "a token signed with another secret",
        () => desktopAccessToken({ secret: FORGER_JWT_SECRET }),
      ],
      [
        "an expired token",
        () =>
          desktopAccessToken({
            issuedAt: FIXED_NOW_SECONDS - 3600,
            expiresAt: FIXED_NOW_SECONDS - 60,
          }),
      ],
      ["an API key", () => Promise.resolve("sk_live_not_a_desktop_session")],
      ["a malformed bearer", () => Promise.resolve("not.a.jwt")],
    ])(
      "keeps node_uuid and accepts the batch for %s",
      async (_label, bearer) => {
        const token = await bearer();

        const response = await POST(
          snapshotRequest(
            Buffer.from(JSON.stringify(snapshotBatch(NODE_UUID))),
            { authorization: `Bearer ${token}` }
          )
        );

        expect(response.status).toBe(200);
        expect(usersService.findById).not.toHaveBeenCalled();
        expect(
          forwardedCall().batch.map((event) => event.properties.distinct_id)
        ).toEqual([NODE_UUID, NODE_UUID]);
      }
    );

    it.each([
      ["an inactive user", () => ({ ...signedInUser(), active: false })],
      ["a user no longer in the token's org", () => null],
    ])("keeps node_uuid for a verified token of %s", async (_label, user) => {
      vi.mocked(usersService.findById).mockResolvedValue(user());
      const accessToken = await desktopAccessToken();

      const response = await POST(
        snapshotRequest(Buffer.from(JSON.stringify(snapshotBatch(NODE_UUID))), {
          authorization: `Bearer ${accessToken}`,
        })
      );

      expect(response.status).toBe(200);
      expect(
        forwardedCall().batch.map((event) => event.properties.distinct_id)
      ).toEqual([NODE_UUID, NODE_UUID]);
    });

    it("keeps node_uuid and accepts the batch when the identity lookup fails", async () => {
      const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
      vi.mocked(usersService.findById).mockRejectedValue(
        new Error("connection terminated")
      );
      const accessToken = await desktopAccessToken();

      const response = await POST(
        snapshotRequest(Buffer.from(JSON.stringify(snapshotBatch(NODE_UUID))), {
          authorization: `Bearer ${accessToken}`,
        })
      );

      expect(response.status).toBe(200);
      expect(
        forwardedCall().batch.map((event) => event.properties.distinct_id)
      ).toEqual([NODE_UUID, NODE_UUID]);
      expect(warn).toHaveBeenCalledWith(
        DESKTOP_REPLAY_IDENTITY_UNRESOLVED_EVENT,
        expect.anything()
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain(accessToken);
    });

    it("charges the budget to the install's node_uuid, not to the signed-in user", async () => {
      const authorization = `Bearer ${await desktopAccessToken()}`;
      const body = Buffer.from(JSON.stringify(snapshotBatch(NODE_UUID)));
      for (
        let i = 0;
        i < DESKTOP_REPLAY_INSTALL_MAX_REQUESTS_PER_WINDOW;
        i += 1
      ) {
        expect(
          (await POST(snapshotRequest(body, { authorization }))).status
        ).toBe(200);
      }

      const refusedSignedIn = await POST(
        snapshotRequest(body, { authorization })
      );
      const refusedSignedOut = await POST(snapshotRequest(body));
      const sameUserOtherInstall = await POST(
        snapshotRequest(
          Buffer.from(JSON.stringify(snapshotBatch(OTHER_NODE_UUID))),
          { authorization }
        )
      );

      expect(refusedSignedIn.status).toBe(429);
      expect(refusedSignedOut.status).toBe(429);
      expect(sameUserOtherInstall.status).toBe(200);
    });
  });
});

/**
 * A desktop access token as `apps/api` mints one. `secret` signs it under a
 * key the deployment does not hold, which is a forgery to the verifier.
 */
async function desktopAccessToken(
  options: { secret?: string; issuedAt?: number; expiresAt?: number } = {}
): Promise<string> {
  if (options.secret) {
    vi.stubEnv(DESKTOP_SESSION_JWT_SECRET_ENV, options.secret);
  }
  const { token } = await issueDesktopAccessToken(
    {
      userId: INTERNAL_USER_ID,
      organizationId: INTERNAL_ORG_ID,
      sessionId: "desktop-session-1",
    },
    undefined,
    { issuedAt: options.issuedAt, expiresAt: options.expiresAt }
  );
  vi.stubEnv(DESKTOP_SESSION_JWT_SECRET_ENV, JWT_SECRET);
  return token;
}

function signedInUser() {
  return {
    id: INTERNAL_USER_ID,
    clerkId: CLERK_USER_ID,
    organizationId: INTERNAL_ORG_ID,
    email: "signed-in@example.test",
    firstName: null,
    lastName: null,
    avatarUrl: null,
    phoneNumber: null,
    role: ApproverRole.Engineer,
    linearId: null,
    slackId: null,
    githubUsername: null,
    active: true,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  };
}

type ForwardedEvent = {
  event: string;
  offset?: unknown;
  properties: Record<string, unknown>;
};

function forwardedCall(): {
  url: string;
  method: string | undefined;
  batch: ForwardedEvent[];
} {
  const [url, init] = fetchMock.mock.calls[0];
  return {
    url,
    method: init.method,
    batch: JSON.parse(
      gunzipSync(init.body as Uint8Array).toString("utf8")
    ) as ForwardedEvent[],
  };
}

function snapshotBatch(distinctId: string) {
  return [
    snapshotEvent(distinctId, [
      { type: 4, data: { href: "app://-/" }, timestamp: 1000 },
      { type: 2, data: { node: {} }, timestamp: 2000 },
    ]),
    snapshotEvent(distinctId, [{ type: 3, data: {}, timestamp: 61_000 }]),
  ];
}

function snapshotEvent(
  distinctId: string,
  snapshotData: { type: number; data: object; timestamp: number }[]
): {
  event: string;
  uuid: string;
  offset: number;
  properties: Record<string, unknown> & { distinct_id: string };
} {
  return {
    event: "$snapshot",
    uuid: SNAPSHOT_EVENT_UUID,
    offset: SNAPSHOT_EVENT_OFFSET_MS,
    properties: {
      distinct_id: distinctId,
      token: CLIENT_PLACEHOLDER_TOKEN,
      $session_id: SESSION_ID,
      $window_id: SESSION_ID,
      $snapshot_bytes: 100,
      $snapshot_data: snapshotData,
    },
  };
}

/** An uncompressed batch padded to `bytes` on the wire. */
function paddedBody(distinctId: string, bytes: number): Buffer {
  const batch = snapshotBatch(distinctId);
  batch[0].properties.padding = "";
  const unpadded = Buffer.byteLength(JSON.stringify(batch));
  batch[0].properties.padding = "x".repeat(bytes - unpadded);
  return Buffer.from(JSON.stringify(batch));
}

function snapshotRequest(
  body: Buffer,
  options: {
    compression?: string;
    contentLength?: string;
    authorization?: string;
  } = {}
): NextRequest {
  const url = new URL(`https://${PROD_HOST}/r/s`);
  if (options.compression) {
    url.searchParams.set("compression", options.compression);
  }
  const headers: Record<string, string> = { "content-type": "text/plain" };
  if (options.contentLength) {
    headers["content-length"] = options.contentLength;
  }
  if (options.authorization) {
    headers.authorization = options.authorization;
  }
  return new NextRequest(url, {
    method: "POST",
    body: new Uint8Array(body),
    headers,
  });
}
