import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { log } from "@repo/observability/log";
import { Hono } from "hono";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import { internalBodyLimit } from "../body-limit";
import {
  emptyNotFound,
  emptyResponse,
  HttpServiceErrorCode,
  serviceErrorHandler,
} from "../errors";
import {
  createNodeRequestListener,
  type NodeBindings,
  rawRequestPath,
} from "../node-listener";

const FAULT_EVENT = "test.http_request_fault";
const PUBLISH = "/internal/publish";
const CAPPED = "/internal/capped";
const CAPPED_EMPTY_400 = "/internal/capped-empty-400";
const MAX_BYTES = 16;

let server: Server | undefined;
let port: number;
let publish: Mock<() => void>;
let settled: Promise<void>[];

function serviceApp() {
  const app = new Hono<{ Bindings: NodeBindings }>({ getPath: rawRequestPath });
  app.post(PUBLISH, (c) => {
    publish();
    return c.json({ ok: true });
  });
  app.post(CAPPED, internalBodyLimit({ maxBytes: MAX_BYTES }), async (c) =>
    c.json({ body: await c.req.text() })
  );
  app.post(
    CAPPED_EMPTY_400,
    internalBodyLimit({ maxBytes: MAX_BYTES, status: 400, code: null }),
    async (c) => c.json({ body: await c.req.text() })
  );
  app.get("/health", (c) => emptyResponse(c, 200));
  app.get("/throw", () => {
    throw new Error("boom");
  });
  app.notFound(emptyNotFound);
  app.onError(serviceErrorHandler("test.internal_fault", { code: null }));
  return app;
}

async function listen(app: Hono<{ Bindings: NodeBindings }>): Promise<void> {
  const listener = createNodeRequestListener(app, {
    faultEvent: FAULT_EVENT,
    hostname: "localhost",
  });
  server = createServer((incoming, outgoing) => {
    settled.push(listener(incoming, outgoing));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = (server.address() as AddressInfo).port;
}

type RawResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

/** Writes `request` byte for byte and reads the answer until the server closes. */
function raw(request: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let received = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      received += chunk;
    });
    socket.on("error", reject);
    socket.on("end", () => resolve(parseResponse(received)));
    socket.write(request);
  });
}

function parseResponse(text: string): RawResponse {
  const split = text.indexOf("\r\n\r\n");
  const [statusLine, ...headerLines] = text.slice(0, split).split("\r\n");
  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    const colon = line.indexOf(":");
    headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  return {
    status: Number(statusLine.split(" ")[1]),
    headers,
    body: text.slice(split + 4),
  };
}

const request = (method: string, target: string, version = "1.1") =>
  version === "1.0"
    ? `${method} ${target} HTTP/1.0\r\n\r\n`
    : `${method} ${target} HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`;

/** A `Transfer-Encoding: chunked` POST with no content-length, one chunk per string. */
function chunkedPost(target: string, chunks: string[]): string {
  const body = chunks
    .map((chunk) => `${chunk.length.toString(16)}\r\n${chunk}\r\n`)
    .join("");
  return `POST ${target} HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${body}0\r\n\r\n`;
}

beforeEach(() => {
  publish = vi.fn<() => void>();
  settled = [];
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (server) {
    server.close();
    await once(server, "close");
    server = undefined;
  }
});

describe("createNodeRequestListener with rawRequestPath", () => {
  it("routes the plain path to its handler", async () => {
    await listen(serviceApp());

    const response = await raw(request("POST", PUBLISH));

    expect(response.status).toBe(200);
    expect(publish).toHaveBeenCalledOnce();
  });

  it.each([
    ["a dot-dot segment", "/health/../internal/publish"],
    ["a percent-encoded segment", "/internal/%70ublish"],
    ["an absolute-form target", "http://evil/internal/publish"],
  ])(
    "answers %s an empty 404 without reaching the handler",
    async (_label, target) => {
      await listen(serviceApp());

      const response = await raw(request("POST", target));

      expect(response.status).toBe(404);
      expect(response.body).toBe("");
      expect(publish).not.toHaveBeenCalled();
    }
  );

  it("answers a request with no Host header through the route, not 400", async () => {
    await listen(serviceApp());

    const response = await raw(request("GET", "/health", "1.0"));

    expect(response.status).toBe(200);
  });

  it("sends an empty body with content-length 0, never chunked", async () => {
    await listen(serviceApp());

    const response = await raw(request("GET", "/health"));

    expect(response.headers["content-length"]).toBe("0");
    expect(response.headers["transfer-encoding"]).toBeUndefined();
    expect(response.body).toBe("");
  });

  it("resolves, logs the fault event and answers 500 when the fetch callback throws", async () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const app = serviceApp();
    app.onError((cause) => {
      throw cause;
    });
    await listen(app);

    const response = await raw(request("GET", "/throw"));

    await expect(Promise.all(settled)).resolves.toEqual([undefined]);
    expect(response).toMatchObject({ status: 500, body: "" });
    expect(error).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      expect.objectContaining({ event: FAULT_EVENT })
    );
  });
});

describe("createNodeRequestListener with internalBodyLimit", () => {
  it("passes a chunked body under the cap to a handler that reads it", async () => {
    await listen(serviceApp());

    const response = await raw(chunkedPost(CAPPED, ["01234", "56789"]));

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ body: "0123456789" });
  });

  it("refuses a chunked body over the cap 413 payload_too_large", async () => {
    await listen(serviceApp());

    const response = await raw(
      chunkedPost(CAPPED, ["x".repeat(MAX_BYTES), "x"])
    );

    expect(response.status).toBe(413);
    expect(JSON.parse(response.body)).toEqual({
      code: HttpServiceErrorCode.PayloadTooLarge,
    });
  });

  it("refuses a chunked body over the cap with the configured status and an empty body", async () => {
    await listen(serviceApp());

    const response = await raw(
      chunkedPost(CAPPED_EMPTY_400, ["x".repeat(MAX_BYTES), "x"])
    );

    expect(response).toMatchObject({ status: 400, body: "" });
  });
});

describe("rawRequestPath", () => {
  it("falls back to the URL's pathname with no Node binding", () => {
    expect(rawRequestPath(new Request("http://localhost/a/b?c=1"))).toBe(
      "/a/b"
    );
  });
});
