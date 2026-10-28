import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  allLoggedErrorText,
  DIAGNOSTIC_ERROR_CODE,
  failureResponse,
  LEAKED_TOKEN,
  loadGoogleModule,
  okJsonResponse,
  setCredentialEnv,
} from "./google-test-fixtures";

/**
 * The two unauthenticated-by-client-secret endpoints: `revokeToken`, which
 * disconnects an integration, and `getUserInfo`, which identifies the account
 * behind an access token.
 *
 * `revokeToken` is the one function in this module that is deliberately
 * best-effort — it must never throw, because a failed revoke cannot be allowed
 * to block a disconnect. That is the contract pinned here.
 */

const { logMock } = vi.hoisted(() => ({
  logMock: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("server-only", () => ({}));

vi.mock("googleapis", () => ({
  google: { drive: vi.fn() },
}));

vi.mock("@repo/observability/log", () => ({ log: logMock }));

const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const ACCESS_TOKEN = "access-token-1";
const USERINFO_FAILURE_PATTERN = /^Failed to get user info: 401$/;

function googleErrorBody() {
  return JSON.stringify({
    error: DIAGNOSTIC_ERROR_CODE,
    access_token: LEAKED_TOKEN,
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

describe("revokeToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setCredentialEnv();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("posts the access token form-encoded to the revoke endpoint", async () => {
    fetchMock.mockResolvedValue(okJsonResponse({}));
    const { revokeToken } = await loadGoogleModule();

    await revokeToken(ACCESS_TOKEN);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(REVOKE_URL);
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe(
      "application/x-www-form-urlencoded"
    );
    expect((init.body as URLSearchParams).get("token")).toBe(ACCESS_TOKEN);
  });

  it("does not require the client secret", async () => {
    fetchMock.mockResolvedValue(okJsonResponse({}));
    const { revokeToken } = await loadGoogleModule();

    await revokeToken(ACCESS_TOKEN);

    const body = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(body.get("client_id")).toBeNull();
    expect(body.get("client_secret")).toBeNull();
  });

  it("stays quiet when Google accepts the revocation", async () => {
    fetchMock.mockResolvedValue(okJsonResponse({}));
    const { revokeToken } = await loadGoogleModule();

    await expect(revokeToken(ACCESS_TOKEN)).resolves.toBeUndefined();
    expect(logMock.warn).not.toHaveBeenCalled();
  });

  it("resolves rather than throwing when Google rejects the revocation", async () => {
    fetchMock.mockResolvedValue(failureResponse(400, googleErrorBody()));
    const { revokeToken } = await loadGoogleModule();

    // A disconnect must complete even if Google will not revoke, so the
    // failure is warned and swallowed.
    await expect(revokeToken(ACCESS_TOKEN)).resolves.toBeUndefined();
    expect(logMock.warn).toHaveBeenCalledTimes(1);
    expect(logMock.warn.mock.calls[0]?.[1]).toMatchObject({ status: 400 });
  });

  it("logs the revocation failure body verbatim", async () => {
    fetchMock.mockResolvedValue(failureResponse(400, googleErrorBody()));
    const { revokeToken } = await loadGoogleModule();

    await revokeToken(ACCESS_TOKEN);

    // Pins current behavior; looks odd because every sibling failure path runs
    // its body through redactTokensFromError first and this one does not, so a
    // token-shaped run in Google's revoke error reaches the log sink intact.
    // Flagged, not fixed: a coverage change may not alter behavior.
    const warned = logMock.warn.mock.calls[0]?.[1] as { error?: string };
    expect(warned?.error).toContain(LEAKED_TOKEN);
  });

  it("resolves when the revoke request itself fails to reach Google", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const { revokeToken } = await loadGoogleModule();

    await expect(revokeToken(ACCESS_TOKEN)).resolves.toBeUndefined();
    expect(logMock.warn).toHaveBeenCalledTimes(1);
  });
});

describe("getUserInfo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setCredentialEnv();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("authorizes with the bearer access token", async () => {
    fetchMock.mockResolvedValue(okJsonResponse({ email: "a@example.test" }));
    const { getUserInfo } = await loadGoogleModule();

    await getUserInfo(ACCESS_TOKEN);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(USERINFO_URL);
    expect(init.headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it("returns the email, name and picture Google supplies", async () => {
    fetchMock.mockResolvedValue(
      okJsonResponse({
        email: "a@example.test",
        name: "Ada",
        picture: "https://example.test/a.png",
        hd: "example.test",
      })
    );
    const { getUserInfo } = await loadGoogleModule();

    // Only the three declared fields are carried through; extras are dropped.
    await expect(getUserInfo(ACCESS_TOKEN)).resolves.toEqual({
      email: "a@example.test",
      name: "Ada",
      picture: "https://example.test/a.png",
    });
  });

  it("leaves name and picture undefined when Google omits them", async () => {
    fetchMock.mockResolvedValue(okJsonResponse({ email: "a@example.test" }));
    const { getUserInfo } = await loadGoogleModule();

    await expect(getUserInfo(ACCESS_TOKEN)).resolves.toEqual({
      email: "a@example.test",
      name: undefined,
      picture: undefined,
    });
  });

  it("returns an undefined email when Google omits it", async () => {
    fetchMock.mockResolvedValue(okJsonResponse({ name: "Ada" }));
    const { getUserInfo } = await loadGoogleModule();

    // Pins current behavior; looks odd because the token endpoints validate
    // their 200 bodies with Zod and this one does not, so a userinfo response
    // with no email resolves to a GoogleUserInfo whose required `email` is
    // undefined instead of failing. Flagged, not fixed.
    await expect(getUserInfo(ACCESS_TOKEN)).resolves.toEqual({
      email: undefined,
      name: "Ada",
      picture: undefined,
    });
  });

  it("throws with the HTTP status when the userinfo call is rejected", async () => {
    fetchMock.mockResolvedValue(failureResponse(401, googleErrorBody()));
    const { getUserInfo } = await loadGoogleModule();

    await expect(getUserInfo(ACCESS_TOKEN)).rejects.toThrowError(
      USERINFO_FAILURE_PATTERN
    );
  });

  it("redacts token-shaped runs from the userinfo failure body", async () => {
    fetchMock.mockResolvedValue(failureResponse(401, googleErrorBody()));
    const { getUserInfo } = await loadGoogleModule();

    await expect(getUserInfo(ACCESS_TOKEN)).rejects.toThrowError();

    const logged = (logMock.error.mock.calls[0]?.[1] as { error?: string })
      ?.error;
    expect(logged).not.toContain(LEAKED_TOKEN);
    expect(logged).toContain("[REDACTED]");
    expect(logged).toContain(DIAGNOSTIC_ERROR_CODE);

    const allLogged = allLoggedErrorText(logMock);
    expect(allLogged).not.toContain(LEAKED_TOKEN);
  });

  it("propagates a transport failure", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const { getUserInfo } = await loadGoogleModule();

    await expect(getUserInfo(ACCESS_TOKEN)).rejects.toThrowError(
      "network down"
    );
  });
});
