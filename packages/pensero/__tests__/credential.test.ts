import { describe, expect, it } from "vitest";
import {
  baseUrlDuplicatesDeliveryPath,
  DEFAULT_PENSERO_BASE_URL,
  isInternalHost,
  isPenseroTokenShape,
  isSecureHttpsUrl,
  isSecureOrLoopbackHttpUrl,
  PENSERO_DELIVERY_PATH,
  PenseroCredentialSource,
  resolvePenseroCredential,
} from "../credential";

/**
 * Synthetic credentials. These are fixtures, not secrets — but assertions below
 * still compare BOOLEANS rather than using `not.toContain(token)`, because a
 * containment matcher renders its subject into stdout and the HTML report on
 * failure, which is the wrong habit to encode in a credential test.
 */
const ORG_TOKEN = "tk_orgpublic:sk_orgsecret";
const ENV_TOKEN = "tk_envpublic:sk_envsecret";

describe("isPenseroTokenShape", () => {
  it("accepts a tk_<public>:sk_<secret> credential", () => {
    expect(isPenseroTokenShape(ORG_TOKEN)).toBe(true);
  });

  it.each([
    ["missing the sk_ half", "tk_onlypublic"],
    ["missing the tk_ half", "sk_onlysecret"],
    ["halves swapped", "sk_secret:tk_public"],
    ["empty", ""],
    ["a bare word", "not-a-token"],
  ])("rejects a token %s", (_label, value) => {
    expect(isPenseroTokenShape(value)).toBe(false);
  });

  /**
   * Anchoring is load-bearing, not cosmetic: an unanchored pattern would accept
   * a pasted token carrying a trailing newline, which becomes header injection
   * once it reaches `Authorization: Token <token>`.
   */
  it.each([
    ["leading whitespace", ` ${ORG_TOKEN}`],
    ["trailing whitespace", `${ORG_TOKEN} `],
    ["an embedded newline", `${ORG_TOKEN}\nX-Injected: 1`],
    ["a trailing newline", `${ORG_TOKEN}\n`],
  ])("rejects a token with %s", (_label, value) => {
    expect(isPenseroTokenShape(value)).toBe(false);
  });
});

describe("isSecureOrLoopbackHttpUrl (env var rule)", () => {
  it("accepts https", () => {
    expect(isSecureOrLoopbackHttpUrl("https://pensero.ai/api")).toBe(true);
  });

  it.each([
    ["http://localhost:8000/api"],
    ["http://127.0.0.1:8000/api"],
    ["http://[::1]:8000/api"],
  ])("accepts plaintext loopback %s for local development", (value) => {
    expect(isSecureOrLoopbackHttpUrl(value)).toBe(true);
  });

  it("rejects plaintext http to a non-loopback host", () => {
    expect(isSecureOrLoopbackHttpUrl("http://pensero.ai/api")).toBe(false);
  });

  it("rejects a value that is not an absolute URL", () => {
    expect(isSecureOrLoopbackHttpUrl("/api")).toBe(false);
  });
});

describe("isSecureHttpsUrl (org-supplied rule)", () => {
  it("accepts https", () => {
    expect(isSecureHttpsUrl("https://pensero.example.com/api")).toBe(true);
  });

  /**
   * The whole point of the second predicate. An org admin submitting a loopback
   * URL would otherwise drive server-side requests at the deployment's own
   * loopback interface — SSRF from a settings form. The env var keeps its
   * loopback exemption; tenant input does not get one.
   */
  it.each([
    ["http://localhost:8000/api"],
    ["http://127.0.0.1:8000/api"],
    ["http://[::1]:8000/api"],
  ])("rejects loopback %s that the env-var rule would accept", (value) => {
    expect(isSecureOrLoopbackHttpUrl(value)).toBe(true);
    expect(isSecureHttpsUrl(value)).toBe(false);
  });

  it("rejects plaintext http to a non-loopback host", () => {
    expect(isSecureHttpsUrl("http://pensero.ai/api")).toBe(false);
  });

  /**
   * #6030 (davetho). The https rule is NOT the SSRF defence — it stops
   * cleartext and says nothing about the destination, so every one of these
   * used to pass a protocol-only check while the docstring claimed loopback was
   * handled. A tenant that can name the host aims the deployment's own
   * server — carrying an `Authorization: Token` header — at loopback, the
   * private network, or the cloud metadata endpoint.
   *
   * The first assertion in each case is the positive sibling: a PUBLIC https
   * host with the same shape is still accepted, so these are not passing
   * because https itself is being refused.
   */
  it.each([
    ["loopback by name over https", "https://localhost:8000/api"],
    ["a reserved .localhost name", "https://pensero.localhost/api"],
    ["loopback by v4 address over https", "https://127.0.0.1:8000/api"],
    ["another address in 127.0.0.0/8", "https://127.1.2.3/api"],
    ["v6 loopback over https", "https://[::1]:8000/api"],
    ["the unspecified v4 address", "https://0.0.0.0/api"],
    ["an RFC 1918 10/8 address", "https://10.0.1.5/api"],
    ["an RFC 1918 172.16/12 address", "https://172.20.3.4/api"],
    ["an RFC 1918 192.168/16 address", "https://192.168.1.1/api"],
    ["a CGNAT 100.64/10 address", "https://100.100.0.1/api"],
    ["the cloud metadata endpoint", "https://169.254.169.254/api"],
    ["the GCP metadata name", "https://metadata.google.internal/api"],
    ["an mDNS .local name", "https://pensero.local/api"],
    ["a v6 unique-local address", "https://[fd00::1]/api"],
    ["a v6 link-local address", "https://[fe80::1]/api"],
    // RFC 3879 deprecated the site-local range; it did not stop deployments
    // routing it. It has never been globally routable, so no legitimate tenant
    // Pensero can live there, and calling it public was the last way an IPv6
    // first-group check named an internal destination external (codex bot).
    ["a v6 site-local address", "https://[fec0::1]/api"],
    ["the top of the v6 site-local range", "https://[feff::1]/api"],
    // `new URL()` normalizes this to `[::ffff:a00:105]`, so a check that only
    // looks for the DOTTED spelling finds nothing and lets it through.
    ["an IPv4-mapped private v6 address", "https://[::ffff:10.0.1.5]/api"],
    ["an IPv4-mapped loopback v6 address", "https://[::ffff:127.0.0.1]/api"],
    // ISS-9690. The other three ways an IPv6 address CARRIES an IPv4 one and is
    // delivered to it: the RFC 6052 well-known NAT64 prefix (routed by any
    // DNS64/NAT64 gateway, which is the ordinary shape of an IPv6-only
    // serverless subnet), RFC 3056 6to4, and RFC 4291's deprecated
    // IPv4-compatible form. A first-group check calls all three public.
    ["a NAT64-embedded private address", "https://[64:ff9b::a00:1]/api"],
    ["a NAT64-embedded metadata endpoint", "https://[64:ff9b::a9fe:a9fe]/api"],
    ["a 6to4-embedded private address", "https://[2002:a00:1::]/api"],
    ["a 6to4-embedded loopback address", "https://[2002:7f00:1::1]/api"],
    ["an IPv4-compatible private address", "https://[::a00:105]/api"],
    // RFC 2765's IPv4-TRANSLATED form, which carries the same `ffff` marker as
    // the mapped form one group EARLIER — so a check anchored on group 5 alone
    // calls it public while a SIIT translator delivers it to the IPv4 host.
    ["an IPv4-translated private address", "https://[::ffff:0:10.0.1.5]/api"],
    ["an IPv4-translated loopback address", "https://[::ffff:0:127.0.0.1]/api"],
    [
      "an IPv4-translated metadata endpoint",
      "https://[::ffff:0:169.254.169.254]/api",
    ],
    // Decimal, hex and shorthand IPv4 spellings, which `new URL()` normalizes
    // to a dotted quad before this predicate ever sees them.
    ["loopback written as a decimal integer", "https://2130706433/api"],
    ["loopback written in hex", "https://0x7f000001/api"],
    ["loopback in dotted-shorthand", "https://127.1/api"],
  ])("rejects %s", (_label, value) => {
    expect(isSecureHttpsUrl("https://pensero.ai/api")).toBe(true);
    expect(isSecureHttpsUrl(value)).toBe(false);
  });

  /**
   * The boundary cases the range checks must NOT over-reject. Without these,
   * `isInternalHost` could return true for everything and every case above
   * would still pass.
   */
  it.each([
    ["the address just below 10/8", "https://9.255.255.255/api"],
    ["the address just above 10/8", "https://11.0.0.1/api"],
    ["the address just below 172.16/12", "https://172.15.0.1/api"],
    ["the address just above 172.16/12", "https://172.32.0.1/api"],
    ["the address just below 100.64/10", "https://100.63.0.1/api"],
    ["the address just above 100.64/10", "https://100.128.0.1/api"],
    ["a public 169.253 address", "https://169.253.0.1/api"],
    ["a public 192.167 address", "https://192.167.1.1/api"],
    ["a host merely CONTAINING localhost", "https://localhost.pensero.ai/api"],
    ["a public v6 address", "https://[2606:4700::1111]/api"],
    ["an IPv4-mapped PUBLIC v6 address", "https://[::ffff:8.8.8.8]/api"],
    // The embedded-IPv4 forms are DECODED, not banned wholesale: a NAT64 or
    // 6to4 route to a public host is a legitimate way to reach a provider.
    ["a NAT64-embedded PUBLIC address", "https://[64:ff9b::808:808]/api"],
    ["a 6to4-embedded PUBLIC address", "https://[2002:5db8:d822::1]/api"],
    ["an IPv4-translated PUBLIC address", "https://[::ffff:0:8.8.8.8]/api"],
    ["the v6 address just below fc00::/7", "https://[fbff::1]/api"],
    // Was `fec0::1` — the address "just above fe80::/10" — until `fec0::/10`
    // was itself classified internal. The over-rejection guard the row exists
    // for moves to the gap BELOW link-local, which is still genuinely public.
    ["the v6 address just below fe80::/10", "https://[fe7f::1]/api"],
  ])("still accepts %s", (_label, value) => {
    expect(isSecureHttpsUrl(value)).toBe(true);
  });

  /**
   * What the predicate does NOT do, pinned so the next reader does not take it
   * for a complete SSRF defence: it never resolves DNS, so a PUBLIC hostname
   * whose A record points into the private range is accepted here.
   *
   * That gap is closed at REQUEST time by `../pinned-egress`, which resolves
   * once, refuses any internal answer, and dials the address it validated
   * (ISS-9690) — see `./pinned-egress.test.ts`. This case stays because the
   * write-time predicate's own contract is unchanged: it is the literal-host
   * layer, and a reader who mistakes it for the whole defence would remove the
   * pin as redundant.
   */
  it("does not resolve DNS, so a public name for a private address is accepted", () => {
    expect(isSecureHttpsUrl("https://internal-pensero.example.com/api")).toBe(
      true
    );
  });

  it("rejects a value that is not an absolute URL", () => {
    expect(isSecureHttpsUrl("pensero.ai/api")).toBe(false);
  });

  /**
   * #6030 (tamsinb). `base_url` is stored in PLAINTEXT and handed back by
   * `GET /settings/pensero` to every member of the org, not only admins — so a
   * URL carrying userinfo turns the endpoint field into an unencrypted,
   * org-readable secret store, which is exactly what the token column's KMS
   * encryption and write-only treatment exist to prevent.
   *
   * The first assertion is the positive sibling: the same host and path without
   * userinfo IS accepted, so these are not passing because the host happens to
   * be rejected for some other reason.
   */
  it.each([
    ["username and password", "https://tk_public:sk_secret@pensero.ai/api"],
    ["a username alone", "https://tk_public@pensero.ai/api"],
    ["an empty username and a password", "https://:sk_secret@pensero.ai/api"],
  ])("rejects an https base URL carrying %s", (_label, value) => {
    expect(isSecureHttpsUrl("https://pensero.ai/api")).toBe(true);
    expect(isSecureHttpsUrl(value)).toBe(false);
  });

  /**
   * The credentials would not even reach Pensero: `resolveDeliveryMetricsUrl`
   * rebuilds the request URL from `origin + pathname`, and `URL.origin` excludes
   * userinfo. So the value is disclosed to every org member and then dropped —
   * which is why rejecting is right and silently stripping is not (a stripped
   * value would show the admin an endpoint they never typed).
   */
  it("would have dropped the userinfo before any request, so storing it only disclosed it", () => {
    expect(new URL("https://tk_public:sk_secret@pensero.ai/api").origin).toBe(
      "https://pensero.ai"
    );
  });
});

describe("isInternalHost literal parsing edges", () => {
  it("treats a dotted quad with an octet past 255 as internal", () => {
    expect(isInternalHost("999.1.1.1")).toBe(true);
    expect(isInternalHost("8.8.8.8")).toBe(false);
  });

  it("parses an uncompressed eight-group IPv6 address", () => {
    expect(isInternalHost("fd00:0:0:0:0:0:0:1")).toBe(true);
    expect(isInternalHost("2001:4860:0:0:0:0:0:8888")).toBe(false);
  });

  it("treats an IPv6 literal with two `::` as unparseable, so not internal", () => {
    // pins current behavior; looks odd because an unparseable fd00 literal
    // answers "not internal" — the null contract in ipv6Groups says so.
    expect(isInternalHost("fd00::1::2")).toBe(false);
    // Not a redundant second example. Without the `halves.length > 2` guard,
    // fd00::1::2 parses to one group and the length check still answers null.
    // This eight-group head is the only literal that would parse and flip to
    // true, so it alone pins the guard.
    expect(isInternalHost("fd00:0:0:0:0:0:0:1::2::3")).toBe(false);
  });

  it("treats a compressed IPv6 literal with more than eight groups as unparseable", () => {
    expect(isInternalHost("fd00:1:2:3:4:5:6:7::8")).toBe(false);
  });

  it("treats an IPv6 literal with a non-hex or missing group as unparseable", () => {
    expect(isInternalHost("fd00::zzzz")).toBe(false);
    expect(isInternalHost("fd00:1:2:3:4:5:6")).toBe(false);
  });

  it("reads a valid trailing dotted quad but rejects one with an octet past 255", () => {
    expect(isInternalHost("::ffff:10.0.0.1")).toBe(true);
    expect(isInternalHost("::ffff:10.0.0.255")).toBe(true);
    expect(isInternalHost("::ffff:172.16.0.1")).toBe(true);
    // pins current behavior; looks odd because it disagrees with the bare
    // quad: 999.1.1.1 answers internal (isInternalIpv4 fails closed), but the
    // same bad octet inside a v6 literal answers public (ipv6Groups fails
    // open). A human has to rule which one is right. `new URL` rejects
    // [::ffff:999.0.0.1], so only a direct caller of isInternalHost reaches it.
    expect(isInternalHost("::ffff:999.0.0.1")).toBe(false);
    // 9.256 would otherwise carry into 10.0.0.1, a private address.
    expect(isInternalHost("::ffff:9.256.0.1")).toBe(false);
  });
});

describe("resolvePenseroCredential", () => {
  it("returns null when neither source is configured, so an unconfigured deployment stays a clean no-op", () => {
    expect(resolvePenseroCredential({})).toBeNull();
    expect(
      resolvePenseroCredential({ organization: null, env: { token: null } })
    ).toBeNull();
  });

  it("uses the env credential when the org has no row", () => {
    const resolved = resolvePenseroCredential({
      env: { token: ENV_TOKEN, baseUrl: "https://env.example.com/api" },
    });

    expect(resolved?.token).toBe(ENV_TOKEN);
    expect(resolved?.baseUrl).toBe("https://env.example.com/api");
    expect(resolved?.tokenSource).toBe(PenseroCredentialSource.Environment);
  });

  /** The precedence decision this ticket had to STATE: the org row wins. */
  it("prefers the org token over the env token when both exist", () => {
    const resolved = resolvePenseroCredential({
      organization: { token: ORG_TOKEN },
      env: { token: ENV_TOKEN },
    });

    expect(resolved?.token).toBe(ORG_TOKEN);
    expect(resolved?.tokenSource).toBe(PenseroCredentialSource.Organization);
  });

  it("prefers the org base URL over the env base URL when both exist", () => {
    const resolved = resolvePenseroCredential({
      organization: {
        token: ORG_TOKEN,
        baseUrl: "https://org.example.com/api",
      },
      env: { token: ENV_TOKEN, baseUrl: "https://env.example.com/api" },
    });

    expect(resolved?.baseUrl).toBe("https://org.example.com/api");
    expect(resolved?.baseUrlSource).toBe(PenseroCredentialSource.Organization);
  });

  /**
   * Token and base URL resolve on independent axes. An org that sets only a
   * token on a self-hosted deployment must still reach that deployment's
   * Pensero, not be silently redirected to the public host.
   */
  it("keeps the env base URL when the org supplies only a token", () => {
    const resolved = resolvePenseroCredential({
      organization: { token: ORG_TOKEN },
      env: { token: ENV_TOKEN, baseUrl: "https://selfhosted.example.com/api" },
    });

    expect(resolved?.token).toBe(ORG_TOKEN);
    expect(resolved?.tokenSource).toBe(PenseroCredentialSource.Organization);
    expect(resolved?.baseUrl).toBe("https://selfhosted.example.com/api");
    expect(resolved?.baseUrlSource).toBe(PenseroCredentialSource.Environment);
  });

  it("treats an explicitly null org base URL as inheriting, not as clearing to the built-in default", () => {
    const resolved = resolvePenseroCredential({
      organization: { token: ORG_TOKEN, baseUrl: null },
      env: { token: ENV_TOKEN, baseUrl: "https://selfhosted.example.com/api" },
    });

    expect(resolved?.baseUrl).toBe("https://selfhosted.example.com/api");
  });

  /**
   * The value and its source label must be decided by the SAME test. Choosing
   * the value with `??` while labelling it by truthiness disagrees exactly here:
   * an empty stored `base_url` would win as the value while being reported as
   * having come from somewhere else — a confident-but-wrong attribution, and a
   * `baseUrl` that is neither usable nor the default the label promises.
   */
  it("treats a blank stored base URL as absent rather than as an org-supplied value", () => {
    const resolved = resolvePenseroCredential({
      organization: { token: ORG_TOKEN, baseUrl: "   " },
      env: { token: ENV_TOKEN, baseUrl: "https://selfhosted.example.com/api" },
    });

    expect(resolved?.baseUrl).toBe("https://selfhosted.example.com/api");
    expect(resolved?.baseUrlSource).toBe(PenseroCredentialSource.Environment);
  });

  it("treats a blank org token as absent rather than as an unconfigured integration", () => {
    const resolved = resolvePenseroCredential({
      organization: { token: "   " },
      env: { token: ENV_TOKEN },
    });

    expect(resolved?.token).toBe(ENV_TOKEN);
    expect(resolved?.tokenSource).toBe(PenseroCredentialSource.Environment);
  });

  it("rejects an https base URL carrying a query string or fragment", () => {
    expect(isSecureHttpsUrl("https://pensero.example.com/api")).toBe(true);
    expect(isSecureHttpsUrl("https://pensero.example.com/api?x=1")).toBe(false);
    expect(isSecureHttpsUrl("https://pensero.example.com/api#frag")).toBe(
      false
    );
  });

  /**
   * The built-in default is reported as its OWN source. Labelling it
   * `Environment` would claim the environment set a value it never set.
   */
  it("falls back to the built-in default base URL and says so", () => {
    const resolved = resolvePenseroCredential({
      organization: { token: ORG_TOKEN },
    });

    expect(resolved?.baseUrl).toBe(DEFAULT_PENSERO_BASE_URL);
    expect(resolved?.baseUrlSource).toBe(PenseroCredentialSource.Default);
    expect(resolved?.baseUrlSource).not.toBe(
      PenseroCredentialSource.Environment
    );
  });
});

/**
 * ISS-9689 — the production incident, in one predicate.
 *
 * An org admin pasted the FULL request URL into the base-URL field. All four of
 * `isSecureHttpsUrl`'s rules passed, because not one looks at the path, and the
 * daily cron then requested `https://pensero.ai/api/v1/delivery/v1/delivery`
 * for eleven consecutive days: `daysFailed=11 rows=0`,
 * `dominantFailure="… 404 … basePathSegments=3"`.
 */
describe("baseUrlDuplicatesDeliveryPath", () => {
  it("catches the exact value the incident org had stored", () => {
    expect(
      baseUrlDuplicatesDeliveryPath(
        `${DEFAULT_PENSERO_BASE_URL}${PENSERO_DELIVERY_PATH}`
      )
    ).toBe(true);
    // Spelled out too, so a change to either constant cannot quietly make the
    // composed case above stop describing the value that actually broke.
    expect(
      baseUrlDuplicatesDeliveryPath("https://pensero.ai/api/v1/delivery")
    ).toBe(true);
  });

  it("catches the trailing-slash spellings of the same paste", () => {
    // `resolveDeliveryUrl` strips trailing slashes before appending, so
    // `…/v1/delivery/` doubles exactly the same way the bare form does.
    expect(
      baseUrlDuplicatesDeliveryPath("https://pensero.ai/api/v1/delivery/")
    ).toBe(true);
    expect(
      baseUrlDuplicatesDeliveryPath("https://pensero.ai/api/v1/delivery///")
    ).toBe(true);
  });

  /**
   * whitlockk (#6791). URL paths are CASE-SENSITIVE, and the client appends the
   * lowercase path verbatim, so `…/api/V1/Delivery` resolves to
   * `…/api/V1/Delivery/v1/delivery` — a different, non-doubled route a tenant
   * may legitimately serve, not the failure this rule blocks. Folding case
   * would refuse a base that works.
   *
   * Pinned as an ACCEPTED case rather than deleted, so the narrowing is a
   * stated contract and not an absence someone re-widens by reflex.
   */
  it("leaves a case-varying path alone, because it does NOT double", () => {
    expect(
      baseUrlDuplicatesDeliveryPath("https://pensero.ai/api/V1/Delivery")
    ).toBe(false);
    expect(
      baseUrlDuplicatesDeliveryPath("https://pensero.ai/api/v1/Delivery")
    ).toBe(false);
    // The lowercase sibling is what separates this from "accepts everything".
    expect(
      baseUrlDuplicatesDeliveryPath("https://pensero.ai/api/v1/delivery")
    ).toBe(true);
  });

  /**
   * THE OVER-REACH GUARD, and the reason this is not a path-shape heuristic.
   * `https://tenant.example/private/customer-42` is two segments and entirely
   * legitimate; a rule that refused multi-segment paths would have fixed this
   * incident by breaking every tenant deployment.
   */
  it.each([
    ["the canonical base", DEFAULT_PENSERO_BASE_URL],
    ["a two-segment tenant base", "https://tenant.example/private/customer-42"],
    ["a base with no path at all", "https://pensero.ai"],
    ["a similar segment elsewhere", "https://pensero.ai/v1/delivery-hub/api"],
    ["a pluralized lookalike", "https://pensero.ai/api/v1/deliveries"],
    ["an unseparated lookalike", "https://pensero.ai/somethingv1/delivery"],
    ["the endpoint's tail alone", "https://pensero.ai/api/delivery"],
  ])("leaves %s alone", (_label, value) => {
    expect(baseUrlDuplicatesDeliveryPath(value)).toBe(false);
  });

  it("does not throw on a value that is not a URL at all", () => {
    // It runs beside `isSecureHttpsUrl` in the same schema, so it is reached
    // with whatever the client sent, not only with parseable URLs.
    expect(baseUrlDuplicatesDeliveryPath("not a url")).toBe(false);
    expect(baseUrlDuplicatesDeliveryPath("/v1/delivery")).toBe(false);
  });
});
