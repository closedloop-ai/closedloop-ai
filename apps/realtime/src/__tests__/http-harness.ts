import { once } from "node:events";
import { createServer, type Server as HttpServer } from "node:http";
import { type AddressInfo, connect } from "node:net";
import {
  InternalOidcVerdict,
  type InternalOidcVerifier,
} from "@repo/http-service/internal-oidc";
import {
  OIDC_CONFIG,
  type OidcFixture,
} from "@repo/http-service/test-support/oidc-fixture";
import { RealtimeInternalPath } from "@repo/realtime-contract/internal";
import { type Mock, vi } from "vitest";
import { RevokeTargetField } from "../bus/apply";
import type { RealtimeBus } from "../bus/bus";
import { createRealtimeRequestListener } from "../http/app";
import {
  createInternalOidcVerifier,
  type InternalHandlerOptions,
} from "../http/internal";
import {
  createReadiness,
  Dependency,
  type Readiness,
} from "../lifecycle/readiness";
import {
  type InternalRequestRecord,
  recordInternalRequest,
} from "../telemetry/spans";
import { ORG_A } from "./edge-harness";

/** Refuses every bearer and every publish, for a test that never reaches either. */
const REFUSING_INTERNAL: InternalHandlerOptions = {
  verifyOidc: () =>
    Promise.resolve({
      verdict: InternalOidcVerdict.Rejected,
      reason: "harness",
    }),
  bus: { publish: () => Promise.reject(new Error("unexpected publish")) },
};

/** Realtime's HTTP request handling as production wires it, on an unstarted server. */
export function realtimeHttpServer(deps: {
  readiness: Readiness;
  internal?: Partial<InternalHandlerOptions>;
}): HttpServer {
  return createServer(
    createRealtimeRequestListener({
      readiness: deps.readiness,
      internal: { ...REFUSING_INTERNAL, ...deps.internal },
    })
  );
}

/** Listens on an ephemeral loopback port and resolves the base URL. */
export async function listenHttp(server: HttpServer): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export type RawResponse = {
  status: number;
  /** Lower-cased names. */
  headers: Record<string, string>;
  /** De-chunked. */
  body: string;
};

/**
 * Writes `requestText` byte for byte and reads until the server closes, so no
 * client normalizes the target, the method, the framing or the Host header.
 */
export function rawRequest(
  baseUrl: string,
  requestText: string
): Promise<RawResponse> {
  const { hostname, port } = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), hostname);
    let received = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      received += chunk;
    });
    socket.on("error", reject);
    socket.on("end", () => resolve(parseRawResponse(received)));
    socket.write(requestText);
  });
}

/** A raw HTTP/1.1 request with a content-length, closing after one answer. */
export function rawText(
  method: string,
  target: string,
  { headers = [] as string[], body = "" } = {}
): string {
  return [
    `${method} ${target} HTTP/1.1`,
    "Host: localhost",
    ...headers,
    `Content-Length: ${Buffer.byteLength(body)}`,
    "Connection: close",
    "",
    body,
  ].join("\r\n");
}

/** A raw `Transfer-Encoding: chunked` POST, one chunk per string. */
export function rawChunkedPost(
  target: string,
  headers: string[],
  chunks: string[]
): string {
  const body = chunks
    .map((chunk) => `${chunk.length.toString(16)}\r\n${chunk}\r\n`)
    .join("");
  return [
    `POST ${target} HTTP/1.1`,
    "Host: localhost",
    ...headers,
    "Transfer-Encoding: chunked",
    "Connection: close",
    "",
    `${body}0\r\n\r\n`,
  ].join("\r\n");
}

/** An answer reduced to what a parity row pins: status, body and the named headers. */
export type Framing = {
  status: number;
  body: string;
  headers: Record<string, string | undefined>;
};

export async function framing(
  response: Response | RawResponse,
  names: readonly string[]
): Promise<Framing> {
  if (response instanceof Response) {
    const body = await response.text();
    const headers = Object.fromEntries(
      names.map((name) => [name, response.headers.get(name) ?? undefined])
    );
    return { status: response.status, body, headers };
  }
  const headers = Object.fromEntries(
    names.map((name) => [name, response.headers[name]])
  );
  return { status: response.status, body: response.body, headers };
}

export const EMPTY_HEADERS = ["content-length", "cache-control"] as const;
export const JSON_HEADERS = [
  "content-type",
  "cache-control",
  "content-length",
] as const;

/** No body, `content-length: 0`, never cached; read with {@link EMPTY_HEADERS}. */
export function emptyNoStore(status: number): Framing {
  return {
    status,
    body: "",
    headers: { "content-length": "0", "cache-control": "no-store" },
  };
}

/** A compact JSON body, never cached; read with {@link JSON_HEADERS}. */
export function jsonAnswer(status: number, value: unknown): Framing {
  const body = JSON.stringify(value);
  return {
    status,
    body,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "content-length": String(Buffer.byteLength(body)),
    },
  };
}

/** Every record handed to the mocked `recordInternalRequest`, in order. */
export function recordedRequests(): InternalRequestRecord[] {
  return vi.mocked(recordInternalRequest).mock.calls.map(([record]) => record);
}

export type ParityServer = {
  baseUrl: string;
  readiness: Readiness;
  publish: Mock<RealtimeBus["publish"]>;
  /** The bucket's clock, in ms. */
  clock: { now: number };
  /** Swap `verify` to change how the next bearer is judged. */
  oidc: { verify: InternalOidcVerifier };
  close: () => Promise<void>;
};

/**
 * The parity suites' server: the fixture's real OIDC verifier, a bus that
 * accepts, a pinned bucket clock and a Bus-only readiness.
 */
export async function startParityServer(
  fixture: OidcFixture
): Promise<ParityServer> {
  const readiness = createReadiness([Dependency.Bus]);
  const publish = vi.fn<RealtimeBus["publish"]>(() => Promise.resolve());
  const clock = { now: 1_000_000 };
  const oidc = {
    verify: createInternalOidcVerifier(OIDC_CONFIG, {
      fetch: fixture.servingJwks(),
    }),
  };
  const server = realtimeHttpServer({
    readiness,
    internal: {
      verifyOidc: (token) => oidc.verify(token),
      bus: { publish },
      now: () => clock.now,
    },
  });
  const baseUrl = await listenHttp(server);
  return {
    baseUrl,
    readiness,
    publish,
    clock,
    oidc,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const PROBE_KIND = "probe";
const PROBE_TYPE = "probe.fired";
export const PUBLISH_BODY = {
  channel: `${PROBE_KIND}:${ORG_A}:x`,
  type: PROBE_TYPE,
  data: { id: "x1" },
};
export const REVOKE_BODY = { target: { orgId: ORG_A } };
/** A body each internal path accepts. */
export const VALID_BODY = {
  [RealtimeInternalPath.Publish]: PUBLISH_BODY,
  [RealtimeInternalPath.Revoke]: REVOKE_BODY,
};
/** What a {@link VALID_BODY} adds to its record, beyond path, status and auth. */
export const DESCRIBED = {
  [RealtimeInternalPath.Publish]: { kind: PROBE_KIND, type: PROBE_TYPE },
  [RealtimeInternalPath.Revoke]: { revokeTarget: RevokeTargetField.Org },
};

function parseRawResponse(text: string): RawResponse {
  const split = text.indexOf("\r\n\r\n");
  const [statusLine, ...headerLines] = text.slice(0, split).split("\r\n");
  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    const colon = line.indexOf(":");
    headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  const body = text.slice(split + 4);
  return {
    status: Number(statusLine.split(" ")[1]),
    headers,
    body: headers["transfer-encoding"] === "chunked" ? dechunk(body) : body,
  };
}

function dechunk(body: string): string {
  let rest = body;
  let out = "";
  for (;;) {
    const lineEnd = rest.indexOf("\r\n");
    const size = Number.parseInt(rest.slice(0, lineEnd), 16);
    if (!(size > 0)) {
      return out;
    }
    out += rest.slice(lineEnd + 2, lineEnd + 2 + size);
    rest = rest.slice(lineEnd + 2 + size + 2);
  }
}
