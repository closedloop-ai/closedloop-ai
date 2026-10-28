import { DESKTOP_HANDSHAKE_REQUEST_MAX_BYTES } from "@/app/desktop/route-helpers";

const STREAM_CHUNK_BYTES = 16_384;

export type CountedEndlessBody = {
  body: ReadableStream<Uint8Array>;
  bytesPulled: () => number;
  cancelled: () => boolean;
};

/**
 * A request body that keeps producing bytes until someone stops pulling, for
 * proving a route STREAMS under a cap rather than buffering. The safety ceiling
 * only exists so an UNBOUNDED reader terminates the test rather than hanging it.
 */
export function countedEndlessBody(
  capBytes: number = DESKTOP_HANDSHAKE_REQUEST_MAX_BYTES
): CountedEndlessBody {
  const safetyCeiling = capBytes * 4;
  const chunk = new Uint8Array(STREAM_CHUNK_BYTES).fill(97);
  let bytesPulled = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (bytesPulled >= safetyCeiling) {
        controller.close();
        return;
      }
      bytesPulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  return { body, bytesPulled: () => bytesPulled, cancelled: () => cancelled };
}

export function streamRequest(
  url: string,
  body: ReadableStream<Uint8Array>,
  headers: Record<string, string> = {}
): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
    // Required by Node's fetch for a streaming request body.
    duplex: "half",
  } as RequestInit);
}

/**
 * The most a bounded reader may pull before it cancels: the cap plus the
 * chunk(s) that crossed it.
 *
 * `chunksPastCap` is 1 for a route that starts reading immediately. A route
 * that awaits something first (e.g. `/desktop/authorize` resolves the Clerk
 * session before reading the body) gives the stream's pull loop another turn
 * before the reader consumes, so one further chunk is already queued.
 */
export function maxPullForHandshakeCap(chunksPastCap = 1): number {
  return maxPullForCap(DESKTOP_HANDSHAKE_REQUEST_MAX_BYTES, chunksPastCap);
}

export function maxPullForCap(capBytes: number, chunksPastCap = 1): number {
  return capBytes + STREAM_CHUNK_BYTES * chunksPastCap;
}

/**
 * A request body whose stream errors on the first pull, for proving a reader
 * PROPAGATES an aborted body rather than resolving it as an empty read. Pair it
 * with `streamRequest`, which carries the `duplex: "half"` Node requires.
 */
export function erroringBody(message: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new Error(message));
    },
  });
}

/**
 * A request body that emits `text` and then closes NORMALLY, for proving how a
 * reader classifies a stream that ends early without the transport raising an
 * abort — the early-EOF shape a declared `Content-Length` is the only witness to.
 */
export function closingBody(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}
