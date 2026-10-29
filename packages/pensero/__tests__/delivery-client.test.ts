/**
 * The delivery client's own contract: the verified request shape, the honest
 * completeness ceiling, and the credential never leaving the server.
 */

import { log } from "@repo/observability/log";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PENSERO_DELIVERY_PATH } from "../credential";
import {
  configuredBasePathSegments,
  deliveryRequestPath,
  fetchDeliverySegment,
  observedContinuationKeys,
  resolveDeliveryUrl,
  SegmentCompleteness,
} from "../delivery-client";
import fixture from "./fixtures/pensero-delivery-hazards.fixture.json";

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn() },
}));

const ORIGINAL_TOKEN = process.env.PENSERO_API_TOKEN;
const ORIGINAL_BASE = process.env.PENSERO_API_BASE_URL;

const TEST_TOKEN = "tk_public:sk_secret";
const NOT_CONFIGURED_RE = /Pensero integration not configured/;
const REQUEST_FAILED_RE = /Pensero delivery request failed: 400/;
const QUERY_OR_FRAGMENT_RE = /query string or fragment/;
const NOT_FOUND_WITH_SHAPE_RE =
  /Pensero delivery request failed: 404 \(endpoint=\/v1\/delivery basePathSegments=1\)/;

/** The canonical base the working request uses. */
const CANONICAL_BASE = "https://pensero.ai/api";
/** The base the incident org actually had stored: no `/api` path segment. */
const PATHLESS_BASE = "https://pensero.ai";
/**
 * A base whose PATH identifies the tenant. `isSecureHttpsUrl` vets the scheme,
 * the host's publicness, and query/fragment/userinfo — never the path — so this
 * is a configuration an org can legitimately store today (whitlockk, #6639).
 */
const TENANT_BASE = "https://tenant.example/private/customer-42";

function restoreEnv() {
  if (ORIGINAL_TOKEN === undefined) {
    Reflect.deleteProperty(process.env, "PENSERO_API_TOKEN");
  } else {
    process.env.PENSERO_API_TOKEN = ORIGINAL_TOKEN;
  }
  if (ORIGINAL_BASE === undefined) {
    Reflect.deleteProperty(process.env, "PENSERO_API_BASE_URL");
  } else {
    process.env.PENSERO_API_BASE_URL = ORIGINAL_BASE;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const WINDOW = {
  startDate: "2026-08-01",
  endDate: "2026-08-04",
  teamIdentifiers: ["Engineering"] as const,
};

describe("resolveDeliveryUrl", () => {
  it("builds the verified query shape", () => {
    const url = new URL(
      resolveDeliveryUrl("https://pensero.ai/api", {
        startDate: "2026-08-01",
        endDate: "2026-08-04",
        teamIdentifiers: ["Engineering"],
      })
    );
    expect(url.origin + url.pathname).toBe(
      "https://pensero.ai/api/v1/delivery"
    );
    expect(url.searchParams.get("start_date")).toBe("2026-08-01");
    expect(url.searchParams.get("end_date")).toBe("2026-08-04");
    expect(url.searchParams.get("team_identifiers")).toBe("Engineering");
  });

  it("does not double the separator on a base with a trailing slash", () => {
    expect(
      resolveDeliveryUrl("https://pensero.ai/api/", {
        startDate: "2026-08-01",
        endDate: "2026-08-04",
        teamIdentifiers: ["Engineering"],
      })
    ).toContain("/api/v1/delivery?");
  });

  it("rejects a base URL carrying a query or fragment", () => {
    expect(() =>
      resolveDeliveryUrl("https://pensero.ai/api?x=1", {
        startDate: "2026-08-01",
        endDate: "2026-08-04",
        teamIdentifiers: ["Engineering"],
      })
    ).toThrow(QUERY_OR_FRAGMENT_RE);
  });

  it("OMITS team_identifiers entirely when the org configured none", () => {
    // ISS-8761: an empty parameter is a request to scope to NO team, and the
    // empty window it returns is indistinguishable from a quiet day. Absent and
    // empty are the same intent here — "do not narrow" — and both must omit.
    for (const teamIdentifiers of [undefined, []]) {
      const url = new URL(
        resolveDeliveryUrl("https://pensero.ai/api", {
          startDate: "2026-08-01",
          endDate: "2026-08-04",
          teamIdentifiers,
        })
      );
      expect(url.searchParams.has("team_identifiers")).toBe(false);
      expect(url.searchParams.get("start_date")).toBe("2026-08-01");
    }
  });

  it("joins multiple team identifiers", () => {
    expect(
      new URL(
        resolveDeliveryUrl("https://pensero.ai/api", {
          startDate: "2026-08-01",
          endDate: "2026-08-04",
          teamIdentifiers: ["Engineering", "Platform"],
        })
      ).searchParams.get("team_identifiers")
    ).toBe("Engineering,Platform");
  });
});

describe("deliveryRequestPath", () => {
  it("reports the path only, never the query or the origin", () => {
    const url = resolveDeliveryUrl(CANONICAL_BASE, {
      startDate: "2026-08-01",
      endDate: "2026-08-04",
      teamIdentifiers: ["Engineering"],
    });

    expect(deliveryRequestPath(url)).toBe("/api/v1/delivery");
    // The three things the query and origin would have carried.
    expect(deliveryRequestPath(url)).not.toContain("start_date");
    expect(deliveryRequestPath(url)).not.toContain("Engineering");
    expect(deliveryRequestPath(url)).not.toContain("pensero.ai");
  });

  it("TELLS THE TWO BASES APART — the whole point of carrying it", () => {
    // The incident: an org whose stored base lost its `/api` segment 404s every
    // day forever, and the status alone cannot say so. These two paths are what
    // makes that legible without touching org config.
    const canonical = deliveryRequestPath(
      resolveDeliveryUrl(CANONICAL_BASE, WINDOW)
    );
    const pathless = deliveryRequestPath(
      resolveDeliveryUrl(PATHLESS_BASE, WINDOW)
    );

    expect(canonical).toBe("/api/v1/delivery");
    // NOT `/v1/delivery`: `URL` normalizes a path-less base to `/`, which the
    // trailing-slash strip cannot remove, so the request that actually goes out
    // carries a doubled separator. Pinned as-is because this reports what was
    // REQUESTED — a prettier string here would be a diagnostic that lies.
    expect(pathless).toBe("//v1/delivery");
    expect(pathless).not.toBe(canonical);
  });
});

describe("configuredBasePathSegments", () => {
  it("counts the base's segments without ever naming them", () => {
    // A COUNT is what may leave the server, because an integer cannot identify
    // a tenant the way `/private/customer-42` does.
    expect(
      configuredBasePathSegments(resolveDeliveryUrl(PATHLESS_BASE, WINDOW))
    ).toBe(0);
    expect(
      configuredBasePathSegments(resolveDeliveryUrl(CANONICAL_BASE, WINDOW))
    ).toBe(1);
    expect(
      configuredBasePathSegments(resolveDeliveryUrl(TENANT_BASE, WINDOW))
    ).toBe(2);
  });
});

describe("observedContinuationKeys", () => {
  it("reports nothing for the verified response shape", () => {
    expect(observedContinuationKeys(fixture)).toEqual([]);
  });

  it("names a continuation key the response grew", () => {
    expect(observedContinuationKeys({ ...fixture, next: "…" })).toEqual([
      "next",
    ]);
  });
});

describe("fetchDeliverySegment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PENSERO_API_TOKEN = TEST_TOKEN;
    Reflect.deleteProperty(process.env, "PENSERO_API_BASE_URL");
  });

  afterEach(() => {
    restoreEnv();
  });

  it("sends the credential in the verified header and nowhere else", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(fixture));
    await fetchDeliverySegment({ ...WINDOW, fetchImpl });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Auth-Token"]).toBe(TEST_TOKEN);
    // Not in the URL, and not under the other Pensero surface's header name.
    expect(url).not.toContain("sk_");
    expect(headers.Authorization).toBeUndefined();
  });

  it("refuses to FOLLOW a redirect, so the credential cannot be re-aimed", async () => {
    // davetho (#6492). ISS-8761 made `baseUrl` an org-admin-supplied, live
    // fetch target for a daily cron. `isSecureHttpsUrl` vets the LITERAL host at
    // write time; a validated public host answering 302 to `http://127.0.0.1/…`
    // walks around that check and delivers this request — carrying
    // `X-Auth-Token` — to the deployment's own loopback. Asserted on the init
    // because that is the seam the platform reads, exactly as the header case
    // above does.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(fixture));
    await fetchDeliverySegment({ ...WINDOW, fetchImpl });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.redirect).toBe("error");
  });

  it("extracts the segment it fetched", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(fixture));
    const result = await fetchDeliverySegment({ ...WINDOW, fetchImpl });
    expect(result.segment.rows).toHaveLength(39);
  });

  it("never claims completeness the endpoint cannot demonstrate", async () => {
    // The verified response carries no cursor, no hasMore and no total, so a
    // truncated window is indistinguishable from a quiet one. `unverified` is
    // the honest ceiling; there is deliberately no `complete` member.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(fixture));
    const result = await fetchDeliverySegment({ ...WINDOW, fetchImpl });
    expect(result.completeness).toBe(SegmentCompleteness.Unverified);
    expect(result.continuationKeysSeen).toEqual([]);
  });

  it("flags a response that grew pagination as known-partial", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        ...fixture,
        next: "https://pensero.ai/api/v1/delivery?page=2",
      })
    );
    const result = await fetchDeliverySegment({ ...WINDOW, fetchImpl });
    expect(result.completeness).toBe(SegmentCompleteness.TruncationSignalled);
    expect(result.continuationKeysSeen).toEqual(["next"]);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("continuation keys"),
      expect.objectContaining({ continuationKeysSeen: ["next"] })
    );
  });

  it("throws without echoing the response body on a provider error", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response("token tk_public:sk_secret rejected", { status: 400 })
      );
    await expect(
      fetchDeliverySegment({ ...WINDOW, fetchImpl })
    ).rejects.toThrow(REQUEST_FAILED_RE);

    const logged = JSON.stringify(vi.mocked(log.error).mock.calls);
    expect(logged).not.toContain("sk_secret");
  });

  it("names the endpoint shape on a failed fetch, and the full path in the LOG", async () => {
    // POSITIVE CONTROL for the redaction case below. Without this pair, a test
    // asserting only that the tenant is absent stays green if the diagnostic
    // went missing too — which is the state this change exists to leave behind.
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("Not Found", { status: 404 }));

    await expect(
      fetchDeliverySegment({
        ...WINDOW,
        credential: { token: TEST_TOKEN, baseUrl: CANONICAL_BASE },
        fetchImpl,
      })
    ).rejects.toThrow(NOT_FOUND_WITH_SHAPE_RE);

    // The log is the RICHER sink, deliberately: a structured server log is a
    // narrower audience than the Slack channel the thrown message reaches.
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("Delivery fetch failed"),
      expect.objectContaining({
        status: 404,
        deliveryPath: "/api/v1/delivery",
        basePathSegments: 1,
      })
    );
  });

  it("keeps the TENANT out of the thrown message, which travels to Slack", async () => {
    // whitlockk (#6639). `isSecureHttpsUrl` never constrains the path, so an org can
    // store `https://tenant.example/private/customer-42` and the resolved path
    // is tenant-identifying. The throw becomes `lastFailureReason` and from
    // there a Slack alert, so it may carry only the module's own constant
    // endpoint and a COUNT.
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        // An upstream error page quoting the whole credentialed request back.
        "no route for /private/customer-42/v1/delivery?team_identifiers=Engineering (X-Auth-Token: tk_public:sk_secret)",
        { status: 404 }
      )
    );

    const thrown = await fetchDeliverySegment({
      ...WINDOW,
      credential: { token: TEST_TOKEN, baseUrl: TENANT_BASE },
      fetchImpl,
    }).catch((error: unknown) => (error as Error).message);

    for (const forbidden of [
      "tenant.example",
      "customer-42",
      "private",
      "team_identifiers",
      "Engineering",
      "sk_secret",
      "no route for",
    ]) {
      expect(thrown).not.toContain(forbidden);
    }
    // POSITIVE CONTROL: the diagnostic survived, so the loop above cannot be
    // satisfied by a message that dropped it. Two segments is what separates
    // this from the incident's zero.
    expect(thrown).toContain("endpoint=/v1/delivery");
    expect(thrown).toContain("basePathSegments=2");
  });

  it("SEPARATES a lost base path from a configured one, which is the point", async () => {
    // The discriminator whitlockk asked to be preserved: with only a count, a 404 on
    // a base that lost its path segment is still distinguishable from a 404 on a
    // base that has one. Auth is separated by status, and an unreachable host by
    // being a transport rejection that never reaches this branch at all.
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("Not Found", { status: 404 }));
    const messageFor = (baseUrl: string) =>
      fetchDeliverySegment({
        ...WINDOW,
        credential: { token: TEST_TOKEN, baseUrl },
        fetchImpl,
      }).catch((error: unknown) => (error as Error).message);

    expect(await messageFor(PATHLESS_BASE)).toContain("basePathSegments=0");
    expect(await messageFor(TENANT_BASE)).toContain("basePathSegments=2");
  });

  /**
   * ISS-9689. The org that produced the eleven-day outage had pasted the FULL
   * request URL into the base-URL field, so the client appended its own
   * `/v1/delivery` and asked for `/api/v1/delivery/v1/delivery`. The alert said
   * `basePathSegments=3` and nothing else — a fingerprint someone had to decode
   * by hand before they could tell an admin what to change.
   *
   * The value here is the CANONICAL base with the endpoint appended, which is
   * exactly the paste, rather than a hand-written lookalike.
   */
  it("names the doubled-path cause in the failure that travels to Slack", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("Not Found", { status: 404 }));

    const thrown = await fetchDeliverySegment({
      ...WINDOW,
      credential: {
        token: TEST_TOKEN,
        baseUrl: `${CANONICAL_BASE}${PENSERO_DELIVERY_PATH}`,
      },
      fetchImpl,
    }).catch((error: unknown) => (error as Error).message);

    // The request that actually went out is the doubled one — the diagnostic
    // describes what happened, it does not merely restate the input.
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(
      "/api/v1/delivery/v1/delivery"
    );
    expect(thrown).toContain("already ends in /v1/delivery");
    expect(thrown).toContain("basePathSegments=3");
    // Still names no tenant: the hint is built from the module's own constant,
    // never from the configured base. (That the whole reason also survives the
    // alert channel's length cap is pinned where that cap lives — see
    // `apps/api/app/cron/backfill-pensero-delivery/__tests__/failure-reason.test.ts`.)
    expect(thrown).not.toContain("pensero.ai");
  });

  it("adds NO doubled-path hint to an ordinary 404, so the hint means something", async () => {
    // The negative control. Without this, a hint appended unconditionally would
    // satisfy the case above while telling every failing org the wrong cause.
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("Not Found", { status: 404 }));

    const thrown = await fetchDeliverySegment({
      ...WINDOW,
      credential: { token: TEST_TOKEN, baseUrl: TENANT_BASE },
      fetchImpl,
    }).catch((error: unknown) => (error as Error).message);

    expect(thrown).not.toContain("already ends in");
    expect(thrown).toContain("basePathSegments=2");
  });

  it("throws a clear error when the integration is not configured", async () => {
    Reflect.deleteProperty(process.env, "PENSERO_API_TOKEN");
    await expect(
      fetchDeliverySegment({ ...WINDOW, fetchImpl: vi.fn() })
    ).rejects.toThrow(NOT_CONFIGURED_RE);
  });
});
