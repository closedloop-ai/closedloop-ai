import "server-only";
import type { LookupAllOptions, LookupOptions } from "node:dns";
import { lookup as dnsLookup } from "node:dns";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { Agent, request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { log } from "@repo/observability/log";
import { isInternalHost, unbracketIpv6Host } from "./credential";

/**
 * Pinned-IP egress for credentialed fetches to a TENANT-SUPPLIED host (ISS-9690).
 *
 * ## What was open
 *
 * `isSecureHttpsUrl` refuses an internal target by inspecting the LITERAL host
 * string, and says so in its own docstring: it never resolves DNS. A public
 * hostname whose A record points at `10.0.1.5`, `127.0.0.1` or
 * `169.254.169.254` therefore passed write-time validation, and the daily
 * multi-tenant sweep then fetched it with that organization's Pensero
 * credential attached. `redirect: "error"` did not help — it refuses a
 * REDIRECT, not a direct DNS answer pointing inward.
 *
 * ## Why resolve-then-validate would NOT have closed it
 *
 * Resolving the name, checking the answer, and then handing the NAME to an HTTP
 * client is TOCTOU-vulnerable by construction: the client resolves a second
 * time and a rebinding attacker controls that second answer. The guard reports
 * safe while the attack it names still works.
 *
 * What this module does instead is pin the egress. {@link pinnedLookup} is the
 * `lookup` function the agent's socket is created with, so the resolution that
 * is VALIDATED is the same resolution that is DIALLED — there is one lookup and
 * no window between the check and the connect. TLS still negotiates against the
 * original hostname, so certificate validation is unchanged.
 *
 * ## Fail closed
 *
 * An unresolvable host, a host that resolves to nothing, and a host with ANY
 * internal address among its answers are all refused. Not "the first answer" —
 * a round-robin record set that mixes a public address with an internal one is
 * exactly the shape an attacker submits, so one internal answer blocks the
 * whole host.
 *
 * ## The literal-host checks are NOT replaced
 *
 * `isSecureHttpsUrl` still runs at the settings-route write boundary. Refusing
 * `https://127.0.0.1/api` before it is ever stored is a better failure than
 * accepting it and blocking it nightly, and the two checks share one range
 * predicate ({@link isInternalHost}) so they cannot disagree about what
 * "internal" means.
 *
 * ## Scope: tenant-supplied bases only
 *
 * This transport is selected by the delivery client for an ORG-configured base
 * URL. An operator-set `PENSERO_API_BASE_URL` keeps reaching a private address,
 * which is the same position `isSecureOrLoopbackHttpUrl` already takes: the
 * capability is not removed, it stays where the operator — not a tenant —
 * controls it. A self-hosted deployment pointing at its own Pensero is
 * unaffected.
 *
 * ## Deployment
 *
 * Node runtime only. The cron route that drives the credentialed fetch reads
 * the database and KMS, so it is already a Node serverless function rather than
 * an Edge one; `node:https` and a custom socket `lookup` are available there.
 */

/** Standard https port, used when the base URL names none. */
const DEFAULT_HTTPS_PORT = 443;

/**
 * The statuses that ask a client to re-issue the request somewhere else.
 *
 * 304 is deliberately absent: it is a cache validator, not a redirect, and
 * treating it as one would turn a conditional-request answer into a hard error.
 */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Statuses whose response is defined to carry no body.
 *
 * 101 and 103 are absent because they cannot arrive here: an informational
 * status is refused by {@link isRepresentableStatus} before this set is
 * consulted, and Node routes 1xx to `information`/`upgrade` rather than to the
 * response callback in the first place.
 */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/**
 * The status range the `Response` constructor accepts. Node's HTTP parser does
 * NOT share it — llhttp reads any three-digit status, so a tenant-chosen
 * endpoint answering `HTTP/1.1 600` yields `statusCode === 600`.
 */
const MIN_REPRESENTABLE_STATUS = 200;
const MAX_REPRESENTABLE_STATUS = 599;

/**
 * Ceiling on a buffered response body, in bytes.
 *
 * Generous by orders of magnitude for the one thing this transport fetches —
 * a single organization's single day of delivery rows — and small enough that a
 * hostile far end cannot exhaust the cron invocation's memory.
 */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/** Prefix on this module's server logs, shared so a rename cannot split them. */
export const EGRESS_LOG_TAG = "[pensero/egress]";

/** Why egress was refused. Safe to travel: it names no host and no address. */
export const EgressBlockReason = {
  /** The scheme was not https, so the credential could travel in cleartext. */
  InsecureScheme: "insecure_scheme",
  /** DNS failed. Unknown is not safe, so it is refused. */
  Unresolvable: "unresolvable",
  /** DNS succeeded and returned nothing to dial. */
  NoAddresses: "no_addresses",
  /** At least one resolved address is internal to the deployment. */
  InternalAddress: "internal_address",
  /** The host answered with a redirect, which this transport never follows. */
  RedirectRefused: "redirect_refused",
  /** The response body exceeded {@link MAX_RESPONSE_BYTES}. */
  ResponseTooLarge: "response_too_large",
  /**
   * The host answered with a status outside the 200–599 range a `Response` can
   * carry, so no response object can be built from it.
   */
  UnrepresentableStatus: "unrepresentable_status",
} as const;
export type EgressBlockReason =
  (typeof EgressBlockReason)[keyof typeof EgressBlockReason];

/**
 * Egress was refused before, or instead of, reaching the configured host.
 *
 * The MESSAGE carries the reason and nothing else. It does not stay on the
 * server: the delivery backfill lifts a thrown reason into
 * `PenseroBackfillDay.lastFailureReason` and from there into a Slack alert, so
 * a message naming the org's hostname or the address its DNS answered with
 * would publish tenant configuration — and, for an internal answer, a fragment
 * of the deployment's own network map — to a channel neither belongs in. The
 * hostname goes to the server log at the refusal site instead, where the
 * audience is an engineer who can already read that org's configuration.
 */
export class EgressBlockedError extends Error {
  readonly reason: EgressBlockReason;

  constructor(reason: EgressBlockReason) {
    super(`Pensero egress refused: ${reason}`);
    this.name = "EgressBlockedError";
    this.reason = reason;
  }
}

/**
 * The socket `lookup` the pinned agent is built with — the ONLY resolution that
 * happens for a request through this transport.
 *
 * It validates EVERY address `getaddrinfo` returned, then hands those same
 * addresses to the connector. Nothing re-resolves the name afterwards, which is
 * what removes the check-then-connect window that makes a plain
 * resolve-and-validate helper useless against DNS rebinding.
 *
 * Exported so its decision can be exercised directly against synthetic DNS
 * answers. This is the production function, not a copy of it.
 */
export const pinnedLookup: LookupFunction = (hostname, options, callback) => {
  // `all` is forced regardless of what the connector asked for, because the
  // whole answer has to be judged before any of it is dialled. Happy Eyeballs
  // would otherwise try a second address this function never looked at.
  const allOptions: LookupAllOptions = { ...options, all: true };
  dnsLookup(hostname, allOptions, (error, addresses) => {
    if (error) {
      refuse(callback, hostname, EgressBlockReason.Unresolvable, 0);
      return;
    }
    if (addresses.length === 0) {
      refuse(callback, hostname, EgressBlockReason.NoAddresses, 0);
      return;
    }
    const blocked = addresses.filter((entry) =>
      isInternalHost(entry.address)
    ).length;
    if (blocked > 0) {
      refuse(callback, hostname, EgressBlockReason.InternalAddress, blocked);
      return;
    }
    if (isAllLookup(options)) {
      callback(null, addresses);
      return;
    }
    callback(null, addresses[0].address, addresses[0].family);
  });
};

/**
 * What the delivery client's transport seam accepts.
 *
 * Deliberately NOT `typeof fetch`, even though the global `fetch` satisfies it.
 * `pinnedFetch` implements a strict subset — https only, no `Request` input, no
 * request body, no redirect following — and typing it as the whole `fetch`
 * contract would let a future caller pass a `body` or a `Request` that compiles
 * and is then silently dropped on the wire. Narrowing the seam turns that into
 * a compile error instead (api-architect, ISS-9690).
 */
export type PinnedTransport = (
  url: string | URL,
  init?: PinnedRequestInit
) => Promise<Response>;

/** The `RequestInit` members this transport actually honours. */
export type PinnedRequestInit = Pick<
  RequestInit,
  "method" | "headers" | "signal" | "redirect"
>;

/**
 * Fetch through the pinned agent.
 *
 * It speaks https only, and it never follows a redirect whatever `init.redirect`
 * says. Following one would dial a location this transport never validated,
 * which is the hole the pin exists to close.
 */
export const pinnedFetch: PinnedTransport = (url, init) =>
  fetchThroughPinnedAgent(url instanceof URL ? url : new URL(url), init);

/**
 * One agent for every pinned request, so the lookup above is the single place a
 * destination address can enter a socket.
 *
 * `maxCachedSessions: 0` because this agent is shared by every ORGANIZATION's
 * request. A cached TLS session ticket is keyed on the destination host, not on
 * the tenant, so two organizations pointing at the same host would resume each
 * other's session — a cross-tenant correlation signal handed to a destination
 * one of those tenants chose (auth-security-expert, ISS-9690). Nothing here
 * needs resumption; the sweep makes one request per organization per day.
 */
const PINNED_AGENT = new Agent({
  lookup: pinnedLookup,
  maxCachedSessions: 0,
});

/** Log the refusal where the detail is safe, then fail the connection. */
function refuse(
  callback: Parameters<LookupFunction>[2],
  hostname: string,
  reason: EgressBlockReason,
  blockedAddressCount: number
): void {
  logRefusal(hostname, reason, blockedAddressCount);
  callback(new EgressBlockedError(reason), []);
}

/**
 * The server-side record of a refusal, shared by both places one can happen so
 * they cannot describe the same event differently.
 *
 * The COUNT, not the addresses. An engineer reading this needs to know that the
 * configured host resolves inward and how much of its record set does; the
 * addresses themselves are the attacker's chosen pointer or the deployment's
 * own private range, and neither belongs in a log line that is shipped off-host.
 */
function logRefusal(
  hostname: string,
  reason: EgressBlockReason,
  blockedAddressCount: number
): void {
  log.error(`${EGRESS_LOG_TAG} Refused a credentialed fetch`, {
    hostname,
    reason,
    blockedAddressCount,
  });
}

/** Can a `Response` be constructed carrying this status at all? */
function isRepresentableStatus(status: number): boolean {
  return (
    status >= MIN_REPRESENTABLE_STATUS && status <= MAX_REPRESENTABLE_STATUS
  );
}

/** Did the connector ask for every address, or just one? */
function isAllLookup(options: LookupOptions): boolean {
  return options.all === true;
}

function fetchThroughPinnedAgent(
  url: URL,
  init: PinnedRequestInit | undefined
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    if (url.protocol !== "https:") {
      reject(new EgressBlockedError(EgressBlockReason.InsecureScheme));
      return;
    }
    // `URL.hostname` keeps an IPv6 literal BRACKETED, and nothing downstream
    // reads that spelling as an address: `net.isIP("[::1]")` is 0, so the
    // connector treats it as a NAME, sends it to the agent's lookup, and
    // `getaddrinfo` answers ENOTFOUND. A public IPv6 base the validator accepts
    // could therefore never deliver, and an internal one would be refused for
    // the wrong reason (whitlockk, ISS-9690). Node re-brackets the `Host` header
    // itself, so the bare form is what both the connector and the header want.
    const host = unbracketIpv6Host(url.hostname);
    // A LITERAL address never reaches the agent's `lookup` — `net` sees an IP
    // and connects straight to it, so `pinnedLookup` is never called and the
    // range check never runs. Relying on `isSecureHttpsUrl` to have refused
    // `https://127.0.0.1/api` at write time is not enough: a row stored before
    // that validator existed, or reached by any other call path, would be
    // dialled with the organization's credential attached. The pin has to hold
    // where the request is ISSUED, not only where the config is written
    // (whitlockk, ISS-9690).
    if (isIP(host) !== 0 && isInternalHost(host)) {
      logRefusal(host, EgressBlockReason.InternalAddress, 1);
      reject(new EgressBlockedError(EgressBlockReason.InternalAddress));
      return;
    }
    const fail = (error: Error) => {
      reject(safeTransportError(error));
    };
    const request = httpsRequest(
      {
        hostname: host,
        port: url.port === "" ? DEFAULT_HTTPS_PORT : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: init?.method ?? "GET",
        headers: outgoingHeaders(init?.headers),
        agent: PINNED_AGENT,
        signal: init?.signal ?? undefined,
      },
      (response) => {
        responseFromIncomingMessage(response).then(resolve, fail);
      }
    );
    request.on("error", fail);
    request.end();
  });
}

/**
 * One Node response as a `Response`, refusing a redirect rather than chasing it.
 *
 * Exported because this is the transport's wire boundary: an `IncomingMessage`
 * is whatever the far side sent, so the statuses that must not become a body
 * and the statuses that must not become a second request are reachable states
 * to cover, not type-forbidden ones.
 */
export function responseFromIncomingMessage(
  message: IncomingMessage
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const status = message.statusCode ?? 0;
    if (REDIRECT_STATUSES.has(status)) {
      message.resume();
      reject(new EgressBlockedError(EgressBlockReason.RedirectRefused));
      return;
    }
    // BEFORE anything is buffered, because the failure this prevents is not a
    // rejected promise. Node's parser accepts any three-digit status and the
    // far end is tenant-chosen, so `HTTP/1.1 600` reaches here as 600 — and
    // `new Response(body, { status: 600 })` throws a `RangeError` from inside
    // the `end` listener, which is an event-emitter callback rather than the
    // promise executor. That throw is uncaught: it does not reject this
    // promise, so the backfill's per-organization error handling never sees it
    // and the whole invocation dies with the remaining organizations unswept
    // (codex bot). Refused as a reason instead, which the sweep records and
    // moves on from.
    if (!isRepresentableStatus(status)) {
      message.resume();
      reject(new EgressBlockedError(EgressBlockReason.UnrepresentableStatus));
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    message.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_RESPONSE_BYTES) {
        // The far end of this connection is chosen by a tenant, so the response
        // size is attacker-controlled. Buffering it whole — which any JSON
        // client must — is a memory bound the cron cannot exceed and survive,
        // so it is refused rather than truncated: a truncated delivery window
        // would be indistinguishable from a quiet day.
        message.destroy();
        reject(new EgressBlockedError(EgressBlockReason.ResponseTooLarge));
        return;
      }
      chunks.push(chunk);
    });
    message.on("error", (error: Error) => {
      reject(safeTransportError(error));
    });
    message.on("end", () => {
      const body = NULL_BODY_STATUSES.has(status)
        ? null
        : Buffer.concat(chunks);
      resolve(
        new Response(body, {
          status,
          statusText: message.statusMessage ?? "",
          headers: responseHeaders(message.headers),
        })
      );
    });
  });
}

/**
 * A transport-layer failure, reduced to Node's own error CODE.
 *
 * This exists because the raw Node error does not stay on the server. It is
 * caught by the backfill, stored as `PenseroBackfillDay.lastFailureReason` and
 * lifted into a Slack alert, and its message names the tenant: a TLS mismatch
 * reads `Hostname/IP does not match certificate's altnames: Host: <the org's
 * host>`, and a refused connection reads `connect ECONNREFUSED <ip>:<port>`.
 * Neither carries a scheme or a leading slash, so `sanitizeFailureReason`'s
 * URL passes leave both intact (davetho, ISS-9690).
 *
 * The platform `fetch` this transport replaced happened to hide that — its
 * top-level message is a flat `fetch failed` and the detail lives on `cause`,
 * which the reason path never reads. Switching to `node:https` would therefore
 * have introduced the leak, so the reason is canonicalised here instead: a code
 * like `ECONNREFUSED` or `ERR_TLS_CERT_ALTNAME_INVALID` names the cause exactly
 * and can name no tenant. The original error is kept as `cause` for a server
 * stack, which the reason path does not serialize.
 */
export class PenseroEgressTransportError extends Error {
  readonly code: string;

  constructor(code: string, cause: Error) {
    super(`Pensero egress transport failed: ${code}`, { cause });
    this.name = "PenseroEgressTransportError";
    this.code = code;
  }
}

/**
 * `error` with anything tenant-identifying removed. An {@link EgressBlockedError}
 * is already reason-only and passes through unchanged.
 */
function safeTransportError(error: Error): Error {
  if (error instanceof EgressBlockedError) {
    return error;
  }
  return new PenseroEgressTransportError(transportErrorCode(error), error);
}

/** Node's error code, or the error's name when it carries none. */
function transportErrorCode(error: Error): string {
  if ("code" in error && typeof error.code === "string" && error.code !== "") {
    return error.code;
  }
  return error.name;
}

/** `RequestInit.headers` in any of its shapes, as outgoing request headers. */
function outgoingHeaders(
  headers: HeadersInit | undefined
): Record<string, string> {
  const outgoing: Record<string, string> = {};
  if (!headers) {
    return outgoing;
  }
  if (headers instanceof Headers) {
    for (const [name, value] of headers.entries()) {
      outgoing[name] = value;
    }
    return outgoing;
  }
  if (Array.isArray(headers)) {
    for (const [name, value] of headers) {
      outgoing[name] = value;
    }
    return outgoing;
  }
  return { ...headers };
}

/** Node's incoming headers as a `Headers`, keeping repeated values apart. */
function responseHeaders(incoming: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming)) {
    if (typeof value === "string") {
      headers.append(name, value);
    } else if (Array.isArray(value)) {
      for (const entry of value) {
        headers.append(name, entry);
      }
    }
  }
  return headers;
}
