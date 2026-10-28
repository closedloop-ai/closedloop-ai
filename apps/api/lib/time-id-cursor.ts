/**
 * An opaque `(timestamp, id)` keyset cursor: base64url of `${ms}:${id}`.
 *
 * Shared by the keyset reads that page on a millisecond timestamp plus a
 * tiebreaking id — the artifact activity feed and the component token trend.
 * The token is a position the SERVER mints and the client replays verbatim, so
 * decoding is a trust boundary: anything that does not round-trip decodes to
 * `null`, and each caller decides what `null` means for its own read.
 */

/** A decoded keyset position. */
export type TimeIdCursor = { ms: number; id: string };

/** The ECMAScript `Date` range, in milliseconds either side of the epoch. */
const MAX_DATE_MS = 8_640_000_000_000_000;

/**
 * Digits only. `Number("")` is `0` and `Number("1e3")` is `1000`, so without
 * this a `:id` token would decode to a real position at the epoch.
 */
const INTEGER_MS = /^-?\d+$/;

export function encodeTimeIdCursor(ms: number, id: string): string {
  return Buffer.from(`${ms}:${id}`, "utf8").toString("base64url");
}

/**
 * The position `cursor` names, or `null` when it is absent or malformed.
 * `isValidId` narrows the id for a read whose column has a shape (a uuid);
 * the default only requires a non-empty id.
 */
export function decodeTimeIdCursor(
  cursor: string | null | undefined,
  isValidId: (id: string) => boolean = isNonEmptyId
): TimeIdCursor | null {
  if (!cursor) {
    return null;
  }
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const sep = decoded.indexOf(":");
  if (sep === -1) {
    return null;
  }
  const msText = decoded.slice(0, sep);
  const ms = Number(msText);
  const id = decoded.slice(sep + 1);
  const isValidPosition =
    INTEGER_MS.test(msText) &&
    Number.isSafeInteger(ms) &&
    Math.abs(ms) <= MAX_DATE_MS &&
    isValidId(id);
  if (isValidPosition) {
    return { ms, id };
  }
  return null;
}

function isNonEmptyId(id: string): boolean {
  return id.length > 0;
}
