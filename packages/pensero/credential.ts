/**
 * The Pensero credential contract, shared by every producer and consumer of a
 * Pensero token (ISS-8007).
 *
 * This module is deliberately dependency-free and carries NO `server-only`
 * marker: `keys.ts` imports it during env validation, the API route imports it
 * to validate an org admin's submitted credential, and both must agree on what
 * a valid credential IS. Re-declaring the URL predicate or the token shape at
 * the route boundary is how the two halves silently drift apart, so they are
 * declared once, here.
 *
 * It holds no secret and reads no environment; it is pure predicates plus the
 * precedence rule.
 */

/** Loopback hosts allowed to use plaintext http:// for local development. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * A Pensero DRF `TokenAuth` credential: a public half and a secret half joined
 * by a colon (`tk_<public>:sk_<secret>`), sent whole as `Authorization: Token`.
 *
 * Anchored at both ends so a token with leading/trailing whitespace or an
 * embedded newline (a paste artifact, and a header-injection vector once it
 * reaches a request header) is rejected rather than trimmed into acceptance.
 */
const PENSERO_TOKEN_PATTERN = /^tk_[A-Za-z0-9._-]+:sk_[A-Za-z0-9._-]+$/;

/** Default production Pensero API base, used when no override is configured. */
export const DEFAULT_PENSERO_BASE_URL = "https://pensero.ai/api";

/**
 * Which configuration source a resolved credential field came from. Carried on
 * the resolution result so a caller (and an operator reading a log line) can
 * tell an org-configured credential from the deployment-wide default without
 * inspecting the secret itself.
 */
export const PenseroCredentialSource = {
  /** The per-org row configured on the Integrations screen. */
  Organization: "organization",
  /** The deployment-wide `PENSERO_API_*` environment variables. */
  Environment: "environment",
  /**
   * Neither source configured this field and the built-in fallback supplied it
   * ({@link DEFAULT_PENSERO_BASE_URL}). A distinct member rather than a reused
   * `Environment`, because reporting a value the environment never set as
   * having come from the environment is exactly the kind of confident-but-wrong
   * attribution this codebase treats as a defect. Only ever a `baseUrlSource` —
   * there is no default token.
   */
  Default: "default",
} as const;
export type PenseroCredentialSource =
  (typeof PenseroCredentialSource)[keyof typeof PenseroCredentialSource];

/**
 * Does `value` have the shape of a Pensero credential?
 *
 * NOTE the deliberate asymmetry with `keys.ts`, which validates the env var as
 * only `z.string().min(1)`. This shape check is enforced at the ROUTE boundary
 * and NOT retrofitted onto the env var: env input is operator-set and already
 * working on live deployments, and tightening it would turn a token this
 * pattern happens not to match into a hard BOOT failure for a deployment that
 * is fine today. Route input is new, untrusted, and has no such installed base.
 */
export function isPenseroTokenShape(value: string): boolean {
  return PENSERO_TOKEN_PATTERN.test(value);
}

/**
 * Require an https:// base URL so the secret-bearing `Authorization: Token`
 * header is never sent in cleartext. Plaintext http:// is permitted only for
 * loopback origins (local development / self-hosted on the same host).
 *
 * This is the OPERATOR-facing rule, used for the `PENSERO_API_BASE_URL` env
 * var. Org-admin-supplied URLs go through {@link isSecureHttpsUrl} instead.
 */
export function isSecureOrLoopbackHttpUrl(value: string): boolean {
  const parsed = parseUrl(value);
  if (!parsed) {
    return false;
  }
  if (parsed.protocol === "https:") {
    return true;
  }
  return parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname);
}

/**
 * Does this base URL carry a query string or fragment?
 *
 * Neither has any meaning on a collection base, and both break resolution
 * against the endpoint path — `https://host/api?x=1` would drop the query onto
 * the wrong place. `resolveDeliveryMetricsUrl` in the client has always thrown
 * on one; this is that same rule, hoisted here so the route can REFUSE such a
 * URL at the form instead of storing it and letting the client throw later,
 * with a message naming an env var an org admin does not control.
 */
export function hasQueryOrFragment(url: URL): boolean {
  return Boolean(url.search || url.hash);
}

/**
 * Does this URL carry credentials in its userinfo component
 * (`https://user:pass@host/api`)?
 *
 * `base_url` is stored in PLAINTEXT and `GET /settings/pensero` hands it back to
 * every member of the organization, not only admins. A URL with userinfo
 * therefore turns the endpoint field into an unencrypted, org-readable secret
 * store — the exact thing the token column's KMS encryption and write-only
 * treatment exist to prevent, reachable by pasting one string into the wrong
 * box (#6030, tamsinb).
 *
 * It would also not do what the admin intended: `resolveDeliveryMetricsUrl`
 * rebuilds the request URL from `origin + pathname`, and `URL.origin` excludes
 * userinfo, so those credentials are dropped before any request is made. The
 * value is disclosed and never used.
 */
function hasUrlCredentials(url: URL): boolean {
  return url.username !== "" || url.password !== "";
}

/**
 * Hostname suffixes that name a host by convention rather than by address:
 * `.localhost` is reserved for loopback (RFC 6761), `.internal` is where cloud
 * metadata services live (`metadata.google.internal`), and `.local` is mDNS on
 * the deployment's own link.
 */
const INTERNAL_HOST_SUFFIXES = [".localhost", ".internal", ".local"];
const INTERNAL_HOST_NAMES = new Set(["localhost", "internal"]);

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
/** `new URL()` keeps IPv6 hosts bracketed; strip them before parsing. */
const IPV6_BRACKETS_RE = /^\[|\]$/g;
/** A dotted quad in the tail position of an IPv6 address (`::ffff:10.0.1.5`). */
const IPV6_TRAILING_IPV4_RE = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
/** One 16-bit group of an IPv6 address, hex, unabbreviated leading zeros optional. */
const IPV6_GROUP_RE = /^[0-9a-f]{1,4}$/i;
const HEX_RADIX = 16;
/** One byte's worth of values, for splitting a 16-bit group into two octets. */
const BYTE_RANGE = 256;
/** How many 16-bit groups a full IPv6 address has. */
const IPV6_GROUP_COUNT = 8;
/** The largest value one group can hold. */
const IPV6_GROUP_MAX = 0xff_ff;
/** `2002::/16` — RFC 3056 6to4, which carries its IPv4 in groups 1 and 2. */
const SIX_TO_FOUR_PREFIX = 0x20_02;
/** The two leading groups of the RFC 6052 well-known NAT64 prefix `64:ff9b::/96`. */
const NAT64_PREFIX = [0x00_64, 0xff_9b];
/** `fc00::/7`, unique-local, as an inclusive first-group range. */
const UNIQUE_LOCAL_FIRST_GROUP = [0xfc_00, 0xfd_ff];
/** `fe80::/10`, link-local, as an inclusive first-group range. */
const LINK_LOCAL_FIRST_GROUP = [0xfe_80, 0xfe_bf];
/**
 * `fec0::/10`, RFC 3879's DEPRECATED site-local range, as an inclusive
 * first-group range.
 *
 * Deprecated is not the same as unreachable. A deployment that still routes
 * site-local internally delivers `fec0::1` to an internal service, and the
 * range has never been globally routable, so nothing a tenant could legitimately
 * point Pensero at lives there. Treating it as public was the one remaining way
 * an IPv6 first-group check called an internal destination external.
 */
const SITE_LOCAL_FIRST_GROUP = [0xfe_c0, 0xfe_ff];

/** The IPv6 blocks decided by their first group alone, low and high inclusive. */
const INTERNAL_FIRST_GROUP_RANGES = [
  UNIQUE_LOCAL_FIRST_GROUP,
  LINK_LOCAL_FIRST_GROUP,
  SITE_LOCAL_FIRST_GROUP,
] as const;

/**
 * `hostname` with the brackets `URL` wraps an IPv6 literal in removed, so
 * `[::1]` becomes `::1`.
 *
 * Exported because the bracketed spelling is not an address to anything that
 * parses one: `net.isIP("[::1]")` is 0, and `net.connect` treats it as a NAME
 * and resolves it. A caller handing `URL.hostname` to either has to strip the
 * brackets first, and doing that with a second copy of the pattern is how the
 * two would eventually disagree (whitlockk, ISS-9690).
 *
 * A non-bracketed host is returned unchanged, so it is safe on any hostname.
 */
export function unbracketIpv6Host(hostname: string): string {
  return hostname.replace(IPV6_BRACKETS_RE, "");
}

/**
 * Is this hostname one the deployment's own server must never be pointed at by
 * a TENANT? Loopback, the RFC 1918 private ranges, CGNAT, link-local
 * (169.254.0.0/16 — which is where the cloud metadata endpoint
 * `169.254.169.254` lives), the unspecified block, and the IPv6 equivalents
 * including the deprecated-but-still-routed site-local `fec0::/10`.
 *
 * WHAT THIS IS AND IS NOT (#6030, davetho). The https rule alone is not an
 * SSRF defence — it stops CLEARTEXT, not a request to an internal address, and
 * `https://127.0.0.1:8000/api` or `https://169.254.169.254/api` sailed through
 * a protocol-only check while the docstring below claimed loopback was handled.
 * This closes the LITERAL forms. It does NOT resolve DNS, so a public hostname
 * whose A record points into the private range still passes here; defending
 * that needs an address check at REQUEST time, and is not claimed by this
 * predicate. Stated rather than left as silence, so the next reader does not
 * take this function for more than it is.
 *
 * That request-time check now exists — `./pinned-egress` validates every
 * resolved address and dials the address it validated (ISS-9690) — and it
 * reuses THIS predicate rather than restating the ranges, so the write-time
 * refusal and the connect-time refusal cannot disagree about what "internal"
 * means. Both layers are kept: refusing a literal loopback base before it is
 * ever stored is a better failure than accepting it and blocking it nightly.
 *
 * Takes either a URL hostname or a resolved literal address; a resolved address
 * only ever reaches the IP branches below.
 *
 * A self-hosted deployment whose Pensero really does sit on a private address
 * keeps reaching it through `PENSERO_API_BASE_URL`, which is operator-set and
 * unchanged — the same place the http:// loopback exemption already lives, and
 * the same reason `./pinned-egress` pins only ORG-supplied bases.
 */
export function isInternalHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (
    INTERNAL_HOST_NAMES.has(host) ||
    INTERNAL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
  ) {
    return true;
  }
  const ipv4 = IPV4_RE.exec(host);
  if (ipv4) {
    return isInternalIpv4([ipv4[1], ipv4[2], ipv4[3], ipv4[4]].map(Number));
  }
  return isInternalIpv6(host);
}

/** The IPv4 blocks a tenant must not be able to aim the server at. */
function isInternalIpv4(octets: number[]): boolean {
  const [a, b] = octets;
  if (octets.some((octet) => octet > 255)) {
    // Not a valid dotted quad, so it is not an address this check can clear.
    return true;
  }
  return (
    a === 0 || // 0.0.0.0/8, "this network"
    a === 10 || // RFC 1918
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // RFC 6598 CGNAT
    (a === 169 && b === 254) || // link-local, incl. the 169.254.169.254 metadata endpoint
    (a === 172 && b >= 16 && b <= 31) || // RFC 1918
    (a === 192 && b === 168) // RFC 1918
  );
}

/**
 * The IPv6 equivalents, judged on the address's PARSED groups rather than on
 * its spelling.
 *
 * The spelling matters more here than it looks. `new URL()` normalizes
 * `[::ffff:10.0.1.5]` into `[::ffff:a00:105]`, and `dns.lookup` returns
 * whatever `inet_ntop` produces, so a check written against one rendering of an
 * address silently misses the others. Parsing to eight groups once and deciding
 * from the numbers is what makes every spelling of the same address answer the
 * same way.
 *
 * Returns false for anything that is not an IPv6 literal at all — a plain
 * hostname reaches here as the last branch of {@link isInternalHost}, and
 * refusing it would block every legitimate provider.
 */
function isInternalIpv6(host: string): boolean {
  const groups = ipv6Groups(unbracketIpv6Host(host));
  if (!groups) {
    return false;
  }
  const embedded = embeddedIpv4Octets(groups);
  if (embedded) {
    return isInternalIpv4(embedded);
  }
  const first = groups[0];
  return INTERNAL_FIRST_GROUP_RANGES.some(
    ([low, high]) => first >= low && first <= high
  );
}

/**
 * The IPv4 address an IPv6 address EMBEDS, in any of the five forms that are
 * delivered to a real IPv4 host, or null when it embeds none.
 *
 * The NAT64 and 6to4 forms are the ones a literal-prefix check misses, and they
 * are not theoretical on this deployment: an IPv6-only subnet with DNS64/NAT64 —
 * the ordinary shape of a modern serverless network — translates
 * `64:ff9b::a00:1` straight to `10.0.0.1`, and a 6to4 relay does the same for
 * `2002:a00:1::`. A guard that judged those by their first group would call both
 * public and hand the credential to the internal host they name (davetho,
 * ISS-9690).
 *
 * A form that embeds a PUBLIC IPv4 stays public: the embedded address is run
 * through the same {@link isInternalIpv4} the dotted form uses, so a legitimate
 * NAT64 or 6to4 route to a public host is not refused.
 */
function embeddedIpv4Octets(groups: readonly number[]): number[] | null {
  if (isZeroPrefixedIpv4Embedding(groups)) {
    return octetsFromGroups(groups[6], groups[7]);
  }
  const [first, second, third, fourth, fifth, sixth] = groups;
  if (
    first === NAT64_PREFIX[0] &&
    second === NAT64_PREFIX[1] &&
    third === 0 &&
    fourth === 0 &&
    fifth === 0 &&
    sixth === 0
  ) {
    return octetsFromGroups(groups[6], groups[7]);
  }
  if (first === SIX_TO_FOUR_PREFIX) {
    return octetsFromGroups(groups[1], groups[2]);
  }
  return null;
}

/**
 * Do groups 0–5 spell one of the three `::`-prefixed ways an IPv6 address
 * carries an IPv4 one in its last two groups?
 *
 * RFC 4291's IPv4-MAPPED form (`::ffff:0:0/96`) and its deprecated
 * IPv4-COMPATIBLE form (`::/96`, which also covers `::` and `::1`) both put
 * their marker in group 5. RFC 2765's IPv4-TRANSLATED form (`::ffff:0:0:0/96`)
 * puts the same `ffff` one group EARLIER, so a check anchored on group 5 alone
 * reads `::ffff:0:10.0.1.5` as public while a SIIT translator delivers it to
 * `10.0.1.5` (whitlockk, ISS-9690).
 */
function isZeroPrefixedIpv4Embedding(groups: readonly number[]): boolean {
  const [first, second, third, fourth, fifth, sixth] = groups;
  if (first !== 0 || second !== 0 || third !== 0 || fourth !== 0) {
    return false;
  }
  if (fifth === 0) {
    return sixth === IPV6_GROUP_MAX || sixth === 0;
  }
  return fifth === IPV6_GROUP_MAX && sixth === 0;
}

/** Two 16-bit groups as the four IPv4 octets they carry, high group first. */
function octetsFromGroups(high: number, low: number): number[] {
  // Arithmetic rather than `>>`/`&`: Biome's `noBitwiseOperators` is an error
  // here, and each group is at most four hex digits so the division is exact.
  return [
    Math.floor(high / BYTE_RANGE),
    high % BYTE_RANGE,
    Math.floor(low / BYTE_RANGE),
    low % BYTE_RANGE,
  ];
}

/**
 * The eight groups of an IPv6 address, or null when `address` is not one.
 *
 * A zone id (`fe80::1%eth0`) is dropped before parsing — it names an interface,
 * not a different address, and keeping it would make the address unparseable
 * and therefore, by the null contract above, "not internal".
 */
function ipv6Groups(address: string): number[] | null {
  const normalized = withoutTrailingQuad(address.split("%")[0]);
  if (normalized === null || !normalized.includes(":")) {
    return null;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) {
    return null;
  }
  const head = splitGroups(halves[0]);
  const tail = halves.length === 2 ? splitGroups(halves[1]) : [];
  const elided =
    halves.length === 2 ? IPV6_GROUP_COUNT - head.length - tail.length : 0;
  if (elided < 0) {
    return null;
  }
  const groups = [...head, ...new Array<string>(elided).fill("0"), ...tail];
  if (
    groups.length !== IPV6_GROUP_COUNT ||
    !groups.every((group) => IPV6_GROUP_RE.test(group))
  ) {
    return null;
  }
  return groups.map((group) => Number.parseInt(group, HEX_RADIX));
}

/** One half of a `::`-compressed address as its groups; empty for an empty half. */
function splitGroups(half: string): string[] {
  return half === "" ? [] : half.split(":");
}

/**
 * `address` with a trailing dotted quad rewritten as the two hex groups it
 * occupies, so one parser handles both spellings. Null when the quad is not a
 * valid IPv4 address, which makes the whole address unparseable.
 */
function withoutTrailingQuad(address: string): string | null {
  const quad = IPV6_TRAILING_IPV4_RE.exec(address);
  if (!quad) {
    return address;
  }
  const octets = [quad[1], quad[2], quad[3], quad[4]].map(Number);
  if (octets.some((octet) => octet > 255)) {
    return null;
  }
  const high = octets[0] * BYTE_RANGE + octets[1];
  const low = octets[2] * BYTE_RANGE + octets[3];
  return `${address.slice(0, quad.index)}${high.toString(HEX_RADIX)}:${low.toString(HEX_RADIX)}`;
}

/**
 * The ORG-facing base-URL rule. Four conditions, all of which must hold:
 * https://, a host that is not internal to the deployment, no query string or
 * fragment, and no userinfo.
 *
 * It is deliberately STRICTER than {@link isSecureOrLoopbackHttpUrl}, and the
 * difference is the threat model, not an oversight. The env var is set by
 * whoever operates the deployment, so pointing it at loopback is that
 * operator's own choice about their own host. A base URL submitted through the
 * Integrations screen is attacker-reachable input from any org admin, and
 * honoring an internal target there would let a TENANT drive server-side
 * requests — carrying an `Authorization: Token` header — at the deployment's own
 * loopback interface, its private network, or the cloud metadata endpoint.
 *
 * THE SCHEME CHECK IS NOT THE SSRF DEFENCE, and this docstring used to imply it
 * was (#6030, davetho): refusing plaintext http:// stops CLEARTEXT, and says
 * nothing about the destination, so `https://127.0.0.1:8000/api` passed. The
 * host rule is {@link isInternalHost}, whose docstring states exactly what it
 * covers and the DNS-resolution case it does not.
 *
 * Internal hosts remain reachable for self-hosted deployments through the env
 * var, which is unchanged; the capability is not removed, it stays where the
 * operator, not a tenant, controls it. That is the same position the http://
 * loopback exemption already took.
 *
 * Neither the userinfo rule nor the host rule is retrofitted onto the env
 * predicate, for the same reason the token-shape check is not: an operator
 * whose deployment boots today would start failing at boot, and their value is
 * never disclosed by an API response the way a stored org row is.
 */
export function isSecureHttpsUrl(value: string): boolean {
  const parsed = parseUrl(value);
  if (!parsed) {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    !isInternalHost(parsed.hostname) &&
    !hasQueryOrFragment(parsed) &&
    !hasUrlCredentials(parsed)
  );
}

/** One org's stored Pensero configuration, as read back from the database. */
export type PenseroOrganizationCredential = {
  token: string;
  baseUrl?: string | null;
};

/** A fully-resolved credential, ready for the Pensero client to use. */
export type PenseroResolvedCredential = {
  token: string;
  baseUrl: string;
  tokenSource: PenseroCredentialSource;
  baseUrlSource: PenseroCredentialSource;
};

/**
 * Resolve the credential the Pensero client should use for one organization.
 *
 * ## Precedence: the org row WINS, the env var is the deployment-wide default
 *
 * An org that has configured a credential on the Integrations screen has
 * stated an explicit intent about which Pensero account its numbers come from,
 * and a deployment-wide value must not silently override it. The env var is
 * retained rather than retired because it is what single-tenant and self-hosted
 * deployments configure today: an org with no row keeps working unchanged.
 *
 * ## Token and base URL resolve on INDEPENDENT axes
 *
 * They answer different questions — the token is WHO, the base URL is WHERE —
 * so an org that sets only a token on a self-hosted deployment still reaches
 * that deployment's Pensero (`env` base URL) rather than being silently
 * redirected to the public `pensero.ai`. Falling back per-field is what makes
 * "set my own token" mean only that.
 *
 * ## No credential is a clean no-op, not a boot failure
 *
 * With neither source configured this returns `null` rather than throwing, so
 * an unconfigured deployment stays unconfigured and the client raises a clear
 * error at CALL time. That property predates this ticket and is preserved
 * deliberately.
 */
export function resolvePenseroCredential(input: {
  organization?: PenseroOrganizationCredential | null;
  env?: { token?: string | null; baseUrl?: string | null } | null;
}): PenseroResolvedCredential | null {
  // Normalize BEFORE choosing, so the value and its source label are decided by
  // the same test. Picking the value with `??` while labelling it by truthiness
  // disagrees on the empty string: `base_url = ''` would win as the value while
  // being reported as having come from the environment — the confident-but-wrong
  // attribution `PenseroCredentialSource.Default` exists to prevent. An empty
  // string is not a configured value, so it is absent everywhere or nowhere.
  const orgToken = blankToUndefined(input.organization?.token);
  const envToken = blankToUndefined(input.env?.token);

  const token = orgToken ?? envToken;
  if (!token) {
    return null;
  }

  const orgBaseUrl = blankToUndefined(input.organization?.baseUrl);
  const envBaseUrl = blankToUndefined(input.env?.baseUrl);

  return {
    token,
    baseUrl: orgBaseUrl ?? envBaseUrl ?? DEFAULT_PENSERO_BASE_URL,
    tokenSource: orgToken
      ? PenseroCredentialSource.Organization
      : PenseroCredentialSource.Environment,
    baseUrlSource: resolveBaseUrlSource(orgBaseUrl, envBaseUrl),
  };
}

/** Which source supplied the base URL, distinguishing the built-in default. */
function resolveBaseUrlSource(
  orgBaseUrl: string | null | undefined,
  envBaseUrl: string | null | undefined
): PenseroCredentialSource {
  if (orgBaseUrl) {
    return PenseroCredentialSource.Organization;
  }
  if (envBaseUrl) {
    return PenseroCredentialSource.Environment;
  }
  return PenseroCredentialSource.Default;
}

/** Treat an empty/blank string as "not configured", like an absent field. */
function blankToUndefined(
  value: string | null | undefined
): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}

/** Parse `value` as an absolute URL, returning null when it is not one. */
function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * Path of the delivery collection, relative to the configured base.
 *
 * Declared HERE, in the dependency-free contract module, rather than beside the
 * request builder that appends it: `./delivery-client` is `server-only`, so the
 * write-time validator cannot import from it, and a validator that restated
 * this string would be free to disagree with the client about what actually
 * gets appended to a base. `./delivery-client` imports this one.
 */
export const PENSERO_DELIVERY_PATH = "/v1/delivery";

/** One-or-more trailing slashes on a base URL path, for normalization. */
const TRAILING_SLASHES_RE = /\/+$/;

/**
 * Does this base URL already END with the delivery endpoint path (ISS-9689)?
 *
 * ## The incident this is the whole fix for
 *
 * An org admin pasted the FULL request URL —
 * `https://pensero.ai/api/v1/delivery` — into the base-URL field. Every one of
 * `isSecureHttpsUrl`'s four rules passed, because not one of them looks at the
 * path. `resolveDeliveryUrl` then appended its own `/v1/delivery` and the daily
 * cron spent eleven days requesting
 * `https://pensero.ai/api/v1/delivery/v1/delivery` and reporting `404
 * (basePathSegments=3)` — three being `api`, `v1`, `delivery`, the fingerprint
 * of exactly this paste.
 *
 * ## Why this specific check, and not a path-shape rule
 *
 * "Reject a multi-segment path" would have caught this incident and broken
 * every legitimate tenant deployment with it —
 * `https://tenant.example/private/customer-42` is two segments and correct.
 * This rule is narrower and provable: appending `PENSERO_DELIVERY_PATH` to a
 * base that already ends in `PENSERO_DELIVERY_PATH` can only ever produce a
 * doubled path, so such a base cannot be right for ANY deployment. It needs no
 * network call, no timeout, and no judgement about what a host might serve.
 *
 * Matched on the whole segment run including its leading slash, so a base that
 * merely CONTAINS similar words (`…/v1/delivery-hub/api`, `…/api/v1/deliveries`,
 * `…/somethingv1/delivery`) is not caught. Trailing slashes are stripped first
 * because `resolveDeliveryUrl` strips them too — `…/v1/delivery/` doubles just
 * the same.
 *
 * CASE-SENSITIVE, and that is load-bearing rather than an oversight (whitlockk,
 * #6791). URL paths are case-sensitive, and the client appends the lowercase
 * `PENSERO_DELIVERY_PATH` verbatim — so a base ending `/api/V1/Delivery`
 * resolves to `/api/V1/Delivery/v1/delivery`, which is NOT the doubled path
 * this rule exists to block. It is a different, non-doubled route that some
 * tenant may legitimately serve. Folding case here would refuse a base that
 * works, which is a strictly worse failure than the one being fixed.
 */
export function baseUrlDuplicatesDeliveryPath(value: string): boolean {
  const parsed = parseUrl(value);
  if (!parsed) {
    return false;
  }
  return parsed.pathname
    .replace(TRAILING_SLASHES_RE, "")
    .endsWith(PENSERO_DELIVERY_PATH);
}
