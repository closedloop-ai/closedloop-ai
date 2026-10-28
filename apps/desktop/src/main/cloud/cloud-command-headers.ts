/**
 * @file cloud-command-headers.ts
 * @description The header guards `CloudCommandExecutor` applies before a cloud
 * command becomes a loopback gateway request. Extracted from the executor
 * (ISS-8883), which is shrink-only grandfathered.
 *
 * Two DIFFERENT questions live here, and they must not be merged:
 *
 * - `isSafeHeaderValue` is the printable-ASCII gate for the desktop-minted
 *   `x-desktop-operation-id` header — an identifier, so refusing non-ASCII is
 *   invalid-input-only.
 * - `isByteStringHeaderValue` is the NO-THROW bound for caller-authored values
 *   (`approvalReason`, the command's own `headers`): what `fetch` will send —
 *   the ByteString range minus the C0 controls (HTAB excepted) and DEL.
 *   Measured on node 24 and mirrored exactly, because `approvalReason` is
 *   rendered prose the producer deliberately admits Latin-1 into (ISS-8880):
 *   a printable-ASCII gate here would drop `é` and a tab, which is valid input.
 *
 * A header NAME is judged on three counts, not just syntax: it must be an RFC
 * 9110 token, it must not be one undici refuses at send time, and it must not
 * be in the main-minted `x-desktop-` namespace.
 *
 * A dropped entry never fails the command — the gateway still receives the
 * request, and an absent `x-desktop-approval-reason` falls back to the
 * evaluator's generated reason (`approval-evaluator.ts`).
 */

import type { DesktopCommandEvent } from "./cloud-protocol.js";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Allow any non-empty printable ASCII string without CRLF (header injection guard). */
const SAFE_HEADER_VALUE_REGEX = /^[\x20-\x7e]+$/;

/** RFC 9110 `token` — the only characters a header NAME may carry. */
const HEADER_NAME_TOKEN_REGEX = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Header names that are valid tokens but that undici refuses when the request
 * is SENT, throwing before it is issued — the same command-killing failure a
 * bad value causes. Measured on node 24 against a loopback server; `connection`,
 * `host`, `content-length`, `te` and `trailer` are accepted and so are absent.
 */
const FETCH_REFUSED_HEADER_NAMES: ReadonlySet<string> = new Set([
  "expect",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
]);

/**
 * The namespace main mints for itself. A cloud peer that supplies one of these
 * is claiming desktop-side authority it does not have: `x-desktop-approval-
 * reason` is the sentence shown on the human's approval card, and
 * `x-desktop-operation-id` keys the risk tier. Main sets its own AFTER this
 * filter, but it also SKIPS a set (no reason, or one `fetch` cannot send), and
 * a caller entry left in place would then be the value that ships. Mirrors the
 * renderer transport's `STRIPPED_REQUEST_HEADERS`, whose comment names this
 * function as the rebuild.
 */
const MAIN_MINTED_HEADER_PREFIX = "x-desktop-";

const HTAB_CODE_POINT = 0x09;
const FIRST_PRINTABLE_CODE_POINT = 0x20;
const DEL_CODE_POINT = 0x7f;
const MAX_BYTESTRING_CODE_POINT = 0xff;

export function isValidUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}

export function isSafeHeaderValue(value: string): boolean {
  return SAFE_HEADER_VALUE_REGEX.test(value);
}

/**
 * What `fetch` will SEND as a header value, measured on node 24: the
 * ByteString range minus the C0 controls (HTAB excepted) and DEL. `Headers.set`
 * itself throws only on NUL, CR, LF and anything above U+00FF, but undici
 * refuses the remaining controls at send time (`UND_ERR_INVALID_ARG`), which
 * fails the command just the same, so the bound is the send-time one.
 * Leading/trailing whitespace is admitted because `Headers` trims it rather
 * than throwing, and the empty string because it is a legal value.
 */
export function isByteStringHeaderValue(value: string): boolean {
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (
      codePoint > MAX_BYTESTRING_CODE_POINT ||
      codePoint === DEL_CODE_POINT ||
      (codePoint < FIRST_PRINTABLE_CODE_POINT && codePoint !== HTAB_CODE_POINT)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * The entries of a cloud command's `headers` record that `new Headers` can
 * hold: a token name and a ByteString value. Anything else is dropped, never
 * thrown on — the socket parser copies every string key through unvalidated,
 * and one bad entry from a skewed peer must not fail the whole command.
 */
export function safeHeaderEntries(
  headers: Record<string, string> | undefined
): [string, string][] {
  if (!headers) {
    return [];
  }
  return Object.entries(headers).filter(
    ([name, value]) =>
      isSendableHeaderName(name) && isByteStringHeaderValue(value)
  );
}

export function isSendableHeaderName(name: string): boolean {
  if (!HEADER_NAME_TOKEN_REGEX.test(name)) {
    return false;
  }
  const lowered = name.toLowerCase();
  return !(
    FETCH_REFUSED_HEADER_NAMES.has(lowered) ||
    lowered.startsWith(MAIN_MINTED_HEADER_PREFIX)
  );
}

/**
 * The approval half of the outbound header set: the force flag, and the reason
 * only when `fetch` can send it. A reason it cannot send is DROPPED, never
 * thrown on — the command still reaches the gateway and the card falls back to
 * the evaluator's generated sentence. That fallback is invisible on the card,
 * so the drop is handed to `onDroppedReason` or nothing records that a real
 * reason existed. The reason is caller prose: its length is reported, never
 * its text.
 */
export function applyApprovalHeaders(
  headers: Headers,
  command: Pick<
    DesktopCommandEvent,
    "approvalReason" | "commandId" | "requiresApproval"
  >,
  onDroppedReason: (message: string) => void
): void {
  if (!command.requiresApproval) {
    return;
  }
  headers.set("x-desktop-force-approval", "1");
  if (!command.approvalReason) {
    return;
  }
  if (isByteStringHeaderValue(command.approvalReason)) {
    headers.set("x-desktop-approval-reason", command.approvalReason);
    return;
  }
  onDroppedReason(
    `Dropped unsendable x-desktop-approval-reason (${command.approvalReason.length} chars) on command ${command.commandId}; the approval card falls back to the generated reason`
  );
}
