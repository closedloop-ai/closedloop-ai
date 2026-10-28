// @vitest-environment node

import { toBase64Url } from "@repo/api/src/types/base64url";
import {
  DESKTOP_EMAIL_CALLBACK_TIMEOUT_MS,
  DESKTOP_OAUTH_CALLBACK_TIMEOUT_MS,
  DesktopSignInMethod,
  encodeDesktopGatewayPublicKey,
} from "@repo/api/src/types/desktop-authorize-url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDesktopAuthorizeRun,
  type DesktopAuthorizeRun,
  desktopAuthorizeRunMaxAgeMs,
  encodeDesktopAuthorizeRunCookie,
  nextDesktopAuthorizeRunCookie,
  parseDesktopAuthorizeRunCookie,
} from "../desktop-authorize-run";

const ISSUED_AT = Date.UTC(2026, 8, 28, 12, 0, 0);
const GATEWAY_PUBLIC_KEY = encodeDesktopGatewayPublicKey(
  "-----BEGIN PUBLIC KEY-----\nk\n-----END PUBLIC KEY-----"
);

function authorizeQuery(overrides: Record<string, string> = {}): string {
  const params = new URLSearchParams({
    code_challenge: "challenge-abc",
    code_challenge_method: "S256",
    state: "state-xyz",
    redirect_uri: "http://127.0.0.1:49152/cb",
    gateway_id: "gateway-1",
    gateway_public_key: GATEWAY_PUBLIC_KEY,
    provider: DesktopSignInMethod.GitHub,
    ...overrides,
  });
  return `?${params.toString()}`;
}

function issuedRun(query = authorizeQuery()): DesktopAuthorizeRun {
  const run = createDesktopAuthorizeRun(query, ISSUED_AT);
  if (run === null) {
    throw new Error("fixture query must parse");
  }
  return run;
}

function cookieFor(payload: unknown): string {
  return toBase64Url(JSON.stringify(payload));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(ISSUED_AT);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("desktop authorize run cookie codec", () => {
  it("round-trips a run through the cookie value", () => {
    const run = issuedRun();
    const value = encodeDesktopAuthorizeRunCookie(run);

    expect(
      parseDesktopAuthorizeRunCookie(value ?? undefined, Date.now())
    ).toEqual({
      v: 1,
      query: authorizeQuery(),
      state: "state-xyz",
      issuedAt: ISSUED_AT,
    });
  });

  it("round-trips a consumed run", () => {
    const run: DesktopAuthorizeRun = { ...issuedRun(), consumed: true };
    const value = encodeDesktopAuthorizeRunCookie(run) ?? undefined;

    expect(parseDesktopAuthorizeRunCookie(value, Date.now())).toEqual(run);
  });

  it("does not create a run for a query that is not a desktop authorize request", () => {
    expect(
      createDesktopAuthorizeRun(authorizeQuery({ state: "" }), Date.now())
    ).toBeNull();
  });

  it("rejects a payload with a key the strict schema does not know", () => {
    const value = cookieFor({ ...issuedRun(), extra: true });

    expect(parseDesktopAuthorizeRunCookie(value, Date.now())).toBeNull();
  });

  it("rejects a non-loopback redirect_uri inside the cookie", () => {
    const query = authorizeQuery({ redirect_uri: "https://evil.test/cb" });
    const value = cookieFor({ ...issuedRun(), query });

    expect(parseDesktopAuthorizeRunCookie(value, Date.now())).toBeNull();
  });

  it("rejects a cookie whose state is not the one its own query carries", () => {
    const value = cookieFor({ ...issuedRun(), state: "state-other" });

    expect(parseDesktopAuthorizeRunCookie(value, Date.now())).toBeNull();
  });

  it("rejects a value that is not base64url JSON", () => {
    expect(parseDesktopAuthorizeRunCookie("%%%", Date.now())).toBeNull();
    expect(
      parseDesktopAuthorizeRunCookie(toBase64Url("not json"), Date.now())
    ).toBeNull();
  });
});

describe("desktop authorize run TTL", () => {
  it("accepts a run at issue time and rejects one issued in the future", () => {
    const value = encodeDesktopAuthorizeRunCookie(issuedRun()) ?? undefined;

    expect(parseDesktopAuthorizeRunCookie(value, Date.now())).not.toBeNull();

    vi.setSystemTime(ISSUED_AT - 1);
    expect(parseDesktopAuthorizeRunCookie(value, Date.now())).toBeNull();
  });

  it("accepts an OAuth run at its ceiling and rejects it one millisecond past", () => {
    const value = encodeDesktopAuthorizeRunCookie(issuedRun()) ?? undefined;

    vi.setSystemTime(ISSUED_AT + DESKTOP_OAUTH_CALLBACK_TIMEOUT_MS);
    expect(parseDesktopAuthorizeRunCookie(value, Date.now())).not.toBeNull();

    vi.setSystemTime(ISSUED_AT + DESKTOP_OAUTH_CALLBACK_TIMEOUT_MS + 1);
    expect(parseDesktopAuthorizeRunCookie(value, Date.now())).toBeNull();
  });

  it("accepts an email run at its ceiling and rejects it one millisecond past", () => {
    const value =
      encodeDesktopAuthorizeRunCookie(
        issuedRun(authorizeQuery({ provider: DesktopSignInMethod.Email }))
      ) ?? undefined;

    vi.setSystemTime(ISSUED_AT + DESKTOP_EMAIL_CALLBACK_TIMEOUT_MS);
    expect(parseDesktopAuthorizeRunCookie(value, Date.now())).not.toBeNull();

    vi.setSystemTime(ISSUED_AT + DESKTOP_EMAIL_CALLBACK_TIMEOUT_MS + 1);
    expect(parseDesktopAuthorizeRunCookie(value, Date.now())).toBeNull();
  });

  it("selects the ceiling from the run's method, unknown or absent taking the longer one", () => {
    expect(
      desktopAuthorizeRunMaxAgeMs(
        authorizeQuery({ provider: DesktopSignInMethod.Google })
      )
    ).toBe(DESKTOP_OAUTH_CALLBACK_TIMEOUT_MS);
    expect(
      desktopAuthorizeRunMaxAgeMs(
        authorizeQuery({ provider: DesktopSignInMethod.Email })
      )
    ).toBe(DESKTOP_EMAIL_CALLBACK_TIMEOUT_MS);
    expect(
      desktopAuthorizeRunMaxAgeMs(
        authorizeQuery({ provider: "carrier-pigeon" })
      )
    ).toBe(DESKTOP_EMAIL_CALLBACK_TIMEOUT_MS);
    expect(desktopAuthorizeRunMaxAgeMs("?state=state-xyz")).toBe(
      DESKTOP_EMAIL_CALLBACK_TIMEOUT_MS
    );
  });
});

describe("nextDesktopAuthorizeRunCookie", () => {
  it("keeps the original issuedAt when the same run revisits the page", () => {
    const existing = issuedRun();

    const next = nextDesktopAuthorizeRunCookie(
      existing,
      authorizeQuery(),
      ISSUED_AT + 60_000
    );

    expect(next?.issuedAt).toBe(ISSUED_AT);
  });

  it("keeps a consumed run consumed when the same state revisits the page", () => {
    const existing: DesktopAuthorizeRun = { ...issuedRun(), consumed: true };

    const next = nextDesktopAuthorizeRunCookie(
      existing,
      authorizeQuery(),
      ISSUED_AT + 60_000
    );

    expect(next).toBe(existing);
  });

  it("replaces the run when a different state arrives", () => {
    const existing = issuedRun();

    const next = nextDesktopAuthorizeRunCookie(
      existing,
      authorizeQuery({ state: "state-new" }),
      ISSUED_AT + 60_000
    );

    expect(next).toEqual({
      v: 1,
      query: authorizeQuery({ state: "state-new" }),
      state: "state-new",
      issuedAt: ISSUED_AT + 60_000,
    });
  });
});
