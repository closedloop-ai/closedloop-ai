/**
 * ISS-8007 — the route boundary for the per-org Pensero credential.
 *
 * What this file pins, and what it deliberately does not: the service layer is
 * mocked here, so PERSISTENCE and org scoping at the query level are NOT
 * observable from this file — `../pensero-integration-service.test.ts` owns
 * those against an org-keyed store. What this pins is which callers the route
 * admits, that the org it acts on comes from the SESSION and not the request,
 * that a malformed credential is refused before it reaches persistence, and
 * that no verb hands the token back.
 *
 * The fixtures are chosen so they can actually fail:
 *
 * - Refusal cases are driven by a NON-ADMIN Clerk role through the REAL
 *   Settings command gate, and each asserts the write never reached the
 *   service. A 403 that still wrote would pass a status-only assertion.
 * - The ADMIN cases are the over-gating guard: a gate that refused everyone
 *   would satisfy every refusal case above.
 * - The validation cases pair each rejected input with an ACCEPTED sibling of
 *   the same field, so "rejects everything" cannot masquerade as validation.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG_ID = "org-1";
const VALID_TOKEN = "tk_public:sk_secret9876";
const TOKEN_LAST_FOUR = "9876";

const mocks = vi.hoisted(() => ({
  authContext: {
    authMethod: "session",
    clerkOrgId: "clerk-org-1",
    clerkUserId: "clerk-user-1",
    user: {
      id: "user-1",
      clerkId: "clerk-user-1",
      organizationId: "org-1",
    },
  },
  getOrganizationMembershipRole: vi.fn(),
  isRolloutEnabled: vi.fn(),
  service: {
    getOrgCredentialInfo: vi.fn(),
    setOrgCredential: vi.fn(),
    removeOrgCredential: vi.fn(),
  },
}));

vi.mock("@/lib/auth/with-auth", () => ({
  withAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest) =>
      handler(mocks.authContext, request),
}));

vi.mock("@/lib/auth/clerk-service", () => ({
  clerkService: {
    getOrganizationMembershipRole: mocks.getOrganizationMembershipRole,
  },
}));

vi.mock("../../pensero-integration-service", () => ({
  penseroIntegrationService: mocks.service,
}));

vi.mock("../pensero-rollout-feature", async (importOriginal) => ({
  // The error-code const is a real contract value the assertions below compare
  // against, so it comes from the module rather than being restated here — a
  // fixture that re-declares the value it polices cannot catch its deletion.
  ...(await importOriginal<typeof import("../pensero-rollout-feature")>()),
  isPenseroIntegrationRolloutEnabled: mocks.isRolloutEnabled,
}));

import {
  PENSERO_INTEGRATION_PATH,
  PenseroRouteErrorCode,
} from "@repo/api/src/types/pensero-integration";
import {
  DEFAULT_PENSERO_BASE_URL,
  PENSERO_DELIVERY_PATH,
} from "@repo/pensero/credential";
import { ClerkOrgRoleFixture } from "@/__tests__/utils/auth-helpers";
import { DELETE, GET, PUT } from "../route";

/** The base an org that pasted the full request URL ends up with (ISS-9689). */
const DOUBLED_BASE = `${DEFAULT_PENSERO_BASE_URL}${PENSERO_DELIVERY_PATH}`;
/** A legitimate multi-segment tenant base, which must stay accepted. */
const TENANT_BASE = "https://tenant.example/private/customer-42";

/**
 * `/settings/pensero` takes no dynamic segment, but the generated route types
 * still require the context argument, so each builder returns the full pair and
 * call sites spread it.
 */
type RouteArgs = [NextRequest, { params: Promise<Record<string, string>> }];

function routeContext(): { params: Promise<Record<string, string>> } {
  return { params: Promise.resolve({}) };
}

function putRequest(body: unknown): RouteArgs {
  return [
    new NextRequest(`http://localhost${PENSERO_INTEGRATION_PATH}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    routeContext(),
  ];
}

function deleteRequest(): RouteArgs {
  return [
    new NextRequest(`http://localhost${PENSERO_INTEGRATION_PATH}`, {
      method: "DELETE",
    }),
    routeContext(),
  ];
}

function getRequest(): RouteArgs {
  return [
    new NextRequest(`http://localhost${PENSERO_INTEGRATION_PATH}`),
    routeContext(),
  ];
}

/** The narrowing this org already has stored, which an omitted field preserves. */
const STORED_TEAMS = ["Engineering"];

const STORED_INFO = {
  isSet: true,
  lastFour: TOKEN_LAST_FOUR,
  baseUrl: null,
  teamIdentifiers: STORED_TEAMS,
  setAt: new Date("2026-01-01T00:00:00.000Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getOrganizationMembershipRole.mockResolvedValue(
    ClerkOrgRoleFixture.Admin
  );
  mocks.isRolloutEnabled.mockResolvedValue(true);
  mocks.service.getOrgCredentialInfo.mockResolvedValue(STORED_INFO);
  mocks.service.setOrgCredential.mockResolvedValue(STORED_INFO);
  mocks.service.removeOrgCredential.mockResolvedValue(undefined);
});

/**
 * #6030 (davetho). The card is hidden behind `pensero-integration`, but the
 * ROUTE is its own reachable entry point: an org admin could `PUT` directly and
 * store a credential outside the rollout. That row is inert today, and wins over
 * the deployment-wide env token the moment layer 3 reads it.
 *
 * The asymmetry across the three verbs is the contract, not an omission, so each
 * arm is pinned — the PUT refusal alone would be satisfied by gating all three,
 * which is the wrong shape: gating DELETE would leave an org unable to revoke a
 * credential if the flag were rolled back, and gating GET would make the card
 * report `isSet: false` for an org that has one.
 */
describe("the rollout flag gates the write, and only the write", () => {
  it("refuses PUT for an admin outside the rollout, and does not persist", async () => {
    mocks.isRolloutEnabled.mockResolvedValue(false);

    const response = await PUT(...putRequest({ token: VALID_TOKEN }));

    expect(response.status).toBe(403);
    expect(mocks.service.setOrgCredential).not.toHaveBeenCalled();
  });

  it("distinguishes the rollout refusal from the authorization refusal", async () => {
    // Both are 403, and a programmatic caller has to be able to tell "not yet"
    // from "never". The code is read from the module rather than restated, so
    // deleting the member fails this file rather than passing against a copy.
    mocks.isRolloutEnabled.mockResolvedValue(false);

    const rolloutRefusal = await PUT(...putRequest({ token: VALID_TOKEN }));
    const rolloutBody = await rolloutRefusal.json();
    expect(rolloutBody.code).toBe(PenseroRouteErrorCode.RolloutDisabled);

    mocks.isRolloutEnabled.mockResolvedValue(true);
    mocks.getOrganizationMembershipRole.mockResolvedValue(
      ClerkOrgRoleFixture.Member
    );

    const adminRefusal = await PUT(...putRequest({ token: VALID_TOKEN }));
    expect(adminRefusal.status).toBe(403);
    const adminBody = await adminRefusal.json();
    expect(adminBody.code).not.toBe(PenseroRouteErrorCode.RolloutDisabled);
  });

  it("checks authorization BEFORE the rollout, so a flag outage cannot decide a 403", async () => {
    // The admin gate is the security boundary and the flag is a rollout control.
    // If the order inverted, a PostHog outage would answer for a non-admin and
    // the authorization check would never run.
    mocks.getOrganizationMembershipRole.mockResolvedValue(
      ClerkOrgRoleFixture.Member
    );

    await PUT(...putRequest({ token: VALID_TOKEN }));

    expect(mocks.isRolloutEnabled).not.toHaveBeenCalled();
  });

  it("still lets an admin outside the rollout REVOKE a stored credential", async () => {
    // Gating this would make a credential stored during a rollout window
    // unrevokable once the flag was rolled back — the gate would protect the
    // hidden state instead of the user.
    mocks.isRolloutEnabled.mockResolvedValue(false);

    const response = await DELETE(...deleteRequest());

    expect(response.status).toBe(200);
    expect(mocks.service.removeOrgCredential).toHaveBeenCalledTimes(1);
  });

  it("still reports a stored credential to a member outside the rollout", async () => {
    // The alternative is answering `isSet: false` for an org that HAS one,
    // which the card would render as a lie.
    mocks.isRolloutEnabled.mockResolvedValue(false);

    const response = await GET(...getRequest());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.isSet).toBe(true);
  });
});

describe("PUT /settings/pensero authorization", () => {
  it("admits an org admin and persists the credential", async () => {
    const response = await PUT(...putRequest({ token: VALID_TOKEN }));

    expect(response.status).toBe(200);
    expect(mocks.service.setOrgCredential).toHaveBeenCalledTimes(1);
  });

  it("refuses a non-admin and does not persist", async () => {
    mocks.getOrganizationMembershipRole.mockResolvedValue(
      ClerkOrgRoleFixture.Member
    );

    const response = await PUT(...putRequest({ token: VALID_TOKEN }));

    expect(response.status).toBe(403);
    expect(mocks.service.setOrgCredential).not.toHaveBeenCalled();
  });

  // Still fails CLOSED — the credential is not written. ISS-8661 only changed
  // the status it says that with: 503, so an outage is not reported as a denial.
  it("refuses when the role provider errors, rather than failing open", async () => {
    mocks.getOrganizationMembershipRole.mockRejectedValue(
      new Error("clerk unreachable")
    );

    const response = await PUT(...putRequest({ token: VALID_TOKEN }));

    expect(response.status).toBe(503);
    expect(response.status).not.toBe(403);
    expect(mocks.service.setOrgCredential).not.toHaveBeenCalled();
  });
});

describe("DELETE /settings/pensero authorization", () => {
  it("admits an org admin and removes the credential", async () => {
    const response = await DELETE(...deleteRequest());

    expect(response.status).toBe(200);
    expect(mocks.service.removeOrgCredential).toHaveBeenCalledWith(ORG_ID);
  });

  it("refuses a non-admin and does not remove", async () => {
    mocks.getOrganizationMembershipRole.mockResolvedValue(
      ClerkOrgRoleFixture.Member
    );

    const response = await DELETE(...deleteRequest());

    expect(response.status).toBe(403);
    expect(mocks.service.removeOrgCredential).not.toHaveBeenCalled();
  });
});

describe("org scoping at the route boundary", () => {
  /**
   * The org acted on comes from the authenticated session. There is no
   * request-supplied org id, so this asserts the SHAPE that makes tampering
   * impossible rather than trying to tamper.
   */
  it("writes against the session's organization, not anything in the body", async () => {
    await PUT(
      ...putRequest({ token: VALID_TOKEN, organizationId: "org-somebody-else" })
    );

    expect(mocks.service.setOrgCredential).toHaveBeenCalledWith(
      ORG_ID,
      expect.objectContaining({ token: VALID_TOKEN })
    );
  });

  it("reads against the session's organization", async () => {
    await GET(...getRequest());

    expect(mocks.service.getOrgCredentialInfo).toHaveBeenCalledWith(ORG_ID);
  });
});

describe("credential validation at the route boundary", () => {
  it("accepts a well-formed tk_<public>:sk_<secret> token", async () => {
    const response = await PUT(...putRequest({ token: VALID_TOKEN }));

    expect(response.status).toBe(200);
    expect(mocks.service.setOrgCredential).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a token missing the sk_ half", "tk_publiconly"],
    ["a token missing the tk_ half", "sk_secretonly"],
    ["an empty token", ""],
    ["a token with a trailing newline", `${VALID_TOKEN}\n`],
  ])("rejects %s before it reaches persistence", async (_label, token) => {
    const response = await PUT(...putRequest({ token }));

    expect(response.status).toBe(400);
    expect(mocks.service.setOrgCredential).not.toHaveBeenCalled();
  });

  it("accepts an https base-URL override", async () => {
    const response = await PUT(
      ...putRequest({
        token: VALID_TOKEN,
        baseUrl: "https://pensero.example.com/api",
      })
    );

    expect(response.status).toBe(200);
    expect(mocks.service.setOrgCredential).toHaveBeenCalledWith(
      ORG_ID,
      expect.objectContaining({ baseUrl: "https://pensero.example.com/api" })
    );
  });

  /**
   * The https rule is what keeps the secret-bearing `Authorization` header off
   * the wire in cleartext; the loopback cases are the SSRF half — an org admin
   * must not be able to aim the server at its own loopback interface.
   */
  it.each([
    ["plaintext http to a public host", "http://pensero.example.com/api"],
    ["loopback by name", "http://localhost:8000/api"],
    ["loopback by v4 address", "http://127.0.0.1:8000/api"],
    ["loopback by v6 address", "http://[::1]:8000/api"],
    ["a relative path", "/api"],
  ])("rejects a base URL that is %s", async (_label, baseUrl) => {
    const response = await PUT(...putRequest({ token: VALID_TOKEN, baseUrl }));

    expect(response.status).toBe(400);
    expect(mocks.service.setOrgCredential).not.toHaveBeenCalled();
  });

  /**
   * `new URL()` tolerates surrounding whitespace, so without an explicit trim a
   * padded value validates and is then STORED padded. The card's `type="url"`
   * field strips whitespace client-side, but that is one client's behaviour and
   * not this contract's — any other caller can send whatever it likes.
   */
  it("stores a whitespace-padded base URL trimmed", async () => {
    const response = await PUT(
      ...putRequest({
        token: VALID_TOKEN,
        baseUrl: "  https://pensero.example.com/api  ",
      })
    );

    expect(response.status).toBe(200);
    expect(mocks.service.setOrgCredential).toHaveBeenCalledWith(
      ORG_ID,
      expect.objectContaining({ baseUrl: "https://pensero.example.com/api" })
    );
  });

  /**
   * A query or fragment has no meaning on a collection base, and the Pensero
   * client has always thrown on one — with a message naming an env var an org
   * admin cannot set. Accepting it at the form would store a credential that
   * only fails later, at call time, which is the exact failure the shared
   * predicate exists to prevent.
   */
  it.each([
    ["a query string", "https://pensero.example.com/api?x=1"],
    ["a fragment", "https://pensero.example.com/api#frag"],
  ])("rejects a base URL carrying %s", async (_label, baseUrl) => {
    const response = await PUT(...putRequest({ token: VALID_TOKEN, baseUrl }));

    expect(response.status).toBe(400);
    expect(mocks.service.setOrgCredential).not.toHaveBeenCalled();
  });

  /**
   * #6030 (tamsinb). `base_url` is stored in plaintext and `GET
   * /settings/pensero` returns it to every MEMBER of the org, not only admins,
   * so a URL carrying userinfo makes the endpoint field an unencrypted,
   * org-readable secret store. It would not even work: the client rebuilds the
   * request URL from `origin + pathname`, which excludes userinfo — so the
   * credentials would be disclosed and then dropped.
   *
   * The `accepts an https base-URL override` case above is the positive sibling
   * for these: the same scheme and host without userinfo is stored.
   */
  it.each([
    [
      "username and password",
      "https://tk_public:sk_secret@pensero.example.com/api",
    ],
    ["a username alone", "https://tk_public@pensero.example.com/api"],
  ])("rejects a base URL carrying %s", async (_label, baseUrl) => {
    const response = await PUT(...putRequest({ token: VALID_TOKEN, baseUrl }));

    expect(response.status).toBe(400);
    expect(mocks.service.setOrgCredential).not.toHaveBeenCalled();
  });

  /**
   * #6030 (davetho). https stops CLEARTEXT and says nothing about the
   * destination, so every one of these used to be STORED — and once layer 3
   * reads the row, the deployment's own server sends an `Authorization: Token`
   * header to whatever internal address a tenant named. `accepts an https
   * base-URL override` above is the positive sibling: a public https host with
   * the same shape is still stored.
   */
  it.each([
    ["loopback by name over https", "https://localhost:8000/api"],
    ["loopback by address over https", "https://127.0.0.1:8000/api"],
    ["an RFC 1918 address over https", "https://10.0.1.5/api"],
    ["the cloud metadata endpoint", "https://169.254.169.254/api"],
    ["an IPv4-mapped private v6 address", "https://[::ffff:10.0.1.5]/api"],
  ])("rejects an internal target reached over %s", async (_label, baseUrl) => {
    const response = await PUT(...putRequest({ token: VALID_TOKEN, baseUrl }));

    expect(response.status).toBe(400);
    expect(mocks.service.setOrgCredential).not.toHaveBeenCalled();
  });

  it("treats an omitted base URL as inheriting the deployment default", async () => {
    const response = await PUT(...putRequest({ token: VALID_TOKEN }));

    expect(response.status).toBe(200);
    const [, credential] = mocks.service.setOrgCredential.mock.calls[0] as [
      string,
      { baseUrl?: string | null },
    ];
    expect(credential.baseUrl ?? null).toBeNull();
  });
});

/**
 * ISS-9689 — the eleven-day production outage, closed at the write.
 *
 * `dominantFailure="Pensero delivery request failed: 404 (endpoint=/v1/delivery
 * basePathSegments=3)"`, every day for eleven days, `rows=0`. Three segments is
 * `api`, `v1`, `delivery`: an org admin pasted the FULL request URL into the
 * base-URL field, `isSecureHttpsUrl` passed it because none of its four rules
 * looks at the path, and the client then asked for
 * `/api/v1/delivery/v1/delivery`.
 *
 * The rule is arithmetic on the submitted string and needs no network: appending
 * `/v1/delivery` to a base that already ends in it cannot work for ANY
 * deployment. Every rejection below is paired with an accepted sibling, so
 * "refuses everything" cannot masquerade as validation.
 */
describe("a base URL that duplicates the delivery path is refused offline", () => {
  it("rejects the exact value the incident org stored, without persisting", async () => {
    const response = await PUT(
      ...putRequest({ token: VALID_TOKEN, baseUrl: DOUBLED_BASE })
    );

    expect(response.status).toBe(400);
    // THE TEETH: the write never reached the store. A status-only assertion
    // would pass against a route that returned 400 and saved anyway.
    expect(mocks.service.setOrgCredential).not.toHaveBeenCalled();
  });

  it("tells the admin what to type instead", async () => {
    const response = await PUT(
      ...putRequest({ token: VALID_TOKEN, baseUrl: DOUBLED_BASE })
    );
    const body = await response.json();

    expect(JSON.stringify(body)).toContain(PENSERO_DELIVERY_PATH);
    expect(JSON.stringify(body)).toContain(DEFAULT_PENSERO_BASE_URL);
  });

  it("rejects the same paste spelled with a trailing slash", async () => {
    // `resolveDeliveryUrl` strips trailing slashes before appending, so this
    // doubles exactly the way the bare form does.
    const response = await PUT(
      ...putRequest({ token: VALID_TOKEN, baseUrl: `${DOUBLED_BASE}/` })
    );

    expect(response.status).toBe(400);
    expect(mocks.service.setOrgCredential).not.toHaveBeenCalled();
  });

  /**
   * whitlockk (#6791). URL paths are CASE-SENSITIVE and the client appends the
   * lowercase path verbatim, so `…/api/V1/Delivery` resolves to
   * `…/api/V1/Delivery/v1/delivery` — not a doubled path, and a route a tenant
   * may legitimately serve. Rejecting it would refuse a base that works.
   */
  it("accepts a case-varying path, because it does NOT double", async () => {
    const baseUrl = `${DEFAULT_PENSERO_BASE_URL}/V1/Delivery`;

    const response = await PUT(...putRequest({ token: VALID_TOKEN, baseUrl }));

    expect(response.status).toBe(200);
    expect(mocks.service.setOrgCredential).toHaveBeenCalledWith(
      ORG_ID,
      expect.objectContaining({ baseUrl })
    );
  });

  /**
   * THE OVER-REACH GUARD. A path-shape heuristic — "reject a multi-segment
   * path" — would have fixed this incident and broken every legitimate tenant
   * deployment with it. This is the case that fails if anyone reaches for one.
   */
  it("still accepts a legitimate multi-segment tenant base", async () => {
    const response = await PUT(
      ...putRequest({ token: VALID_TOKEN, baseUrl: TENANT_BASE })
    );

    expect(response.status).toBe(200);
    expect(mocks.service.setOrgCredential).toHaveBeenCalledWith(
      ORG_ID,
      expect.objectContaining({ baseUrl: TENANT_BASE })
    );
  });

  it.each([
    ["a lookalike segment elsewhere", "https://pensero.ai/v1/delivery-hub/api"],
    ["a pluralized tail", "https://pensero.ai/api/v1/deliveries"],
  ])("still accepts a base with %s", async (_label, baseUrl) => {
    const response = await PUT(...putRequest({ token: VALID_TOKEN, baseUrl }));

    expect(response.status).toBe(200);
    expect(mocks.service.setOrgCredential).toHaveBeenCalledTimes(1);
  });
});

describe("the token never crosses back to the client", () => {
  /**
   * Booleans rather than `not.toContain(VALID_TOKEN)`: a containment matcher
   * renders its subject into stdout and the HTML report when it fails, which
   * would print a credential on exactly the run where something went wrong.
   */
  it("does not echo the submitted token in the write response", async () => {
    const response = await PUT(...putRequest({ token: VALID_TOKEN }));
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text.includes(VALID_TOKEN)).toBe(false);
    expect(text.includes(TOKEN_LAST_FOUR)).toBe(true);
  });

  it("returns only presence and a fingerprint on read", async () => {
    const response = await GET(...getRequest());
    const payload = (await response.json()) as {
      data: Record<string, unknown>;
    };

    expect(payload.data.isSet).toBe(true);
    expect(payload.data.lastFour).toBe(TOKEN_LAST_FOUR);
    expect("token" in payload.data).toBe(false);
    expect("apiTokenEncrypted" in payload.data).toBe(false);
  });
});
