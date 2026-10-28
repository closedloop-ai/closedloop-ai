/**
 * ISS-9690: the pinned-IP egress guard for credentialed Pensero fetches.
 *
 * `isSecureHttpsUrl` refuses an internal target by reading the LITERAL host
 * string and never resolves DNS, so a public hostname whose A record points
 * inward passed write-time validation and the daily sweep then fetched it with
 * the organization's credential attached. These cases drive the production
 * `lookup` function the transport's socket is actually created with — the point
 * at which a destination address enters a connection — against synthetic DNS
 * answers.
 *
 * THE BLOCKED AND ALLOWED ADDRESSES BELOW ARE WRITTEN INDEPENDENTLY of the
 * range predicate under test. That duplication is the test: a table derived
 * from `isInternalHost` would agree with any implementation of it, including a
 * broken one.
 */

import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockDnsLookup } = vi.hoisted(() => ({ mockDnsLookup: vi.fn() }));

vi.mock("node:dns", () => ({ lookup: mockDnsLookup }));

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { log } from "@repo/observability/log";
import {
  EGRESS_LOG_TAG,
  EgressBlockedError,
  EgressBlockReason,
  PenseroEgressTransportError,
  pinnedFetch,
  pinnedLookup,
  responseFromIncomingMessage,
} from "../pinned-egress";

/** A public hostname an org admin could legitimately store and have accepted. */
const TENANT_HOST = "pensero.tenant-supplied.example";

/**
 * RFC 5737 TEST-NET-1. Public as far as the range predicate is concerned, so
 * the guard must let it through, and guaranteed never routed, so a case that
 * reaches it cannot touch a real host.
 */
const UNROUTABLE_PUBLIC_ADDRESS = "192.0.2.1";

/** IPv4 family constant, spelled out rather than imported from the subject. */
const IPV4 = 4;
const IPV6 = 6;

/**
 * Addresses a resolved name must never be dialled at, written from RFC numbers
 * rather than read from the predicate: loopback, "this network", the RFC 1918
 * blocks, CGNAT, link-local including the cloud metadata endpoint, and the IPv6
 * equivalents plus the IPv4-mapped spellings of the same blocks.
 */
const BLOCKED_ANSWERS: readonly (readonly [string, string, number])[] = [
  ["loopback", "127.0.0.1", IPV4],
  ["elsewhere in 127/8", "127.9.9.9", IPV4],
  ["the unspecified address", "0.0.0.0", IPV4],
  ["RFC 1918 10/8", "10.0.1.5", IPV4],
  ["RFC 1918 172.16/12", "172.20.3.4", IPV4],
  ["RFC 1918 192.168/16", "192.168.1.1", IPV4],
  ["RFC 6598 CGNAT 100.64/10", "100.100.0.1", IPV4],
  ["the cloud metadata endpoint", "169.254.169.254", IPV4],
  ["IPv6 loopback", "::1", IPV6],
  ["the IPv6 unspecified address", "::", IPV6],
  ["an IPv6 unique-local address", "fd00::1", IPV6],
  ["an IPv6 link-local address", "fe80::1", IPV6],
  ["an IPv4-mapped private address", "::ffff:10.0.1.5", IPV6],
  ["an IPv4-mapped loopback address", "::ffff:127.0.0.1", IPV6],
  // A DNS64 answer on an IPv6-only subnet — the ordinary shape of a modern
  // serverless network. A NAT64 gateway routes this straight to the IPv4 host
  // it embeds, so judging it by its first group calls it public and hands the
  // credential to `10.0.0.1`.
  ["a NAT64-embedded RFC 1918 address", "64:ff9b::a00:1", IPV6],
  ["a NAT64-embedded metadata endpoint", "64:ff9b::169.254.169.254", IPV6],
  // Same trick through a 6to4 relay, where the IPv4 sits in groups 1 and 2.
  ["a 6to4-embedded RFC 1918 address", "2002:a00:1::", IPV6],
  ["a 6to4-embedded loopback address", "2002:7f00:1::1", IPV6],
  // RFC 4291's deprecated IPv4-COMPATIBLE form, which is not the mapped form.
  ["an IPv4-compatible private address", "::10.0.1.5", IPV6],
  // RFC 2765's IPv4-TRANSLATED form, whose `ffff` marker sits one group earlier
  // than the mapped form's — a check anchored on group 5 alone calls it public.
  ["an IPv4-translated private address", "::ffff:0:10.0.1.5", IPV6],
  ["an IPv4-translated metadata endpoint", "::ffff:0:169.254.169.254", IPV6],
  ["a zone-scoped link-local address", "fe80::1%eth0", IPV6],
  // RFC 3879 deprecated site-local; deployments that still route it deliver
  // this to an internal service, and it has never been globally routable.
  ["an IPv6 site-local address", "fec0::1", IPV6],
  ["the top of the IPv6 site-local range", "feff::1", IPV6],
];

/**
 * The boundary cases the guard must NOT over-reject. Without these, refusing
 * every address would satisfy every case above — a guard that blocks all egress
 * is not a guard, it is an outage.
 */
const ALLOWED_ANSWERS: readonly (readonly [string, string, number])[] = [
  ["a public IPv4 address", "93.184.216.34", IPV4],
  ["just below 10/8", "9.255.255.255", IPV4],
  ["just above 10/8", "11.0.0.1", IPV4],
  ["just below 172.16/12", "172.15.0.1", IPV4],
  ["just above 172.16/12", "172.32.0.1", IPV4],
  ["just below 100.64/10", "100.63.0.1", IPV4],
  ["just above 100.64/10", "100.128.0.1", IPV4],
  ["a public 169.253 address", "169.253.0.1", IPV4],
  ["a public IPv6 address", "2606:4700::1111", IPV6],
  ["an IPv4-mapped PUBLIC address", "::ffff:8.8.8.8", IPV6],
  // The embedded-IPv4 forms must be DECODED, not banned wholesale: a NAT64 or
  // 6to4 route to a public host is a legitimate way to reach a provider.
  ["a NAT64-embedded PUBLIC address", "64:ff9b::8.8.8.8", IPV6],
  ["a 6to4-embedded PUBLIC address", "2002:5db8:d822::1", IPV6],
  ["an IPv4-translated PUBLIC address", "::ffff:0:8.8.8.8", IPV6],
  ["a unique-local-adjacent public address", "fe00::1", IPV6],
];

type LookupOutcome = {
  error: Error | null;
  address: string | { address: string; family: number }[];
  family: number | undefined;
};

/** Make the mocked resolver answer `hostname` with `addresses`. */
function answerWith(addresses: readonly (readonly [string, number])[]): void {
  mockDnsLookup.mockImplementation(
    (
      _hostname: string,
      _options: unknown,
      callback: (
        error: Error | null,
        addresses: { address: string; family: number }[]
      ) => void
    ) => {
      callback(
        null,
        addresses.map(([address, family]) => ({ address, family }))
      );
    }
  );
}

/** Was a refusal logged by the egress guard, as opposed to any other failure? */
function loggedAnEgressRefusal(): boolean {
  return vi
    .mocked(log.error)
    .mock.calls.some((call) => String(call[0]).includes(EGRESS_LOG_TAG));
}

/** Drive the production lookup and capture exactly what it hands the connector. */
function runLookup(all: boolean): Promise<LookupOutcome> {
  return new Promise<LookupOutcome>((resolve) => {
    pinnedLookup(TENANT_HOST, { all, family: 0 }, (error, address, family) => {
      resolve({ error, address, family });
    });
  });
}

/** One byte past {@link MAX_RESPONSE_BYTES}, which is 32 MiB. */
const OVERSIZED_BODY_BYTES = 32 * 1024 * 1024 + 1;

/**
 * An `IncomingMessage`-shaped stream carrying a synthetic wire response.
 *
 * `open: true` leaves the stream unended so a case can drive what arrives
 * AFTER the headers — a mid-body socket error, or a body that keeps coming.
 */
function incomingMessage(input: {
  statusCode: number;
  statusMessage?: string;
  headers?: Record<string, string | string[]>;
  body?: string;
  open?: boolean;
}): PassThrough & IncomingMessage {
  const stream = Object.assign(new PassThrough(), {
    statusCode: input.statusCode,
    statusMessage: input.statusMessage ?? "",
    headers: input.headers ?? {},
  });
  if (input.body !== undefined) {
    stream.write(input.body);
  }
  if (!input.open) {
    stream.end();
  }
  return stream as unknown as PassThrough & IncomingMessage;
}

describe("pinnedLookup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    mockDnsLookup.mockReset();
  });

  it.each(BLOCKED_ANSWERS)(
    "refuses a public name resolving to %s",
    async (_label, address, family) => {
      answerWith([[address, family]]);
      const outcome = await runLookup(true);

      expect(outcome.error).toBeInstanceOf(EgressBlockedError);
      expect((outcome.error as EgressBlockedError).reason).toBe(
        EgressBlockReason.InternalAddress
      );
      // Nothing to dial. A guard that reported an error AND still handed the
      // address back would leave the connector free to use it.
      expect(outcome.address).toEqual([]);
    }
  );

  it.each(ALLOWED_ANSWERS)(
    "still dials a legitimate external host at %s",
    async (_label, address, family) => {
      answerWith([[address, family]]);
      const outcome = await runLookup(true);

      expect(outcome.error).toBeNull();
      expect(outcome.address).toEqual([{ address, family }]);
    }
  );

  /**
   * The whole record set is judged, not the first answer. A round-robin set
   * that mixes a public address with an internal one is precisely the shape an
   * attacker submits, and Happy Eyeballs would otherwise try the second address
   * a first-answer-only check never looked at.
   */
  it.each([
    ["internal answer LAST", ["93.184.216.34", "10.0.1.5"]],
    ["internal answer FIRST", ["10.0.1.5", "93.184.216.34"]],
    ["internal answer in the MIDDLE", ["8.8.8.8", "127.0.0.1", "1.1.1.1"]],
  ])("refuses the whole host when the %s is internal", async (_label, set) => {
    answerWith(set.map((address) => [address, IPV4] as const));
    const outcome = await runLookup(true);

    expect(outcome.error).toBeInstanceOf(EgressBlockedError);
    expect(outcome.address).toEqual([]);
  });

  it("fails closed when the name does not resolve", async () => {
    mockDnsLookup.mockImplementation(
      (
        _hostname: string,
        _options: unknown,
        callback: (error: Error | null, addresses: unknown[]) => void
      ) => {
        callback(new Error("getaddrinfo ENOTFOUND"), []);
      }
    );
    const outcome = await runLookup(true);

    expect(outcome.error).toBeInstanceOf(EgressBlockedError);
    expect((outcome.error as EgressBlockedError).reason).toBe(
      EgressBlockReason.Unresolvable
    );
  });

  it("fails closed when the name resolves to nothing", async () => {
    answerWith([]);
    const outcome = await runLookup(true);

    expect(outcome.error).toBeInstanceOf(EgressBlockedError);
    expect((outcome.error as EgressBlockedError).reason).toBe(
      EgressBlockReason.NoAddresses
    );
  });

  /**
   * A connector that asked for ONE address gets one — but the guard still
   * resolved and judged the whole set, which is why `all` is forced on the
   * resolver call regardless of what was asked for.
   */
  it("answers a single-address lookup with one validated address", async () => {
    answerWith([["93.184.216.34", IPV4]]);
    const outcome = await runLookup(false);

    expect(outcome.error).toBeNull();
    expect(outcome.address).toBe("93.184.216.34");
    expect(outcome.family).toBe(IPV4);
    expect(mockDnsLookup).toHaveBeenCalledWith(
      TENANT_HOST,
      expect.objectContaining({ all: true }),
      expect.any(Function)
    );
  });

  it("refuses a single-address lookup whose set contains an internal answer", async () => {
    answerWith([
      ["93.184.216.34", IPV4],
      ["169.254.169.254", IPV4],
    ]);
    const outcome = await runLookup(false);

    expect(outcome.error).toBeInstanceOf(EgressBlockedError);
  });

  /**
   * The thrown reason becomes `PenseroBackfillDay.lastFailureReason` and from
   * there a Slack alert, so it may name neither the org's host nor the address
   * its DNS answered with. The server log is the richer sink and gets the
   * hostname — but not the address, which is either the attacker's chosen
   * pointer or a fragment of the deployment's own network map.
   */
  it("keeps the host and the resolved address out of the reason, and the address out of the log", async () => {
    answerWith([["10.0.1.5", IPV4]]);
    const outcome = await runLookup(true);

    const message = (outcome.error as Error).message;
    expect(message).toContain(EgressBlockReason.InternalAddress);
    expect(message).not.toContain(TENANT_HOST);
    expect(message).not.toContain("10.0.1.5");

    const logged = JSON.stringify(vi.mocked(log.error).mock.calls);
    // The positive half: the log DOES name the host, or an operator cannot tell
    // which organization's configuration is pointing inward.
    expect(logged).toContain(TENANT_HOST);
    expect(logged).not.toContain("10.0.1.5");
  });

  /**
   * The COUNT is the substitute for the addresses this module refuses to log,
   * so it is the only thing that tells "one round-robin answer is poisoned"
   * from "the whole record set is internal". Asserting the key is present would
   * stay green if it reported the set's size instead of the blocked subset's.
   */
  it("reports how many of the record set were blocked, not how many were answered", async () => {
    answerWith([
      ["8.8.8.8", IPV4],
      ["127.0.0.1", IPV4],
      ["1.1.1.1", IPV4],
    ]);
    await runLookup(true);

    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining(EGRESS_LOG_TAG),
      expect.objectContaining({ blockedAddressCount: 1 })
    );
  });
});

describe("pinnedFetch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    mockDnsLookup.mockReset();
  });

  it("refuses a non-https target before opening a socket", async () => {
    answerWith([["93.184.216.34", IPV4]]);

    await expect(
      pinnedFetch(`http://${TENANT_HOST}/api/v1/delivery`)
    ).rejects.toBeInstanceOf(EgressBlockedError);
    expect(mockDnsLookup).not.toHaveBeenCalled();
  });

  /**
   * The end-to-end shape of the fix: a public host, https, that a write-time
   * literal check accepts, whose DNS answer points at the deployment's own
   * loopback. The socket is never connected, so the credential never leaves.
   */
  it("refuses a public https host whose DNS answer is internal", async () => {
    answerWith([["127.0.0.1", IPV4]]);

    await expect(
      pinnedFetch(`https://${TENANT_HOST}/api/v1/delivery`, {
        headers: { "X-Auth-Token": "tk_public:sk_secret" },
      })
    ).rejects.toThrow(EgressBlockReason.InternalAddress);
    expect(mockDnsLookup).toHaveBeenCalledWith(
      TENANT_HOST,
      expect.objectContaining({ all: true }),
      expect.any(Function)
    );
  });

  /**
   * A LITERAL address never goes through the agent's lookup — `net` connects
   * straight to it — so `pinnedLookup` is not reached and the range check would
   * never run (whitlockk, ISS-9690). A base URL that names an internal address
   * directly must therefore be refused HERE, at the point the request is
   * issued, not left to the write-time validator: a row stored before that
   * validator existed still reaches this transport.
   *
   * `mockDnsLookup` not being called is the load-bearing half. It is what proves
   * the refusal came from this check rather than from the resolver path, which
   * a literal address never enters.
   */
  it.each([
    ["loopback", "127.0.0.1", "127.0.0.1"],
    ["an RFC 1918 address", "10.0.1.5", "10.0.1.5"],
    ["the cloud metadata endpoint", "169.254.169.254", "169.254.169.254"],
    // `URL.hostname` keeps these BRACKETED, and `net.isIP("[::1]")` is 0 — not
    // an address. Without the unbracketing the literal branch never fires for
    // an IPv6 base and it is handed to the resolver as a name instead.
    ["IPv6 loopback", "[::1]", "::1"],
    ["an IPv6 unique-local address", "[fd00::1]", "fd00::1"],
  ])(
    "refuses a base URL naming %s directly, without any lookup",
    async (_label, host, loggedHost) => {
      // Answered, but the case asserts it is never consulted: a literal address
      // has nothing to resolve, and a refusal that came from here rather than
      // from the resolver is the whole point.
      answerWith([[UNROUTABLE_PUBLIC_ADDRESS, IPV4]]);

      const thrown = await pinnedFetch(`https://${host}/api/v1/delivery`, {
        headers: { "X-Auth-Token": "tk_public:sk_secret" },
      }).catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(EgressBlockedError);
      expect((thrown as EgressBlockedError).reason).toBe(
        EgressBlockReason.InternalAddress
      );
      expect(mockDnsLookup).not.toHaveBeenCalled();
      expect(log.error).toHaveBeenCalledWith(
        expect.stringContaining(EGRESS_LOG_TAG),
        expect.objectContaining({
          hostname: loggedHost,
          reason: EgressBlockReason.InternalAddress,
        })
      );
    }
  );

  /**
   * The positive sibling. A literal PUBLIC address is a legitimate base, and the
   * literal check must not turn "names an address" into "is refused" — that
   * would make the case above pass for the wrong reason.
   *
   * The IPv6 row carries the second half of the bracket finding (whitlockk,
   * ISS-9690): a bracketed host is handed to the agent as a NAME, so the socket
   * lookup answers ENOTFOUND and a public IPv6 base the write-time validator
   * accepts can never deliver. `mockDnsLookup` staying uncalled is what says the
   * address was recognised as one.
   */
  it.each([
    ["IPv4", UNROUTABLE_PUBLIC_ADDRESS],
    ["IPv6", "[2606:4700::1111]"],
  ])(
    "dials a base URL naming a public %s address directly, without any lookup",
    async (_label, host) => {
      answerWith([[UNROUTABLE_PUBLIC_ADDRESS, IPV4]]);

      const thrown = await pinnedFetch(`https://${host}/api/v1/delivery`, {
        signal: AbortSignal.abort(),
      }).catch((error: unknown) => error);

      expect(thrown).not.toBeInstanceOf(EgressBlockedError);
      expect(loggedAnEgressRefusal()).toBe(false);
      expect(mockDnsLookup).not.toHaveBeenCalled();
    }
  );

  /**
   * The request-level failure path uses the same reduction as the response-level
   * one, so a raw Node error naming the tenant's host or the resolved `ip:port`
   * cannot reach the reason that travels to Slack.
   */
  it("reduces a request-level failure to its code", async () => {
    answerWith([["93.184.216.34", IPV4]]);

    const thrown = await pinnedFetch(`https://${TENANT_HOST}/api/v1/delivery`, {
      signal: AbortSignal.abort(),
    }).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(PenseroEgressTransportError);
    expect((thrown as Error).message).not.toContain(TENANT_HOST);
  });
});

describe("responseFromIncomingMessage", () => {
  it("carries the status, headers and body through", async () => {
    const response = await responseFromIncomingMessage(
      incomingMessage({
        statusCode: 200,
        statusMessage: "OK",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ results: [] }),
      })
    );

    expect(response.ok).toBe(true);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    await expect(response.json()).resolves.toEqual({ results: [] });
  });

  it("preserves a repeated header rather than collapsing it", async () => {
    const response = await responseFromIncomingMessage(
      incomingMessage({
        statusCode: 200,
        headers: { warning: ['199 - "one"', '199 - "two"'] },
      })
    );

    expect(response.headers.get("warning")).toContain("one");
    expect(response.headers.get("warning")).toContain("two");
  });

  /**
   * NEVER FOLLOW A REDIRECT. Following one would dial a location this transport
   * never resolved or validated, which is the hole the pin exists to close —
   * and the request carries `X-Auth-Token`.
   */
  it.each([[301], [302], [303], [307], [308]])(
    "refuses a %i rather than following it",
    async (status) => {
      await expect(
        responseFromIncomingMessage(
          incomingMessage({
            statusCode: status,
            headers: { location: "http://127.0.0.1:8000/v1/delivery" },
          })
        )
      ).rejects.toThrow(EgressBlockReason.RedirectRefused);
    }
  );

  /**
   * 304 is a cache validator, not a redirect. Treating it as one would turn a
   * conditional-request answer into a hard failure, so it comes back as a
   * response — with the null body its status defines.
   */
  it.each([[204], [304]])(
    "returns %i as a null-body response",
    async (status) => {
      const response = await responseFromIncomingMessage(
        incomingMessage({ statusCode: status })
      );

      expect(response.status).toBe(status);
      expect(response.body).toBeNull();
    }
  );

  /**
   * Node's HTTP parser accepts any three-digit status, and the far end is
   * tenant-chosen, so `HTTP/1.1 600` arrives as 600. `new Response(body, {
   * status: 600 })` throws a `RangeError` — and it would throw from inside the
   * `end` listener, an event-emitter callback rather than the promise executor,
   * so it would NOT reject this promise. It would escape as an uncaught
   * exception past the backfill's per-organization error handling and take the
   * rest of the sweep with it (codex bot).
   *
   * Rejecting is the assertion, but `Errors 0` on this file is the other half:
   * the unfixed shape does not fail an assertion, it crashes the worker.
   */
  it.each([
    ["above the representable range", 600],
    ["at the top of the parser's range", 999],
    ["informational, below the range", 100],
    ["absent, defaulted to 0", 0],
  ])(
    "refuses a %s status rather than throwing while building a Response",
    async (_label, status) => {
      const thrown = await responseFromIncomingMessage(
        incomingMessage({ statusCode: status, body: "{}" })
      ).catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(EgressBlockedError);
      expect((thrown as EgressBlockedError).reason).toBe(
        EgressBlockReason.UnrepresentableStatus
      );
    }
  );

  /**
   * The boundaries the refusal must NOT swallow. Without these, refusing every
   * status would satisfy the case above and take every backfill down with it.
   */
  it.each([[200], [599]])(
    "still returns %i, the edge of the representable range",
    async (status) => {
      const response = await responseFromIncomingMessage(
        incomingMessage({ statusCode: status, body: "{}" })
      );

      expect(response.status).toBe(status);
    }
  );

  it("returns a provider error status instead of throwing, so the client can classify it", async () => {
    const response = await responseFromIncomingMessage(
      incomingMessage({ statusCode: 404, body: "Not Found" })
    );

    expect(response.ok).toBe(false);
    expect(response.status).toBe(404);
  });

  /**
   * A transport failure's reason does not stay on the server: it becomes
   * `PenseroBackfillDay.lastFailureReason` and from there a Slack alert. Node's
   * own TLS and connect messages name the tenant's host or the resolved
   * `ip:port` with no scheme and no leading slash, so `sanitizeFailureReason`'s
   * URL passes leave them intact. The `fetch` this transport replaced hid that
   * behind a flat `fetch failed`, so switching to `node:https` would have
   * introduced the leak; the reason is reduced to Node's code instead.
   */
  it("reduces a transport failure to its code, dropping the host it named", async () => {
    const message = incomingMessage({ statusCode: 200, open: true });
    const thrown = responseFromIncomingMessage(message).catch(
      (error: unknown) => error
    );
    message.destroy(
      Object.assign(
        new Error(
          "Hostname/IP does not match certificate's altnames: Host: pensero.tenant-supplied.example. is not in the cert's altnames"
        ),
        { code: "ERR_TLS_CERT_ALTNAME_INVALID" }
      )
    );

    const error = await thrown;
    expect(error).toBeInstanceOf(PenseroEgressTransportError);
    expect((error as Error).message).toContain("ERR_TLS_CERT_ALTNAME_INVALID");
    expect((error as Error).message).not.toContain("pensero.tenant-supplied");
    expect((error as Error).message).not.toContain("altnames");
  });

  /**
   * The far end of this connection is chosen by a tenant, so the body size is
   * attacker-controlled and a buffering client is a memory bound. Refused
   * rather than truncated: a truncated delivery window is indistinguishable
   * from a quiet day.
   */
  it("refuses a response body past the ceiling instead of buffering it", async () => {
    const message = incomingMessage({ statusCode: 200, open: true });
    const thrown = responseFromIncomingMessage(message).catch(
      (error: unknown) => error
    );
    message.write(Buffer.alloc(OVERSIZED_BODY_BYTES));

    const error = await thrown;
    expect(error).toBeInstanceOf(EgressBlockedError);
    expect((error as EgressBlockedError).reason).toBe(
      EgressBlockReason.ResponseTooLarge
    );
  });
});
