import {
  InternalOidcVerdict,
  type InternalOidcVerification,
} from "@repo/http-service/internal-oidc";
import {
  createOidcFixture,
  type OidcFixture,
} from "@repo/http-service/test-support/oidc-fixture";
import { log } from "@repo/observability/log";
import { RealtimeInternalPath } from "@repo/realtime-contract/internal";
import { REALTIME_SOCKET_PATH } from "@repo/realtime-contract/protocol";
import type { Socket as ClientSocket } from "socket.io-client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  HTTP_REQUEST_FAULT_EVENT,
  HTTP_REQUEST_FAULT_MESSAGE,
} from "../http/app";
import { HealthPath } from "../http/health";
import {
  INTERNAL_REQUEST_BURST,
  INTERNAL_REQUEST_FAULT_EVENT,
  MAX_INTERNAL_BODY_BYTES,
} from "../http/internal";
import { Dependency } from "../lifecycle/readiness";
import { recordInternalRequest } from "../telemetry/spans";
import {
  ORG_A,
  startComposedEdge,
  tokenFor,
  USER_A,
  welcomedClient,
} from "./edge-harness";
import {
  EMPTY_HEADERS,
  emptyNoStore,
  framing,
  JSON_HEADERS,
  jsonAnswer,
  type ParityServer,
  PUBLISH_BODY,
  REVOKE_BODY,
  rawRequest,
  rawText,
  realtimeHttpServer,
  recordedRequests,
  startParityServer,
} from "./http-harness";

/**
 * ISS-12589 (PLN-2204 Request Parity Contract), rows 1-5 and 16: health,
 * readiness, socket.io's path and every unknown path, then the headers the
 * Hono swap changes. Rows 6-15 are `http-parity-internal.test.ts`.
 */

vi.mock("../telemetry/spans", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../telemetry/spans")>()),
  recordInternalRequest: vi.fn(),
}));

const { Publish, Revoke } = RealtimeInternalPath;

let fixture: OidcFixture;
let bearer: string;
let parity: ParityServer;

beforeAll(async () => {
  fixture = await createOidcFixture();
  bearer = await fixture.mint();
});

beforeEach(async () => {
  vi.mocked(recordInternalRequest).mockClear();
  parity = await startParityServer(fixture);
});

afterEach(async () => {
  await parity.close();
  vi.restoreAllMocks();
});

function send(method: string, path: string): Promise<Response> {
  return fetch(parity.baseUrl + path, {
    method,
    headers: { authorization: `Bearer ${bearer}` },
  });
}

describe("row 1: /health answers any method", () => {
  it.each([
    ["GET", HealthPath.Health],
    ["POST", HealthPath.Health],
    ["DELETE", HealthPath.Health],
    ["GET", `${HealthPath.Health}?probe=1`],
  ])("%s %s answers 200 with the degraded flag", async (method, path) => {
    const response = await send(method, path);

    expect(await framing(response, JSON_HEADERS)).toEqual(
      jsonAnswer(200, { degraded: false })
    );
    expect(recordedRequests()).toEqual([]);
  });

  it("reports a lost dependency as degraded", async () => {
    parity.readiness.markUp(Dependency.Bus);
    parity.readiness.markDown(Dependency.Bus, "connection_closed");

    const response = await send("POST", HealthPath.Health);

    expect(await framing(response, JSON_HEADERS)).toEqual(
      jsonAnswer(200, { degraded: true })
    );
  });
});

describe("a fault on /health", () => {
  it("is an empty 500 logged as realtime's HTTP fault, never the internal-route fault", async () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    vi.spyOn(parity.readiness, "isDegraded").mockImplementation(() => {
      throw new Error("readiness broke");
    });

    const response = await send("GET", HealthPath.Health);

    expect(await framing(response, EMPTY_HEADERS)).toEqual(emptyNoStore(500));
    expect(error).toHaveBeenCalledWith(
      HTTP_REQUEST_FAULT_MESSAGE,
      expect.objectContaining({
        event: HTTP_REQUEST_FAULT_EVENT,
        path: HealthPath.Health,
      })
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain(
      INTERNAL_REQUEST_FAULT_EVENT
    );
  });
});

describe("row 2: HEAD /health", () => {
  it("answers 200 with no body and the JSON headers", async () => {
    const response = await send("HEAD", HealthPath.Health);

    expect(await framing(response, ["content-type", "cache-control"])).toEqual({
      status: 200,
      body: "",
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    });
  });
});

describe("row 3: /ready answers any method", () => {
  it.each(["GET", "POST"])(
    "%s answers 503 until readiness latches, then 200",
    async (method) => {
      const before = await send(method, HealthPath.Ready);
      parity.readiness.markUp(Dependency.Bus);
      const after = await send(method, HealthPath.Ready);

      expect(await framing(before, JSON_HEADERS)).toEqual(
        jsonAnswer(503, { ready: false })
      );
      expect(await framing(after, JSON_HEADERS)).toEqual(
        jsonAnswer(200, { ready: true })
      );
      expect(recordedRequests()).toEqual([]);
    }
  );
});

describe("row 4: socket.io keeps its path on the same server", () => {
  it("answers engine.io's polling refusal and admits a WebSocket client", async () => {
    const edge = await startComposedEdge(
      {},
      realtimeHttpServer({ readiness: parity.readiness })
    );
    const clients: ClientSocket[] = [];
    try {
      const polling = await fetch(
        `${edge.url}${REALTIME_SOCKET_PATH}/?EIO=4&transport=polling`
      );
      const welcomed = welcomedClient(
        edge.url,
        await tokenFor(ORG_A, USER_A),
        clients
      );

      expect(polling.status).toBe(400);
      expect(JSON.parse(await polling.text())).toMatchObject({ code: 0 });
      await expect(welcomed).resolves.toMatchObject({
        welcome: expect.any(Object),
      });
      expect(recordedRequests()).toEqual([]);
    } finally {
      for (const client of clients) {
        client.disconnect();
      }
      await edge.close();
    }
  });
});

describe("row 5: any other path is an empty 404, with or without a bearer", () => {
  const targets = [
    "/",
    "/internal/other",
    `${Publish}/`,
    `${Revoke}/`,
    `${HealthPath.Health}/`,
    `/${HealthPath.Health}`,
    `${HealthPath.Health}/..${Publish}`,
    "/internal/%70ublish",
    `http://x${Publish}`,
  ];

  it.each(
    targets.flatMap((target) => [
      [target, "no bearer"],
      [target, "a valid bearer"],
    ])
  )("POST %s with %s", async (target, credential) => {
    const headers =
      credential === "no bearer" ? [] : [`Authorization: Bearer ${bearer}`];

    const response = await rawRequest(
      parity.baseUrl,
      rawText("POST", target, { headers, body: JSON.stringify(PUBLISH_BODY) })
    );

    expect(await framing(response, ["content-length"])).toEqual({
      status: 404,
      body: "",
      headers: { "content-length": "0" },
    });
    expect(recordedRequests()).toEqual([]);
    expect(parity.publish).not.toHaveBeenCalled();
  });
});

describe("row 16: a request with no Host header", () => {
  it("GET /health over HTTP/1.0 answers 200", async () => {
    const response = await rawRequest(
      parity.baseUrl,
      `GET ${HealthPath.Health} HTTP/1.0\r\n\r\n`
    );

    expect(await framing(response, ["content-type", "cache-control"])).toEqual({
      status: 200,
      body: JSON.stringify({ degraded: false }),
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    });
  });
});

describe("headers @hono/node-server sets (Q-001)", () => {
  const TEXT_PLAIN = "text/plain; charset=UTF-8";

  function post(path: string, body: string): Promise<Response> {
    return fetch(parity.baseUrl + path, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}` },
      body,
    });
  }

  it("Q-001: row 5's 404 carries text/plain and no-store", async () => {
    const response = await send("POST", "/internal/other");

    expect(await framing(response, ["content-type", "cache-control"])).toEqual({
      status: 404,
      body: "",
      headers: { "content-type": TEXT_PLAIN, "cache-control": "no-store" },
    });
  });

  it.each([
    ["row 6", 405, () => send("GET", Publish)],
    [
      "row 9",
      503,
      () => {
        parity.oidc.verify = () =>
          Promise.resolve({ verdict: InternalOidcVerdict.Unavailable });
        return post(Publish, JSON.stringify(PUBLISH_BODY));
      },
    ],
    [
      "row 10",
      429,
      async () => {
        parity.oidc.verify = verified;
        for (let sent = 0; sent < INTERNAL_REQUEST_BURST; sent += 1) {
          await post(Revoke, JSON.stringify(REVOKE_BODY));
        }
        return post(Publish, JSON.stringify(PUBLISH_BODY));
      },
    ],
    [
      "row 11",
      400,
      () => post(Publish, " ".repeat(MAX_INTERNAL_BODY_BYTES + 1)),
    ],
    ["row 12", 400, () => post(Publish, "{")],
    [
      "row 13",
      503,
      () => {
        parity.publish.mockRejectedValueOnce(new Error("redis down"));
        return post(Publish, JSON.stringify(PUBLISH_BODY));
      },
    ],
    ["row 14", 202, () => post(Publish, JSON.stringify(PUBLISH_BODY))],
    [
      "row 15",
      500,
      () => {
        parity.oidc.verify = () => Promise.reject(new Error("boom"));
        return post(Publish, JSON.stringify(PUBLISH_BODY));
      },
    ],
  ] as const)(
    "Q-001: the empty %s answer (%i) carries text/plain",
    async (_row, status, request) => {
      vi.spyOn(log, "warn").mockImplementation(() => undefined);
      vi.spyOn(log, "error").mockImplementation(() => undefined);

      const response = await request();

      expect(await framing(response, ["content-type"])).toEqual({
        status,
        body: "",
        headers: { "content-type": TEXT_PLAIN },
      });
    }
  );

  it("Q-001: a malformed Host header answers an empty 400", async () => {
    const response = await rawRequest(
      parity.baseUrl,
      `GET ${HealthPath.Health} HTTP/1.1\r\nHost: bad host!\r\nConnection: close\r\n\r\n`
    );

    expect(await framing(response, ["content-length"])).toEqual({
      status: 400,
      body: "",
      headers: { "content-length": "0" },
    });
  });

  it("Q-001: a body with a leading BOM is parsed and published", async () => {
    const response = await post(Publish, `﻿${JSON.stringify(PUBLISH_BODY)}`);

    expect(response.status).toBe(202);
    expect(parity.publish).toHaveBeenCalledOnce();
  });

  it("row 6's HEAD 405 now carries content-length: 0 (PLN-2204 deviation)", async () => {
    const response = await send("HEAD", Publish);

    expect(await framing(response, ["content-length"])).toEqual({
      status: 405,
      body: "",
      headers: { "content-length": "0" },
    });
  });

  it("row 16's HTTP/1.0 answer now carries its content-length (PLN-2204 deviation)", async () => {
    const response = await rawRequest(
      parity.baseUrl,
      `GET ${HealthPath.Health} HTTP/1.0\r\n\r\n`
    );

    expect(await framing(response, JSON_HEADERS)).toEqual(
      jsonAnswer(200, { degraded: false })
    );
  });
});

function verified(): Promise<InternalOidcVerification> {
  return Promise.resolve({ verdict: InternalOidcVerdict.Verified });
}
