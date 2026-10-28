import type { Server as HttpServer } from "node:http";
import type { InternalOidcVerifier } from "@repo/http-service/internal-oidc";
import {
  createOidcFixture,
  OIDC_CONFIG,
  type OidcFixture,
} from "@repo/http-service/test-support/oidc-fixture";
import { log } from "@repo/observability/log";
import { RealtimeErrorCode } from "@repo/realtime-contract/error-codes";
import { BusOp, RealtimeInternalPath } from "@repo/realtime-contract/internal";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import type { RealtimeBus } from "../bus/bus";
import { HealthPath } from "../http/health";
import {
  BUS_PUBLISH_FAILED_EVENT,
  createInternalOidcVerifier,
  INTERNAL_OIDC_JWKS_UNAVAILABLE_EVENT,
  INTERNAL_REQUEST_BURST,
  InternalAuth,
  MAX_INTERNAL_BODY_BYTES,
} from "../http/internal";
import { createReadiness, Dependency } from "../lifecycle/readiness";
import { recordInternalRequest } from "../telemetry/spans";
import { ORG_A } from "./edge-harness";
import { listenHttp, realtimeHttpServer } from "./http-harness";

vi.mock("../telemetry/spans", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../telemetry/spans")>()),
  recordInternalRequest: vi.fn(),
}));

/** The header and value apps/api sent before ISS-11966 retired the shared secret. */
const RETIRED_SECRET_HEADER = {
  "x-realtime-service-secret": "current-service-secret",
};
/** A kind and a signal type no code in the service names. */
const PROBE = `probe:${ORG_A}:x`;
const PROBE_TYPE = "probe.fired";

let server: HttpServer;
let baseUrl: string;
let publish: Mock<RealtimeBus["publish"]>;
let now: number;
let fixture: OidcFixture;
/** A valid bearer, minted once. */
let bearer: string;
/** Swapped per test; the handler calls through to it. */
let verifyOidc: InternalOidcVerifier;

beforeAll(async () => {
  fixture = await createOidcFixture();
  bearer = await fixture.mint();
});

beforeEach(async () => {
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
  publish = vi.fn<RealtimeBus["publish"]>(() => Promise.resolve());
  now = 1_000_000;
  verifyOidc = createInternalOidcVerifier(OIDC_CONFIG, {
    fetch: fixture.servingJwks(),
  });
  server = realtimeHttpServer({
    readiness: createReadiness([Dependency.Bus]),
    internal: {
      verifyOidc: (token) => verifyOidc(token),
      bus: { publish },
      now: () => now,
    },
  });
  baseUrl = await listenHttp(server);
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  vi.restoreAllMocks();
});

function post(
  path: string,
  body: unknown,
  /** Replaces the valid bearer. */
  credentials: Record<string, string> = { authorization: `Bearer ${bearer}` }
): Promise<Response> {
  return fetch(baseUrl + path, {
    method: "POST",
    headers: credentials,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const PUBLISH_BODY = { channel: PROBE, type: PROBE_TYPE, data: { id: "x1" } };

describe("POST /internal/publish and /internal/revoke", () => {
  it("accepts a publish to a kind the service has never seen, and relays it to the bus", async () => {
    const response = await post(RealtimeInternalPath.Publish, PUBLISH_BODY);

    expect(response.status).toBe(202);
    expect(publish).toHaveBeenCalledExactlyOnceWith({
      op: BusOp.Publish,
      ...PUBLISH_BODY,
    });
  });

  it("accepts a revoke and relays its target to the bus", async () => {
    const response = await post(RealtimeInternalPath.Revoke, {
      target: { orgId: ORG_A },
    });

    expect(response.status).toBe(202);
    expect(publish).toHaveBeenCalledExactlyOnceWith({
      op: BusOp.Revoke,
      target: { orgId: ORG_A },
    });
  });

  it.each([
    ["no credential", () => ({})],
    [
      "the retired shared-secret header (ISS-11966)",
      () => RETIRED_SECRET_HEADER,
    ],
    [
      "a bearer signed by a key the JWKS does not hold",
      async () => ({
        authorization: `Bearer ${await fixture.mint({}, fixture.otherKey)}`,
      }),
    ],
  ])("answers 401 to %s and publishes nothing", async (_name, credentials) => {
    const response = await post(
      RealtimeInternalPath.Publish,
      PUBLISH_BODY,
      await credentials()
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      code: RealtimeErrorCode.Unauthorized,
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid JSON", RealtimeInternalPath.Publish, "{"],
    [
      "a malformed channel",
      RealtimeInternalPath.Publish,
      { ...PUBLISH_BODY, channel: "probe:not-an-org:x" },
    ],
    [
      "a revoke naming two targets",
      RealtimeInternalPath.Revoke,
      { target: { orgId: ORG_A, channel: PROBE } },
    ],
  ])("answers 400 to %s and publishes nothing", async (_name, path, body) => {
    const response = await post(path, body);

    expect(response.status).toBe(400);
    expect(publish).not.toHaveBeenCalled();
  });

  it.each([
    [RealtimeInternalPath.Publish, PUBLISH_BODY],
    [RealtimeInternalPath.Revoke, { target: { orgId: ORG_A } }],
  ])(
    "on %s, accepts a body at the byte cap and answers 400 past it",
    async (path, body) => {
      const json = JSON.stringify(body);
      const atCap = json + " ".repeat(MAX_INTERNAL_BODY_BYTES - json.length);

      expect((await post(path, atCap)).status).toBe(202);
      expect((await post(path, `${atCap} `)).status).toBe(400);
      expect(publish).toHaveBeenCalledOnce();
    }
  );

  it("answers 405 to anything but POST", async () => {
    const response = await fetch(baseUrl + RealtimeInternalPath.Publish, {
      headers: { authorization: `Bearer ${bearer}` },
    });

    expect(response.status).toBe(405);
  });

  it("answers 429 once the instance-wide burst is spent, until it refills", async () => {
    for (let sent = 0; sent < INTERNAL_REQUEST_BURST; sent += 1) {
      expect(
        (await post(RealtimeInternalPath.Publish, PUBLISH_BODY)).status
      ).toBe(202);
    }

    expect(
      (await post(RealtimeInternalPath.Publish, PUBLISH_BODY)).status
    ).toBe(429);
    now += 1000;
    expect(
      (await post(RealtimeInternalPath.Publish, PUBLISH_BODY)).status
    ).toBe(202);
  });

  it("answers 503 when the bus does not take the message", async () => {
    publish.mockRejectedValueOnce(new Error("redis down"));

    const response = await post(RealtimeInternalPath.Publish, PUBLISH_BODY);

    expect(response.status).toBe(503);
    expect(log.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: BUS_PUBLISH_FAILED_EVENT })
    );
  });

  it("passes every other path through to the health handler", async () => {
    expect((await fetch(baseUrl + HealthPath.Health)).status).toBe(200);
    expect((await fetch(`${baseUrl}/internal/other`)).status).toBe(404);
  });
});

describe("the Vercel OIDC bearer (ISS-11966)", () => {
  it("accepts a valid bearer, and records it", async () => {
    const response = await post(RealtimeInternalPath.Publish, PUBLISH_BODY);

    expect(response.status).toBe(202);
    expect(publish).toHaveBeenCalledOnce();
    expect(vi.mocked(recordInternalRequest)).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 202, auth: InternalAuth.Oidc })
    );
  });

  it("answers 401 to a rejected bearer, and records which claim failed", async () => {
    const response = await post(RealtimeInternalPath.Publish, PUBLISH_BODY, {
      authorization: `Bearer ${await fixture.mint({ project_id: "prj_other" })}`,
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      code: RealtimeErrorCode.Unauthorized,
    });
    expect(publish).not.toHaveBeenCalled();
    expect(vi.mocked(recordInternalRequest)).toHaveBeenLastCalledWith({
      path: RealtimeInternalPath.Publish,
      status: 401,
      oidcRejection: "project_id",
    });
  });

  it("refuses the retired shared-secret header beside a rejected bearer (ISS-11966)", async () => {
    const response = await post(RealtimeInternalPath.Publish, PUBLISH_BODY, {
      ...RETIRED_SECRET_HEADER,
      authorization: `Bearer ${await fixture.mint({ environment: "development" })}`,
    });

    expect(response.status).toBe(401);
    expect(publish).not.toHaveBeenCalled();
    expect(vi.mocked(recordInternalRequest)).toHaveBeenLastCalledWith({
      path: RealtimeInternalPath.Publish,
      status: 401,
      oidcRejection: "environment",
    });
  });

  it("fails closed with 503 when the JWKS cannot be fetched", async () => {
    vi.spyOn(log, "error").mockImplementation(() => undefined);
    verifyOidc = createInternalOidcVerifier(OIDC_CONFIG, {
      fetch: () => Promise.reject(new TypeError("fetch failed")),
    });

    const response = await post(RealtimeInternalPath.Publish, PUBLISH_BODY);

    expect(response.status).toBe(503);
    expect(publish).not.toHaveBeenCalled();
  });

  it("never hands the bearer token to the logger", async () => {
    const calls = (["debug", "info", "warn", "error"] as const).map((level) =>
      vi.spyOn(log, level).mockImplementation(() => undefined)
    );
    verifyOidc = createInternalOidcVerifier(OIDC_CONFIG, {
      fetch: () => Promise.reject(new TypeError(`fetch failed ${bearer}`)),
    });

    await post(RealtimeInternalPath.Publish, PUBLISH_BODY);
    verifyOidc = createInternalOidcVerifier(OIDC_CONFIG, {
      fetch: fixture.servingJwks(),
    });
    publish.mockRejectedValueOnce(new Error(`redis down ${bearer}`));
    await post(RealtimeInternalPath.Publish, PUBLISH_BODY);

    expect(log.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: INTERNAL_OIDC_JWKS_UNAVAILABLE_EVENT })
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: BUS_PUBLISH_FAILED_EVENT })
    );
    const logged = JSON.stringify(calls.flatMap((spy) => spy.mock.calls));
    expect(logged).not.toContain(bearer);
  });
});
