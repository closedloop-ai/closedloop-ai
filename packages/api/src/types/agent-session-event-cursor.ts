import { fromBase64Url, toBase64Url } from "./base64url.ts";

/**
 * ISS-9857: the keyset position an events page ends on — the last served
 * event's `createdAt` and `externalEventId`, the two keys both producers order
 * by. Carried as the served `createdAt` STRING rather than epoch ms on purpose:
 * the cloud compares it as a `timestamp(3)` and the desktop as the raw
 * `created_at` text its SQL orders by, so each producer decodes into its own
 * comparison domain and neither has to agree on a millisecond representation.
 *
 * The client mints only the FIRST cursor itself, from the detail prefix's last
 * event (a value a producer served); every later cursor is replayed from a
 * page's `nextCursor`. Decoding is a trust boundary regardless: anything that
 * does not round-trip decodes to `null`, and each producer decides what `null`
 * means for its read (the cloud answers 400, the desktop fails closed).
 */
export type SessionEventCursor = {
  createdAt: string;
  externalEventId: string;
};

const CURSOR_PART_SEPARATOR = ":";

/**
 * `null` when either part is missing or empty: the desktop's `created_at` is
 * nullable at runtime though typed `string` (an event row with no timestamp
 * reaches the detail verbatim), and a cursor minted from a blank timestamp
 * would page from the wrong place. A caller that gets `null` offers no
 * continuation rather than a wrong one — and a caller that mints eagerly, on
 * every session, must not throw on the `null` the type does not admit.
 */
export function encodeSessionEventCursor(
  position: SessionEventCursor
): string | null {
  const complete =
    isNonEmptyString(position.createdAt) &&
    isNonEmptyString(position.externalEventId);
  if (!complete) {
    return null;
  }
  // `encodeURIComponent` keeps both parts ASCII (btoa's domain) and reserves
  // the separator, so an id carrying a ":" still splits at the right place.
  return toBase64Url(
    `${encodeURIComponent(position.createdAt)}${CURSOR_PART_SEPARATOR}${encodeURIComponent(position.externalEventId)}`
  );
}

export function decodeSessionEventCursor(
  cursor: string | null | undefined
): SessionEventCursor | null {
  if (!cursor) {
    return null;
  }
  const decoded = fromBase64Url(cursor);
  if (decoded === null) {
    return null;
  }
  const separator = decoded.indexOf(CURSOR_PART_SEPARATOR);
  if (separator === -1) {
    return null;
  }
  try {
    const createdAt = decodeURIComponent(decoded.slice(0, separator));
    const externalEventId = decodeURIComponent(decoded.slice(separator + 1));
    if (createdAt.length === 0 || externalEventId.length === 0) {
      return null;
    }
    return { createdAt, externalEventId };
  } catch {
    return null;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
