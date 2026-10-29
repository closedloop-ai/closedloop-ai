import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  GetObjectCommand,
  HeadBucketCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  boundedRequestHandler,
  CONTROL_PLANE_BOUNDS,
  MAX_EFFECTIVE_IDLE_TIMEOUT_MS,
  STREAMING_BOUNDS,
} from "./request-handler";

/**
 * ISS-7016 — the SDK's Node handler disables every timeout by default, so an
 * unbounded client hangs its caller forever.
 *
 * The trap this guards is that `requestTimeout` LOOKS like a bound and is not
 * one: without `throwOnRequestTimeout` the SDK logs a warning and lets the
 * request run on. So these assert the aborting behaviour against a real socket,
 * not just that some numbers were passed through.
 */

/** The SDK's own wording for both the connect and the socket-idle abort. */
const TIMEOUT_ERROR_MESSAGE = /timed out|did not establish a connection/i;

/** The SDK's wording for the total-elapsed ceiling specifically. */
const ELAPSED_CEILING_MESSAGE = /exceeded the configured \d+ ms requestTimeout/;

/** A server that accepts the connection and then never answers at all. */
let silentServer: Server;
let silentEndpoint: string;

/**
 * A server that answers with headers and one chunk, then stalls the body. This
 * is the case a deferred idle bound silently misses: the SDK resolves on the
 * headers and clears every pending timer, so only an idle listener that was
 * already armed can still abort the stalled stream.
 */
let stallingServer: Server;
let stallingEndpoint: string;

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function shutdown(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

beforeAll(async () => {
  silentServer = createServer(() => {
    // Deliberately never responds: the socket connects, then goes quiet.
  });
  stallingServer = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/octet-stream" });
    response.write("first-chunk");
    // Then stalls: never writes again, never ends.
  });
  silentEndpoint = await listen(silentServer);
  stallingEndpoint = await listen(stallingServer);
});

afterAll(async () => {
  await shutdown(silentServer);
  await shutdown(stallingServer);
});

describe("boundedRequestHandler", () => {
  it("aborts a request whose socket connects and then goes silent", async () => {
    const client = new S3Client({
      region: "us-east-1",
      endpoint: silentEndpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
      maxAttempts: 1,
      requestHandler: boundedRequestHandler({
        connectionTimeoutMs: 2000,
        idleTimeoutMs: 50,
      }),
    });

    // Without a socketTimeout this send never settles and the test times out.
    await expect(
      client.send(new HeadBucketCommand({ Bucket: "any-bucket" }))
    ).rejects.toThrow(TIMEOUT_ERROR_MESSAGE);

    client.destroy();
  });

  it("makes a total-elapsed ceiling abort rather than merely warn", async () => {
    // The ceiling is far tighter than the idle bound, and the SDK words the two
    // aborts differently — so asserting on the message proves it was the
    // elapsed ceiling that fired. Drop `throwOnRequestTimeout` and the SDK just
    // logs a warning, the idle bound ends the request instead, and the message
    // no longer matches.
    const client = new S3Client({
      region: "us-east-1",
      endpoint: silentEndpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
      maxAttempts: 1,
      requestHandler: boundedRequestHandler({
        connectionTimeoutMs: 2000,
        idleTimeoutMs: 5000,
        totalTimeoutMs: 50,
      }),
    });

    await expect(
      client.send(new HeadBucketCommand({ Bucket: "any-bucket" }))
    ).rejects.toThrow(ELAPSED_CEILING_MESSAGE);

    client.destroy();
  });

  it("refuses an idle bound the SDK would never arm", () => {
    // Enforced, not merely documented: the resulting client still looks
    // bounded, and only a stalled body would ever reveal that it is not.
    expect(() =>
      boundedRequestHandler({
        connectionTimeoutMs: 3000,
        idleTimeoutMs: MAX_EFFECTIVE_IDLE_TIMEOUT_MS,
      })
    ).toThrow(RangeError);

    expect(() =>
      boundedRequestHandler({ connectionTimeoutMs: 3000, idleTimeoutMs: 0 })
    ).toThrow(RangeError);
  });

  it("refuses a connect bound that leaves agent queueing unbounded", () => {
    // The idle timer cannot cover this gap: Node arms a socket's timeout only
    // once the agent hands one over, so a request queued behind a saturated
    // keep-alive agent is bounded by the connect timer or by nothing.
    expect(() =>
      boundedRequestHandler({ connectionTimeoutMs: 0, idleTimeoutMs: 5000 })
    ).toThrow(RangeError);

    expect(() =>
      boundedRequestHandler({ connectionTimeoutMs: -1, idleTimeoutMs: 5000 })
    ).toThrow(RangeError);
  });

  it("refuses an elapsed ceiling that reads as one but never fires", () => {
    // Smithy's timer is guarded by `if (timeoutInMs)`, so 0 produces
    // `{requestTimeout: 0, throwOnRequestTimeout: true}` — the exact shape of
    // an aborting ceiling, with no timer behind it.
    expect(() =>
      boundedRequestHandler({
        connectionTimeoutMs: 3000,
        idleTimeoutMs: 5000,
        totalTimeoutMs: 0,
      })
    ).toThrow(RangeError);

    expect(() =>
      boundedRequestHandler({
        connectionTimeoutMs: 3000,
        idleTimeoutMs: 5000,
        totalTimeoutMs: -1,
      })
    ).toThrow(RangeError);
  });

  it("omits the total-elapsed ceiling when the caller declares none", () => {
    const config = boundedRequestHandler({
      connectionTimeoutMs: 10_000,
      idleTimeoutMs: 5000,
    });

    expect(config.requestTimeout).toBeUndefined();
    expect(config.throwOnRequestTimeout).toBeUndefined();
    expect(config.socketTimeout).toBe(5000);
  });
});

describe("request bound presets", () => {
  it("gives every preset an idle bound the SDK actually arms", () => {
    for (const bounds of [CONTROL_PLANE_BOUNDS, STREAMING_BOUNDS]) {
      const config = boundedRequestHandler(bounds);
      expect(config.socketTimeout).toBeGreaterThan(0);
      expect(config.connectionTimeout).toBeGreaterThan(0);
      // At or above this the SDK defers registration by 3s and then cancels it
      // when the response headers arrive, leaving the body unbounded.
      expect(config.socketTimeout).toBeLessThan(MAX_EFFECTIVE_IDLE_TIMEOUT_MS);
    }
  });

  it(
    "aborts a streaming body that stalls after the response headers arrive",
    async () => {
      // Uses the shipped preset, not a convenient small number: raising
      // STREAMING_BOUNDS.idleTimeoutMs to the SDK's deferred-registration range
      // makes this hang rather than abort.
      const client = new S3Client({
        region: "us-east-1",
        endpoint: stallingEndpoint,
        forcePathStyle: true,
        credentials: { accessKeyId: "test", secretAccessKey: "test" },
        maxAttempts: 1,
        requestHandler: boundedRequestHandler(STREAMING_BOUNDS),
      });

      await expect(
        client
          .send(new GetObjectCommand({ Bucket: "any-bucket", Key: "any-key" }))
          .then((response) => response.Body?.transformToString())
      ).rejects.toThrow();

      client.destroy();
    },
    STREAMING_BOUNDS.idleTimeoutMs + 15_000
  );

  it("keeps three control-plane attempts inside a 60s request ceiling", () => {
    // The SDK retries 3 times by default, and the worst case for one attempt is
    // a hung connect followed by a request that runs out its total ceiling — so
    // the budget is the SUM of both, not either one alone.
    const config = boundedRequestHandler(CONTROL_PLANE_BOUNDS);
    const worstCaseAttemptMs =
      config.connectionTimeout + (config.requestTimeout ?? 0);

    expect(config.requestTimeout).toBeGreaterThan(0);
    expect(worstCaseAttemptMs * 3).toBeLessThan(60_000);
  });

  it("lets a healthy stream outlive any elapsed ceiling", () => {
    // A large S3 transfer legitimately runs long; only inactivity is evidence
    // of a stall, so the streaming preset must not carry a total ceiling.
    const config = boundedRequestHandler(STREAMING_BOUNDS);

    expect(config.requestTimeout).toBeUndefined();
    expect(config.socketTimeout).toBeGreaterThan(0);
  });
});
