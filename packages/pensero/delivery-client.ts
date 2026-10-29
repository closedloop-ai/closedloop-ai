import "server-only";
import { log } from "@repo/observability/log";
import {
  baseUrlDuplicatesDeliveryPath,
  hasQueryOrFragment,
  PENSERO_DELIVERY_PATH,
  PenseroCredentialSource,
  resolvePenseroCredential,
} from "./credential";
import type { PenseroDeliverySegment } from "./delivery-contract";
import { extractDeliverySegment } from "./delivery-extractor";
import { keys } from "./keys";
import { type PinnedTransport, pinnedFetch } from "./pinned-egress";

/**
 * Client for the VERIFIED Pensero delivery endpoint (ISS-8399):
 *
 *   GET <base>/v1/delivery?start_date=&end_date=&team_identifiers=
 *   X-Auth-Token: tk_<public>:sk_<secret>
 *
 * SECURITY: the credential embeds a secret half. It is read from server config
 * only, in this module, and is never returned to a caller, never logged, and
 * never included in an error message — response bodies are deliberately not
 * echoed on failure because an upstream error page can quote the request
 * headers back.
 *
 * NOTE the header. This endpoint was verified to take `X-Auth-Token`. Pensero's
 * person-centric `/delivery-metrics/` surface takes `Authorization: Token`
 * instead (its client was deleted by ISS-11588 after it never gained a caller);
 * the two are not interchangeable, so do not change this one on assumption.
 */

/**
 * Path of the verified delivery collection, relative to the configured base.
 *
 * Aliased from `./credential` rather than declared here (ISS-9689): this module
 * is `server-only`, so the settings-route validator that must refuse a base
 * already ending in this path cannot import it from here. One declaration, two
 * importers — a second copy is free to disagree with the string actually
 * appended below.
 */
const DELIVERY_PATH = PENSERO_DELIVERY_PATH;

/** Matches one-or-more trailing slashes on a base URL path, for normalization. */
const TRAILING_SLASHES_RE = /\/+$/;

/** Per-request wall-clock ceiling, so a stalled segment cannot pin an invocation. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Keys that, if the delivery response ever grows one, mean the response is a
 * PAGE rather than the whole window. None is present in the verified sample —
 * which is exactly the problem this set guards (see {@link SegmentCompleteness}).
 */
const CONTINUATION_KEYS = [
  "next",
  "next_cursor",
  "nextCursor",
  "has_more",
  "hasMore",
  "count",
  "total",
] as const;

/**
 * How much we know about whether a fetched segment is the WHOLE window.
 *
 * There is deliberately no `Complete` member. The verified delivery response
 * carries no `hasMore`, no cursor and no total, which means either the endpoint
 * is unpaginated or a segment is silently truncated at a server default — and
 * a truncated segment is byte-for-byte indistinguishable from a quiet period.
 * Claiming completeness we cannot demonstrate is precisely the false-completeness
 * failure this feature must not commit, so the honest ceiling is "unverified".
 *
 * THIS IS A BLOCKING UNKNOWN for backfill correctness. It is resolved by an
 * operator probing the live endpoint (request a window known to exceed any
 * plausible page size and check whether the row count plateaus), not by code.
 */
export const SegmentCompleteness = {
  /** No continuation metadata was present. Completeness is UNPROVEN. */
  Unverified: "unverified",
  /** Continuation metadata WAS present, so this segment is known partial. */
  TruncationSignalled: "truncation_signalled",
} as const;
export type SegmentCompleteness =
  (typeof SegmentCompleteness)[keyof typeof SegmentCompleteness];

/** One fetched segment plus what is known about its completeness. */
export type FetchedDeliverySegment = {
  readonly segment: PenseroDeliverySegment;
  readonly completeness: SegmentCompleteness;
  /** The continuation keys actually observed, when any were. */
  readonly continuationKeysSeen: readonly string[];
};

export type FetchDeliveryOptions = {
  /** Inclusive window start, `YYYY-MM-DD`. */
  readonly startDate: string;
  /** Inclusive window end, `YYYY-MM-DD`. */
  readonly endDate: string;
  /**
   * Pensero team identifiers to scope the window to (e.g. `["Engineering"]`).
   *
   * OPTIONAL, and absent is not the same as empty (ISS-8761). Absent — omitted,
   * or an empty list — omits the `team_identifiers` parameter entirely and
   * accepts the provider's all-teams response. Sending an empty parameter would
   * ask Pensero to scope to nothing, and the empty window that came back would
   * be indistinguishable from a quiet day. These are the PROVIDER's own
   * identifiers; they are never derived from ClosedLoop `Team` names.
   */
  readonly teamIdentifiers?: readonly string[];
  readonly signal?: AbortSignal;
  readonly requestTimeoutMs?: number;
  /**
   * Injected for tests; defaults to the transport {@link transportFor} picks.
   *
   * Typed as the NARROW seam rather than `typeof fetch` (ISS-9690): the pinned
   * transport implements a strict subset, and the wider type would let a caller
   * pass a body or a `Request` that compiles and is then dropped on the wire.
   * The global `fetch` still satisfies it.
   */
  readonly fetchImpl?: PinnedTransport;
  /**
   * A credential resolved by the CALLER for one organization (ISS-8761).
   *
   * When present it is used verbatim and the deployment-wide env vars are not
   * consulted; when absent this falls back to env, which is the single-tenant /
   * self-hosted path and the only behaviour that existed before. It is passed
   * per call rather than held anywhere: the multi-tenant cron decrypts an org's
   * token just in time, hands it in, and it dies with the call frame. Nothing
   * here logs it, returns it, or writes it anywhere.
   */
  readonly credential?: PenseroRequestCredential;
};

/** A caller-resolved Pensero credential for one request. Never persisted. */
export type PenseroRequestCredential = {
  readonly token: string;
  readonly baseUrl: string;
  /**
   * WHO chose `baseUrl` — which decides whether this request's egress is pinned
   * (ISS-9690). See {@link transportFor}. Optional so a caller that predates the
   * field still gets the SAFE behaviour: absent means "assume tenant-supplied".
   */
  readonly baseUrlSource?: PenseroCredentialSource;
};

/**
 * Resolve the credential + base URL, throwing a clear error when the
 * integration is not configured. Goes through the shared resolver so there is
 * exactly one precedence implementation for env vs per-org credentials.
 */
function getRequiredConfig(): PenseroRequestCredential {
  const config = keys();
  const resolved = resolvePenseroCredential({
    env: {
      token: config.PENSERO_API_TOKEN,
      baseUrl: config.PENSERO_API_BASE_URL,
    },
  });
  if (!resolved) {
    throw new Error(
      "Pensero integration not configured. Set PENSERO_API_TOKEN (a tk_<public>:sk_<secret> token)."
    );
  }
  return {
    token: resolved.token,
    baseUrl: resolved.baseUrl,
    baseUrlSource: resolved.baseUrlSource,
  };
}

/**
 * Build the absolute delivery URL. The base is parsed rather than concatenated,
 * so a base with a trailing slash (`https://pensero.ai/api/`) still yields
 * `/api/v1/delivery`, and a base carrying a query or fragment is rejected as a
 * misconfiguration instead of silently dropping the path onto the wrong place.
 *
 * KNOWN DEFECT, stated because the docstring used to imply otherwise
 * (davetho, #6639): a base with NO path segment does NOT yield `/v1/delivery`.
 * `URL` normalizes such a base's `pathname` to `"/"`, and assigning the stripped
 * `""` back re-normalizes it to `"/"` again, so `https://pensero.ai` requests
 * `https://pensero.ai//v1/delivery` — with a doubled separator, which most
 * servers treat as a different path. The tests pin that shape deliberately: this
 * function's callers report what was REQUESTED, and a prettier string would be a
 * diagnostic that lies. Changing it changes what a live credentialed cron asks
 * for, so it is flagged for a human rather than taken here; it is not the cause
 * of the incident this diagnostic was added for (that base is wrong regardless).
 */
export function resolveDeliveryUrl(
  baseUrl: string,
  options: Pick<
    FetchDeliveryOptions,
    "startDate" | "endDate" | "teamIdentifiers"
  >
): string {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new Error(
      `Pensero base URL is not a valid absolute URL: "${baseUrl}".`
    );
  }
  if (hasQueryOrFragment(base)) {
    throw new Error(
      "Pensero base URL must not contain a query string or fragment; set PENSERO_API_BASE_URL to a plain origin/path (e.g. https://pensero.ai/api)."
    );
  }
  base.pathname = base.pathname.replace(TRAILING_SLASHES_RE, "");
  const url = new URL(`${base.origin}${base.pathname}${DELIVERY_PATH}`);
  url.searchParams.set("start_date", options.startDate);
  url.searchParams.set("end_date", options.endDate);
  // OMITTED, not set to "", when the org has configured no narrowing. An empty
  // `team_identifiers=` is a request to scope to no team at all, and the empty
  // window it returns cannot be told apart from a genuinely quiet day.
  const teamIdentifiers = options.teamIdentifiers ?? [];
  if (teamIdentifiers.length > 0) {
    url.searchParams.set("team_identifiers", teamIdentifiers.join(","));
  }
  return url.toString();
}

/**
 * Which continuation keys a raw response carries. Exported so the backfill can
 * assert on the shape without re-deriving the key list.
 */
export function observedContinuationKeys(json: unknown): string[] {
  if (typeof json !== "object" || json === null) {
    return [];
  }
  return CONTINUATION_KEYS.filter((key) => Object.hasOwn(json, key));
}

/**
 * Combine the caller's abort signal with a per-request timeout so a fetch
 * aborts on whichever fires first.
 */
function buildRequestSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return callerSignal
    ? AbortSignal.any([callerSignal, timeoutSignal])
    : timeoutSignal;
}

/**
 * Fetch ONE delivery window and extract it.
 *
 * The window is the caller's segmentation unit — this function does not loop,
 * because there is no cursor to loop on. What it does instead is report what it
 * can and cannot know about the window's completeness, so the backfill above it
 * never presents an unverified segment as an exhaustive one.
 */
export async function fetchDeliverySegment(
  options: FetchDeliveryOptions
): Promise<FetchedDeliverySegment> {
  const { token, baseUrl, baseUrlSource } =
    options.credential ?? getRequiredConfig();
  const url = resolveDeliveryUrl(baseUrl, options);
  // Both derived from the string handed to `fetch` below rather than recomputed
  // from `baseUrl`, so what a failure reports cannot drift from what the request
  // used. They go to DIFFERENT SINKS — see the failure branch.
  const deliveryPath = deliveryRequestPath(url);
  const basePathSegments = configuredBasePathSegments(url);
  const requestTimeoutMs = Math.max(
    1,
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  );
  const doFetch = options.fetchImpl ?? transportFor(baseUrlSource);

  const response = await doFetch(url, {
    headers: {
      "X-Auth-Token": token,
      Accept: "application/json",
    },
    // NEVER FOLLOW A REDIRECT (davetho, #6492). ISS-8761 turned `baseUrl`
    // from an inert stored string into a live, credentialed fetch target that a
    // daily cron aims for every organization, and `baseUrl` is set by an org
    // admin. `isSecureHttpsUrl` vets the LITERAL host at write time, which a
    // redirect walks straight around: a validated public host answering 302 to
    // `http://127.0.0.1/…` would otherwise have this request — carrying
    // `X-Auth-Token` — delivered to the deployment's own loopback.
    // `"error"` rejects instead of following, so a provider that starts
    // redirecting fails loudly and is fixed rather than silently trusted.
    // Stated on the init because that is the seam the platform reads; the
    // pinned transport refuses a redirect unconditionally as well.
    redirect: "error",
    signal: buildRequestSignal(options.signal, requestTimeoutMs),
  });

  if (!response.ok) {
    // TWO SINKS, TWO AUDIENCES, DELIBERATELY UNEQUAL (whitlockk, #6639).
    //
    // The LOG gets the full resolved path. It is a server-side structured log
    // whose audience is an engineer already able to read the org's config, and
    // it is the record that answers "which endpoint, exactly".
    //
    // The THROWN MESSAGE gets a strictly weaker descriptor, because it does not
    // stay here: it becomes `PenseroBackfillDay.lastFailureReason` and from
    // there the backfill lifts it into a Slack alert. `isSecureHttpsUrl` vets
    // the scheme, the host's publicness, and the absence of query/fragment/
    // userinfo — it says NOTHING about the path, so an org may configure
    // `https://tenant.example/private/customer-42` and the resolved path is
    // tenant-identifying. What travels is therefore the module's OWN constant
    // endpoint plus a COUNT of configured base-path segments: an integer cannot
    // name a tenant, and it is the discriminator this incident actually needed
    // (0 segments = the stored base lost its path; see `configuredBasePathSegments`).
    //
    // Still deliberately no response body, on either sink: an upstream error
    // page can echo request headers, and those carry the credential's secret half.
    log.error("[pensero/delivery] Delivery fetch failed", {
      status: response.status,
      deliveryPath,
      basePathSegments,
      startDate: options.startDate,
      endDate: options.endDate,
    });
    throw new PenseroDeliveryRequestError(
      response.status,
      basePathSegments,
      // ISS-9689. Computed from the CONFIGURED base, not the resolved URL,
      // because that is the value a human has to go and edit. When it holds,
      // the failure stops being a segment count to decode and becomes a
      // sentence naming the fix — which is the difference between an eleven-day
      // outage and a thirty-second one.
      baseUrlDuplicatesDeliveryPath(baseUrl)
    );
  }

  const json: unknown = await response.json();
  const continuationKeysSeen = observedContinuationKeys(json);
  const segment = extractDeliverySegment(json);

  if (continuationKeysSeen.length > 0) {
    // The endpoint grew pagination since this client was written. Following it
    // is unimplemented, so the segment is KNOWN partial rather than merely
    // unproven — say so loudly instead of returning a confident prefix.
    log.error(
      "[pensero/delivery] Delivery response carries continuation keys",
      {
        continuationKeysSeen,
        startDate: options.startDate,
        endDate: options.endDate,
      }
    );
  }

  return {
    segment,
    completeness:
      continuationKeysSeen.length > 0
        ? SegmentCompleteness.TruncationSignalled
        : SegmentCompleteness.Unverified,
    continuationKeysSeen,
  };
}

/**
 * The full PATH a resolved delivery URL requests — `/api/v1/delivery` for a base
 * of `https://pensero.ai/api`.
 *
 * FOR THE SERVER LOG ONLY. The configured base path is org-supplied and may be
 * tenant-identifying (`isSecureHttpsUrl` never constrains it), so this value is
 * fine in a structured server log and must not travel to a wider sink. What is
 * allowed to travel is {@link configuredBasePathSegments}.
 *
 * The QUERY is excluded on both sinks regardless: it carries `team_identifiers`,
 * which is organization data, and the window being backfilled. `URL.pathname`
 * drops the search and fragment structurally, so that exclusion cannot be lost
 * to a future edit.
 */
export function deliveryRequestPath(url: string): string {
  return new URL(url).pathname;
}

/**
 * How many path segments of the CONFIGURED BASE precede this module's constant
 * endpoint — 1 for `https://pensero.ai/api`, 2 for
 * `https://tenant.example/private/customer-42`, 0 for a base with no path.
 *
 * A COUNT, never the segment names, because this value is allowed to leave the
 * server: it is what the thrown message carries into the ledger and on into
 * Slack. An integer cannot name a tenant.
 *
 * ## What an operator can still tell apart with it
 *
 * Paired with the HTTP status that accompanies it, and with the fact that a
 * failure to reach the host at all is a transport error carrying no status:
 *
 * - no status, `fetch` rejected      → host unreachable / DNS / TLS: WRONG HOST
 * - 401 / 403                        → AUTH
 * - 404 and `basePathSegments === 0` → the stored base lost its path segment.
 *   This is the incident that produced eight consecutive all-failed days.
 * - 404 and `basePathSegments >= 1`  → a base path IS configured but the
 *   endpoint is not under it. Which of the two — wrong path value, or a
 *   wrong-but-reachable host — is the ONE distinction this descriptor cannot
 *   make, and it is the one the server log above answers.
 */
export function configuredBasePathSegments(url: string): number {
  const path = new URL(url).pathname;
  const basePath = path.endsWith(DELIVERY_PATH)
    ? path.slice(0, -DELIVERY_PATH.length)
    : path;
  return basePath.split("/").filter((segment) => segment.length > 0).length;
}

/**
 * The delivery endpoint answered with a non-2xx status.
 *
 * The MESSAGE is unchanged from the plain `Error` this replaced — it is what
 * lands in `PenseroBackfillDay.lastFailureReason` and, through the ledger, in
 * the Slack alert, so it stays byte-identical and keeps carrying the module's
 * own constant endpoint plus a segment COUNT rather than the org's base path.
 *
 * What the class ADDS is ONE construction site for that message, including the
 * conditional doubled-path remedy below — so the sentence cannot drift between
 * the throw and the tests that assert on it, which build it from this class
 * rather than from a copy of its wording.
 *
 * The constructor inputs are kept as readable fields. There is no production
 * reader of them today: they exist so a future caller that must branch on the
 * status reads a number instead of re-parsing prose, because a message a second
 * module parses is a message that cannot be reworded without silently breaking
 * that parse. Stated as intent rather than dressed up as a current need.
 *
 * Still deliberately carries NO response body, for the reason the throw site
 * states: an upstream error page can echo the request headers, and those hold
 * the credential's secret half.
 */
export class PenseroDeliveryRequestError extends Error {
  readonly status: number;
  readonly basePathSegments: number;
  /** True when the configured base already ended in {@link DELIVERY_PATH}. */
  readonly baseDuplicatesDeliveryPath: boolean;

  constructor(
    status: number,
    basePathSegments: number,
    baseDuplicatesDeliveryPath = false
  ) {
    super(
      `Pensero delivery request failed: ${status} (endpoint=${DELIVERY_PATH} basePathSegments=${basePathSegments})${
        baseDuplicatesDeliveryPath ? DUPLICATED_PATH_HINT : ""
      }`
    );
    this.name = "PenseroDeliveryRequestError";
    this.status = status;
    this.basePathSegments = basePathSegments;
    this.baseDuplicatesDeliveryPath = baseDuplicatesDeliveryPath;
  }
}

/**
 * Appended to the failure when the configured base already ends in the delivery
 * path, so the alert names the CAUSE instead of a count to decode (ISS-9689).
 *
 * Written to survive `sanitizeFailureReason` intact, which is why it reads the
 * way it does: no absolute URL (those are replaced whole, so a helpful
 * `https://pensero.ai/api` example would arrive as `[redacted-url]`), no query
 * or fragment after a path, and short enough that the whole reason stays under
 * that module's 200-character cap rather than being truncated mid-diagnosis.
 * It names only this module's own constant, so it is safe on the Slack sink.
 */
const DUPLICATED_PATH_HINT = ` — the base URL already ends in ${PENSERO_DELIVERY_PATH}; set it to the API root, not the full request URL.`;

/**
 * Which transport carries this request (ISS-9690).
 *
 * A base URL an ORG ADMIN typed is attacker-reachable input, and the literal
 * host check that cleared it at write time cannot see DNS — so a public name
 * pointing at `169.254.169.254` reaches this function looking exactly like a
 * legitimate provider. That request goes through `pinnedFetch`, which resolves
 * once, refuses any internal answer, and dials the address it validated.
 *
 * A base URL the OPERATOR set (`PENSERO_API_BASE_URL`, or the built-in default)
 * is not tenant input, and a self-hosted deployment whose Pensero genuinely
 * sits on a private address must keep reaching it. That is the same line
 * `isSecureOrLoopbackHttpUrl` already draws against `isSecureHttpsUrl`, and it
 * is drawn here on the SOURCE label rather than on the URL, because an internal
 * https host is indistinguishable from a tenant-supplied one by inspection.
 *
 * An ABSENT source pins. A caller that does not say where its base came from is
 * not evidence that an operator chose it.
 */
function transportFor(
  baseUrlSource: PenseroCredentialSource | undefined
): PinnedTransport {
  const operatorChosen =
    baseUrlSource === PenseroCredentialSource.Environment ||
    baseUrlSource === PenseroCredentialSource.Default;
  return operatorChosen ? fetch : pinnedFetch;
}
