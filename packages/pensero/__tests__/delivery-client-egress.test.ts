/**
 * ISS-9690: WHICH transport a credentialed delivery fetch actually leaves on.
 *
 * `packages/pensero/__tests__/pinned-egress.test.ts` proves what the guard
 * decides. This file proves the delivery client — the one function every
 * credentialed Pensero fetch goes through, including the daily multi-tenant
 * sweep — hands a TENANT-supplied base URL to the pinned transport and an
 * OPERATOR-supplied one to the platform's own `fetch`, which is what keeps a
 * self-hosted deployment on a private address working.
 *
 * Nothing here injects `fetchImpl`. That option is the seam the rest of the
 * suite uses to fake a provider, and a test that used it would prove nothing
 * about the transport production picks.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockDnsLookup } = vi.hoisted(() => ({ mockDnsLookup: vi.fn() }));

vi.mock("node:dns", () => ({ lookup: mockDnsLookup }));

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { log } from "@repo/observability/log";
import { PenseroCredentialSource } from "../credential";
import { fetchDeliverySegment } from "../delivery-client";
import { EgressBlockedError, EgressBlockReason } from "../pinned-egress";

const TEST_TOKEN = "tk_public:sk_secret";
/** A public host an org admin could store and have `isSecureHttpsUrl` accept. */
const TENANT_BASE = "https://pensero.tenant-supplied.example/api";
/** The operator's own self-hosted Pensero, on a private address. */
const OPERATOR_BASE = "https://pensero.internal.corp/api";
const IPV4 = 4;
/**
 * RFC 5737 TEST-NET-1: routable-looking, guaranteed never routed. Public as far
 * as the range predicate is concerned, so the guard must let it through — and
 * no packet can reach a real host.
 */
const UNROUTABLE_PUBLIC_ADDRESS = "192.0.2.1";
const EGRESS_LOG_TAG = "[pensero/egress]";

const WINDOW = {
  startDate: "2026-08-01",
  endDate: "2026-08-04",
  teamIdentifiers: ["Engineering"] as const,
};

/** Make the mocked resolver answer every name with `address`. */
function answerWith(address: string): void {
  mockDnsLookup.mockImplementation(
    (
      _hostname: string,
      _options: unknown,
      callback: (
        error: Error | null,
        addresses: { address: string; family: number }[]
      ) => void
    ) => {
      callback(null, [{ address, family: IPV4 }]);
    }
  );
}

/** Was a refusal logged by the egress guard, as opposed to any other failure? */
function loggedAnEgressRefusal(): boolean {
  return vi
    .mocked(log.error)
    .mock.calls.some((call) => String(call[0]).includes(EGRESS_LOG_TAG));
}

describe("fetchDeliverySegment transport selection", () => {
  let globalFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    globalFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          start_date: WINDOW.startDate,
          end_date: WINDOW.endDate,
          users: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", globalFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    mockDnsLookup.mockReset();
  });

  /**
   * THE EXPOSURE, closed. ISS-8761's sweep resolves every organization's stored
   * `baseUrl` and fetches it nightly with that organization's credential.
   * `isSecureHttpsUrl` cleared this host at write time because it reads the
   * literal string and never resolves DNS; the answer points at the
   * deployment's own loopback.
   */
  it("refuses an ORG-supplied base whose DNS answer is internal, before any request", async () => {
    answerWith("127.0.0.1");

    const thrown = await fetchDeliverySegment({
      ...WINDOW,
      credential: {
        token: TEST_TOKEN,
        baseUrl: TENANT_BASE,
        baseUrlSource: PenseroCredentialSource.Organization,
      },
    }).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(EgressBlockedError);
    expect((thrown as EgressBlockedError).reason).toBe(
      EgressBlockReason.InternalAddress
    );
    // The credential never reached a socket, and never reached the platform
    // fetch that would have resolved the name a second time.
    expect(globalFetch).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(log.error).mock.calls)).not.toContain(
      "sk_secret"
    );
  });

  /**
   * The positive sibling of the case above, on the same transport. Without it,
   * a pinned transport that refused EVERYTHING would satisfy the refusal test
   * and take every tenant's nightly backfill down with it.
   *
   * NO SOCKET IS OPENED, and that is structural rather than a matter of timing
   * (codex bot). The resolver mock captures the connector's callback and never
   * answers it, so `net` has no address to dial and cannot reach `connect` at
   * all; the request is then aborted from inside that same mock. The earlier
   * shape — answer with an unroutable address and abort 25 ms later — did dial,
   * which makes the case's outcome depend on the host's routing table: where
   * that connect fails synchronously it throws from inside the resolver
   * callback, which is an emitter frame and not the promise executor, so it
   * escapes as an unhandled error and the file reports `Errors 1` with every
   * test still marked passed.
   *
   * What is asserted is unchanged: the pinned lookup ran, for the tenant's
   * host, judging the whole record set — which is the point at which a public
   * answer would have been let through — and nothing was refused.
   */
  it("hands an ORG-supplied base to the pinned lookup without dialling", async () => {
    const controller = new AbortController();
    let lookupHost: string | undefined;
    let lookupOptions: unknown;
    mockDnsLookup.mockImplementation((hostname: string, options: unknown) => {
      lookupHost = hostname;
      lookupOptions = options;
      controller.abort();
    });

    const thrown = await fetchDeliverySegment({
      ...WINDOW,
      credential: {
        token: TEST_TOKEN,
        baseUrl: TENANT_BASE,
        baseUrlSource: PenseroCredentialSource.Organization,
      },
      signal: controller.signal,
    }).catch((error: unknown) => error);

    expect(lookupHost).toBe("pensero.tenant-supplied.example");
    expect(lookupOptions).toMatchObject({ all: true });
    expect(thrown).not.toBeInstanceOf(EgressBlockedError);
    expect(loggedAnEgressRefusal()).toBe(false);
    // The platform fetch would have resolved the name a second time.
    expect(globalFetch).not.toHaveBeenCalled();
  });

  /**
   * `PENSERO_API_BASE_URL` is set by whoever operates the deployment, not by a
   * tenant, and a self-hosted install whose Pensero really does sit on a
   * private address must keep reaching it. That is the same line
   * `isSecureOrLoopbackHttpUrl` already draws; pinning here would have made
   * this change an outage for those deployments rather than a fix.
   */
  it.each([
    [PenseroCredentialSource.Environment],
    [PenseroCredentialSource.Default],
  ])("does not pin an operator-supplied base (%s)", async (baseUrlSource) => {
    answerWith("127.0.0.1");

    await fetchDeliverySegment({
      ...WINDOW,
      credential: {
        token: TEST_TOKEN,
        baseUrl: OPERATOR_BASE,
        baseUrlSource,
      },
    });

    expect(globalFetch).toHaveBeenCalledTimes(1);
    expect(mockDnsLookup).not.toHaveBeenCalled();
  });

  /**
   * An IPv6 LITERAL base, through the delivery client (whitlockk, ISS-9690).
   *
   * Two things are wrong with the bracketed spelling `URL.hostname` produces,
   * and this case covers both directions of them. `[fd00::1]` is not an address
   * to `net.isIP`, so the internal-range check at the request site skips it; and
   * `[2606:4700::1111]` is handed to the agent as a NAME, so the socket lookup
   * answers ENOTFOUND and a public IPv6 base the write-time validator accepts
   * can never deliver.
   *
   * `mockDnsLookup` staying uncalled on BOTH rows is the shared discriminator:
   * a literal address has nothing to resolve, so any lookup at all means the
   * transport mistook one for a hostname.
   */
  it("refuses an ORG-supplied IPv6-literal base pointing at an internal address", async () => {
    answerWith(UNROUTABLE_PUBLIC_ADDRESS);

    const thrown = await fetchDeliverySegment({
      ...WINDOW,
      credential: {
        token: TEST_TOKEN,
        baseUrl: "https://[fd00::1]/api",
        baseUrlSource: PenseroCredentialSource.Organization,
      },
    }).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(EgressBlockedError);
    expect((thrown as EgressBlockedError).reason).toBe(
      EgressBlockReason.InternalAddress
    );
    expect(globalFetch).not.toHaveBeenCalled();
    expect(mockDnsLookup).not.toHaveBeenCalled();
  });

  it("does not send an ORG-supplied public IPv6-literal base to the resolver", async () => {
    answerWith(UNROUTABLE_PUBLIC_ADDRESS);

    const thrown = await fetchDeliverySegment({
      ...WINDOW,
      credential: {
        token: TEST_TOKEN,
        baseUrl: "https://[2606:4700::1111]/api",
        baseUrlSource: PenseroCredentialSource.Organization,
      },
      signal: AbortSignal.abort(),
    }).catch((error: unknown) => error);

    expect(thrown).not.toBeInstanceOf(EgressBlockedError);
    expect(loggedAnEgressRefusal()).toBe(false);
    expect(mockDnsLookup).not.toHaveBeenCalled();
  });

  /**
   * FAIL CLOSED on the field's absence. A caller that does not say where its
   * base URL came from is not evidence that an operator chose it, and a
   * version-skewed or hand-built credential must not silently unpin the fetch.
   */
  it("pins a credential that carries no source label", async () => {
    answerWith("169.254.169.254");

    await expect(
      fetchDeliverySegment({
        ...WINDOW,
        credential: { token: TEST_TOKEN, baseUrl: TENANT_BASE },
      })
    ).rejects.toBeInstanceOf(EgressBlockedError);
    expect(globalFetch).not.toHaveBeenCalled();
  });
});
