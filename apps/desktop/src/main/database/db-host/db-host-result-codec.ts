/**
 * @file db-host-result-codec.ts
 * @description ISS-12022: a db-host result is serialized ONCE, on the store
 * thread, and crosses the dispatcher as bytes. Before this the dispatcher
 * decoded every reply into a full object graph only to re-encode it for main.
 * `v8.serialize` drives the same V8 value serializer `postMessage` does, so
 * plain data decodes in main as the structured clone delivered it. The one
 * difference is a Node `Buffer`, which decodes as a `Buffer` rather than a
 * `Uint8Array`; no store result returns one.
 */
import { deserialize, serialize } from "node:v8";
import {
  DbStoreResponseKind,
  type DbStoreResultResponse,
} from "./db-store-protocol.js";

/**
 * Above this many encoded bytes a result crosses the dispatcher → main hop one
 * page per pull, so neither process holds a second corpus-sized copy of it in
 * IPC buffers at once.
 */
export const DB_HOST_RESULT_PAGE_BYTES = 256 * 1024;

/**
 * The `ResultPagePull` offset main sends when it gives up on a paged result: no
 * page starts there, so the child ends that delivery and releases its lane.
 */
export const DB_HOST_RESULT_ABANDON_OFFSET = -1;

/** A store result the dispatcher forwards to main without decoding it. */
export class EncodedDbHostResult {
  readonly bytes: ArrayBuffer;

  constructor(bytes: ArrayBuffer) {
    this.bytes = bytes;
  }
}

/** Serialize a store result into a buffer the store thread can transfer. */
export function encodeDbHostResult(value: unknown): ArrayBuffer {
  const bytes = serialize(value);
  // `v8.serialize` returns a Buffer that owns an exact-size ArrayBuffer; copy
  // only if a runtime ever hands back a view into a larger one, because
  // transferring that would detach bytes this result does not own.
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes.buffer;
  }
  return new Uint8Array(bytes).buffer;
}

/** Decode what {@link encodeDbHostResult} produced. Throws on corrupt bytes. */
export function decodeDbHostResult(bytes: Uint8Array): unknown {
  return deserialize(bytes);
}

/** The page of `bytes` starting at `offset`, as its own transferable buffer. */
export function dbHostResultPage(
  bytes: ArrayBuffer,
  offset: number
): ArrayBuffer {
  return bytes.slice(offset, offset + DB_HOST_RESULT_PAGE_BYTES);
}

/**
 * The store thread's success post: serialize once and TRANSFER the bytes, so
 * the dispatcher receives them without a copy and never decodes them.
 */
export function postEncodedStoreResult(
  post: (message: DbStoreResultResponse, transfer: ArrayBuffer[]) => void,
  id: number,
  value: unknown
): void {
  const encoded = encodeDbHostResult(value);
  post({ kind: DbStoreResponseKind.Result, id, ok: true, encoded }, [encoded]);
}
