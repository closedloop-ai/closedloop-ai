/**
 * @file db-host-result-assembly.ts
 * @description ISS-12022 — main's half of moving a store result as bytes:
 * settle the pending request a `Result` answers, assembling a paged result
 * pull by pull and decoding it once, here, where the value is consumed.
 * Extracted so `db-host-client.ts` keeps the child lifecycle and does not grow.
 */
import { rebuildError } from "./db-host-error-rebuild.js";
import {
  DbHostResponseKind,
  type DbHostResultPageResponse,
  type DbHostResultResponse,
} from "./db-host-protocol.js";
import {
  DB_HOST_RESULT_ABANDON_OFFSET,
  decodeDbHostResult,
} from "./db-host-result-codec.js";

/** A request correlated by `id`, awaiting the child's reply. */
export type DbHostPending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  /** ISS-12022: a paged result's buffer, filled as its pages arrive. */
  partial?: { bytes: Uint8Array; received: number };
};

const INCOMPLETE = Symbol("incomplete");

/**
 * Settle the request `message` answers, or pull the next page of it.
 *
 * A page that does not fit what main holds REJECTS the request rather than
 * waiting: the child serves pages strictly in order, so a mismatch means the
 * rest is not coming.
 */
export function settleDbHostResult(
  message: DbHostResultResponse | DbHostResultPageResponse,
  pending: Map<number, DbHostPending>,
  pull: (id: number, offset: number) => void
): void {
  const entry = pending.get(message.id);
  if (!entry) {
    return;
  }
  if (message.kind === DbHostResponseKind.Result && !message.ok) {
    pending.delete(message.id);
    entry.reject(rebuildError(message));
    return;
  }
  if (
    message.kind === DbHostResponseKind.Result &&
    message.encoded === undefined
  ) {
    pending.delete(message.id);
    entry.resolve(message.value);
    return;
  }
  const assembled = appendPage(entry, message);
  if (assembled === INCOMPLETE && entry.partial) {
    pull(message.id, entry.partial.received);
    return;
  }
  pending.delete(message.id);
  if (!(assembled instanceof Uint8Array)) {
    if (
      message.kind === DbHostResponseKind.ResultPage ||
      message.encodedByteLength !== undefined
    ) {
      // A pull the child cannot serve ends its paged delivery now, so the lane
      // permit it holds is released instead of waiting out the idle deadline.
      pull(message.id, DB_HOST_RESULT_ABANDON_OFFSET);
    }
    entry.reject(new Error(`db-host result ${message.id} arrived malformed`));
    return;
  }
  let value: unknown;
  try {
    value = decodeDbHostResult(assembled);
  } catch (error) {
    entry.reject(error instanceof Error ? error : new Error(String(error)));
    return;
  }
  entry.resolve(value);
}

/** The complete bytes, {@link INCOMPLETE}, or `null` for a page that cannot fit. */
function appendPage(
  entry: DbHostPending,
  message: DbHostResultResponse | DbHostResultPageResponse
): Uint8Array | typeof INCOMPLETE | null {
  const page = asBytes(message.encoded);
  if (!page) {
    return null;
  }
  if (message.kind === DbHostResponseKind.Result) {
    const total = message.encodedByteLength ?? page.byteLength;
    if (!Number.isSafeInteger(total) || total < page.byteLength) {
      return null;
    }
    if (total === page.byteLength) {
      return page;
    }
    try {
      entry.partial = { bytes: new Uint8Array(total), received: 0 };
    } catch {
      // An impossible length rejects this request, not main's message handler.
      return null;
    }
  }
  const partial = entry.partial;
  const offset =
    message.kind === DbHostResponseKind.ResultPage ? message.offset : 0;
  if (
    !partial ||
    page.byteLength === 0 ||
    offset !== partial.received ||
    offset + page.byteLength > partial.bytes.byteLength
  ) {
    return null;
  }
  partial.bytes.set(page, offset);
  partial.received += page.byteLength;
  return partial.received === partial.bytes.byteLength
    ? partial.bytes
    : INCOMPLETE;
}

/** The bytes a page carries; a cross-process clone may hand back a view. */
function asBytes(value: unknown): Uint8Array | null {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}
