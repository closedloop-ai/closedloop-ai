import { describeCause } from "@repo/http-service/describe-cause";
import { InternalOidcVerdict } from "@repo/http-service/internal-oidc";
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
  vi,
} from "vitest";
import {
  HTTP_REQUEST_FAULT_EVENT,
  HTTP_REQUEST_FAULT_MESSAGE,
} from "../http/app";
import {
  BUS_PUBLISH_FAILED_EVENT,
  createInternalOidcVerifier,
  INTERNAL_REQUEST_BURST,
  INTERNAL_REQUEST_FAULT_EVENT,
  INTERNAL_REQUEST_FAULT_MESSAGE,
  InternalAuth,
  MAX_INTERNAL_BODY_BYTES,
} from "../http/internal";
import { recordInternalRequest } from "../telemetry/spans";
import {
  DESCRIBED,
  EMPTY_HEADERS,
  emptyNoStore,
  framing,
  JSON_HEADERS,
  jsonAnswer,
  type ParityServer,
  PUBLISH_BODY,
  REVOKE_BODY,
  rawChunkedPost,
  rawRequest,
  rawText,
  recordedRequests,
  startParityServer,
  VALID_BODY,
} from "./http-harness";

/**
 * ISS-12589 (PLN-2204 Request Parity Contract), rows 6-15: `POST
 * /internal/publish` and `POST /internal/revoke`, refused in the order
 * method, bearer, rate, cap, body, bus.
 */

vi.mock("../telemetry/spans", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../telemetry/spans")>()),
  recordInternalRequest: vi.fn(),
}));

const { Publish, Revoke } = RealtimeInternalPath;
const UNAUTHORIZED = { code: RealtimeErrorCode.Unauthorized };

let fixture: OidcFixture;
let bearer: string;
let parity: ParityServer;

beforeAll(async () => {
  fixture = await createOidcFixture();
  bearer = await fixture.mint();
});

beforeEach(async () => {
  vi.mocked(recordInternalRequest).mockClear();
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
  vi.spyOn(log, "error").mockImplementation(() => undefined);
  parity = await startParityServer(fixture);
});

afterEach(async () => {
  await parity.close();
  vi.restoreAllMocks();
});

function send(
  method: string,
  path: string,
  {
    body,
    headers = { authorization: `Bearer ${bearer}` },
  }: { body?: unknown; headers?: Record<string, string> } = {}
): Promise<Response> {
  return fetch(parity.baseUrl + path, {
    method,
    headers,
    body:
      body === undefined || typeof body === "string"
        ? body
        : JSON.stringify(body),
  });
}

/** A valid body padded with whitespace to one byte past the cap. */
function oversized(body: unknown): string {
  const json = JSON.stringify(body);
  return json + " ".repeat(MAX_INTERNAL_BODY_BYTES - json.length + 1);
}

describe.each([Publish, Revoke])("on %s", (path) => {
  const valid = { body: VALID_BODY[path] };
  const oidc = { path, auth: InternalAuth.Oidc };

  describe("row 6: anything but POST is a 405, checked before auth", () => {
    it.each(["GET", "DELETE", "OPTIONS"])(
      "%s with a valid bearer",
      async (method) => {
        const response = await send(method, path);

        expect(await framing(response, EMPTY_HEADERS)).toEqual(
          emptyNoStore(405)
        );
        expect(recordedRequests()).toEqual([{ path, status: 405 }]);
      }
    );

    it("HEAD with a valid bearer", async () => {
      const response = await send("HEAD", path);

      expect(await framing(response, ["cache-control"])).toEqual({
        status: 405,
        body: "",
        headers: { "cache-control": "no-store" },
      });
      expect(recordedRequests()).toEqual([{ path, status: 405 }]);
    });

    it("PUT with no bearer", async () => {
      const response = await rawRequest(parity.baseUrl, rawText("PUT", path));

      expect(await framing(response, EMPTY_HEADERS)).toEqual(emptyNoStore(405));
      expect(recordedRequests()).toEqual([{ path, status: 405 }]);
    });
  });

  describe("row 7: no usable bearer is a 401", () => {
    it.each([
      ["no authorization", {}],
      ["a non-bearer scheme", { authorization: "Basic dXNlcjpwYXNz" }],
      ["a bearer with no token", { authorization: "Bearer" }],
      [
        "only the retired shared-secret header",
        { "x-realtime-service-secret": "current-service-secret" },
      ],
    ])("%s", async (_label, headers) => {
      const response = await send("POST", path, { ...valid, headers });

      expect(await framing(response, JSON_HEADERS)).toEqual(
        jsonAnswer(401, UNAUTHORIZED)
      );
      expect(recordedRequests()).toEqual([{ path, status: 401 }]);
      expect(parity.publish).not.toHaveBeenCalled();
    });
  });

  it.each(["project_id", "environment"])(
    "row 8: a bearer rejected on %s is a 401 that records the claim",
    async (claim) => {
      const rejected = await fixture.mint({ [claim]: "other" });

      const response = await send("POST", path, {
        ...valid,
        headers: { authorization: `Bearer ${rejected}` },
      });

      expect(await framing(response, JSON_HEADERS)).toEqual(
        jsonAnswer(401, UNAUTHORIZED)
      );
      expect(recordedRequests()).toEqual([
        { path, status: 401, oidcRejection: claim },
      ]);
    }
  );

  it("row 9: an unreachable JWKS fails closed with an empty 503", async () => {
    parity.oidc.verify = createInternalOidcVerifier(OIDC_CONFIG, {
      fetch: () => Promise.reject(new TypeError("fetch failed")),
    });

    const response = await send("POST", path, valid);

    expect(await framing(response, EMPTY_HEADERS)).toEqual(emptyNoStore(503));
    expect(recordedRequests()).toEqual([{ path, status: 503 }]);
    expect(parity.publish).not.toHaveBeenCalled();
  });

  describe("row 11: a body past the cap is an empty 400", () => {
    it("with a content-length", async () => {
      const response = await send("POST", path, {
        body: oversized(VALID_BODY[path]),
      });

      expect(await framing(response, EMPTY_HEADERS)).toEqual(emptyNoStore(400));
      expect(recordedRequests()).toEqual([{ ...oidc, status: 400 }]);
      expect(parity.publish).not.toHaveBeenCalled();
    });

    it("chunked", async () => {
      const body = oversized(VALID_BODY[path]);
      const half = Math.floor(body.length / 2);

      const response = await rawRequest(
        parity.baseUrl,
        rawChunkedPost(
          path,
          [`Authorization: Bearer ${bearer}`, "Content-Type: application/json"],
          [body.slice(0, half), body.slice(half)]
        )
      );

      expect(await framing(response, EMPTY_HEADERS)).toEqual(emptyNoStore(400));
      expect(recordedRequests()).toEqual([{ ...oidc, status: 400 }]);
      expect(parity.publish).not.toHaveBeenCalled();
    });
  });

  describe("row 12: a body that is not the path's JSON is an empty 400", () => {
    it.each([
      ["an empty body", ""],
      ["invalid JSON", "{"],
      ["a body the schema refuses", { unexpected: true }],
    ])("%s", async (_label, body) => {
      const response = await send("POST", path, { body });

      expect(await framing(response, EMPTY_HEADERS)).toEqual(emptyNoStore(400));
      expect(recordedRequests()).toEqual([{ ...oidc, status: 400 }]);
      expect(parity.publish).not.toHaveBeenCalled();
    });

    it("parses the body as JSON whatever its content-type", async () => {
      const response = await send("POST", path, {
        ...valid,
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-type": "application/x-www-form-urlencoded",
        },
      });

      expect(await framing(response, EMPTY_HEADERS)).toEqual(emptyNoStore(202));
      expect(parity.publish).toHaveBeenCalledOnce();
    });
  });

  it("row 13: a bus that refuses the message is an empty 503 and a warning", async () => {
    const error = new Error("redis down");
    parity.publish.mockRejectedValueOnce(error);

    const response = await send("POST", path, valid);

    expect(await framing(response, EMPTY_HEADERS)).toEqual(emptyNoStore(503));
    expect(recordedRequests()).toEqual([
      { ...oidc, status: 503, ...DESCRIBED[path] },
    ]);
    expect(log.warn).toHaveBeenCalledWith("Realtime bus publish failed", {
      event: BUS_PUBLISH_FAILED_EVENT,
      path,
      cause: describeCause(error),
    });
  });

  it("row 14: a published message is an empty 202", async () => {
    const response = await send("POST", path, valid);

    expect(await framing(response, EMPTY_HEADERS)).toEqual(emptyNoStore(202));
    expect(recordedRequests()).toEqual([
      { ...oidc, status: 202, ...DESCRIBED[path] },
    ]);
    expect(parity.publish).toHaveBeenCalledExactlyOnceWith(
      path === Publish
        ? { op: BusOp.Publish, ...PUBLISH_BODY }
        : { op: BusOp.Revoke, ...REVOKE_BODY }
    );
  });

  it("row 15: a verifier that throws is an empty 500, logged as the fault event", async () => {
    const error = new Error("boom");
    parity.oidc.verify = () => Promise.reject(error);

    const response = await send("POST", path, valid);

    expect(await framing(response, EMPTY_HEADERS)).toEqual(emptyNoStore(500));
    expect(recordedRequests()).toEqual([{ path, status: 500 }]);
    expect(log.error).toHaveBeenCalledWith("Realtime internal request failed", {
      event: INTERNAL_REQUEST_FAULT_EVENT,
      path,
      cause: describeCause(error),
    });
  });

  it("row 15: a fault after authentication is recorded with its path and status alone", async () => {
    const error = new Error("clock broke");
    Object.defineProperty(parity.clock, "now", {
      get: () => {
        throw error;
      },
    });

    const response = await send("POST", path, valid);

    expect(await framing(response, EMPTY_HEADERS)).toEqual(emptyNoStore(500));
    expect(recordedRequests()).toEqual([{ path, status: 500 }]);
    expect(log.error).toHaveBeenCalledWith("Realtime internal request failed", {
      event: INTERNAL_REQUEST_FAULT_EVENT,
      path,
      cause: describeCause(error),
    });
  });
});

describe("a fault the app's error handler cannot answer", () => {
  it("is an empty 500, logged as realtime's HTTP fault event", async () => {
    const handlerFault = new Error("log sink down");
    vi.mocked(log.error).mockImplementation((message) => {
      if (
        message === INTERNAL_REQUEST_FAULT_MESSAGE ||
        message === HTTP_REQUEST_FAULT_MESSAGE
      ) {
        throw handlerFault;
      }
    });
    parity.oidc.verify = () => Promise.reject(new Error("boom"));

    const response = await send("POST", Publish, { body: PUBLISH_BODY });

    expect(await framing(response, EMPTY_HEADERS)).toEqual(emptyNoStore(500));
    expect(log.error).toHaveBeenLastCalledWith("Internal HTTP request fault", {
      event: HTTP_REQUEST_FAULT_EVENT,
      cause: describeCause(handlerFault),
    });
  });
});

describe("row 10: one instance-wide bucket, checked before the body is read", () => {
  it("a revoke drains the publish bucket, and the refusal reads no body", async () => {
    parity.oidc.verify = () =>
      Promise.resolve({ verdict: InternalOidcVerdict.Verified });
    for (let sent = 0; sent < INTERNAL_REQUEST_BURST; sent += 1) {
      await send("POST", Revoke, { body: REVOKE_BODY });
    }
    vi.mocked(recordInternalRequest).mockClear();

    const response = await send("POST", Publish, { body: "{" });

    expect(await framing(response, EMPTY_HEADERS)).toEqual(emptyNoStore(429));
    expect(recordedRequests()).toEqual([
      { path: Publish, status: 429, auth: InternalAuth.Oidc },
    ]);
    expect(parity.publish).toHaveBeenCalledTimes(INTERNAL_REQUEST_BURST);
  });
});
