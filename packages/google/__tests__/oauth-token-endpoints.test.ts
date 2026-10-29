import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  allLoggedErrorText,
  CLIENT_ID,
  CLIENT_SECRET,
  DIAGNOSTIC_ERROR_CODE,
  failureResponse,
  LEAKED_TOKEN,
  loadGoogleModule,
  okJsonResponse,
  setCredentialEnv,
} from "./google-test-fixtures";

/**
 * The two calls that mint credentials: `exchangeCodeForTokens` and
 * `refreshAccessToken`. They share a request shape, a response schema, and a
 * failure path, so they are pinned side by side — a change that lands on one
 * and not the other shows up here as a single failing pair.
 *
 * The redaction assertions are the ISS-5291 contract, not log trivia: the
 * error body Google returns on a failed exchange can carry the submitted
 * token, and this is the only place that stops it reaching the log sink.
 */

const { logMock } = vi.hoisted(() => ({
  logMock: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("server-only", () => ({}));

vi.mock("googleapis", () => ({
  google: { drive: vi.fn() },
}));

vi.mock("@repo/observability/log", () => ({ log: logMock }));

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CODE = "auth-code-1";
const VERIFIER = "code-verifier-1";
const REDIRECT_URI = "https://app.example.test/callback";
const REFRESH_TOKEN = "refresh-token-1";
const TOKEN_EXCHANGE_FAILURE_PATTERN = /^Token exchange failed: 400$/;
const TOKEN_REFRESH_FAILURE_PATTERN = /^Token refresh failed: 401$/;

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const USERINFO_SCOPE = "https://www.googleapis.com/auth/userinfo.email";

const FULL_TOKEN_PAYLOAD = {
  access_token: "access-1",
  refresh_token: "refresh-2",
  expires_in: 3599,
  token_type: "Bearer",
  scope: `${DRIVE_SCOPE} ${USERINFO_SCOPE}`,
};

const MINIMAL_TOKEN_PAYLOAD = {
  access_token: "access-1",
  token_type: "Bearer",
};

function googleErrorBody() {
  return JSON.stringify({
    error: DIAGNOSTIC_ERROR_CODE,
    access_token: LEAKED_TOKEN,
  });
}

function loggedErrorText(): string {
  const payload = logMock.error.mock.calls[0]?.[1] as { error?: string };
  return payload?.error ?? "";
}

let fetchMock: ReturnType<typeof vi.fn>;

describe("exchangeCodeForTokens", () => {
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

  it("posts a form-encoded authorization_code grant carrying the PKCE verifier", async () => {
    fetchMock.mockResolvedValue(okJsonResponse(FULL_TOKEN_PAYLOAD));
    const { exchangeCodeForTokens } = await loadGoogleModule();

    await exchangeCodeForTokens(CODE, VERIFIER, REDIRECT_URI);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(TOKEN_URL);
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe(
      "application/x-www-form-urlencoded"
    );

    const body = init.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe(CODE);
    expect(body.get("code_verifier")).toBe(VERIFIER);
    expect(body.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(body.get("client_id")).toBe(CLIENT_ID);
    expect(body.get("client_secret")).toBe(CLIENT_SECRET);
  });

  it("maps the token response onto GoogleTokens and splits scope on spaces", async () => {
    fetchMock.mockResolvedValue(okJsonResponse(FULL_TOKEN_PAYLOAD));
    const { exchangeCodeForTokens } = await loadGoogleModule();

    await expect(
      exchangeCodeForTokens(CODE, VERIFIER, REDIRECT_URI)
    ).resolves.toEqual({
      accessToken: "access-1",
      refreshToken: "refresh-2",
      expiresIn: 3599,
      tokenType: "Bearer",
      scope: [DRIVE_SCOPE, USERINFO_SCOPE],
    });
  });

  it("returns an empty scope list when Google omits scope", async () => {
    fetchMock.mockResolvedValue(okJsonResponse(MINIMAL_TOKEN_PAYLOAD));
    const { exchangeCodeForTokens } = await loadGoogleModule();

    await expect(
      exchangeCodeForTokens(CODE, VERIFIER, REDIRECT_URI)
    ).resolves.toEqual({
      accessToken: "access-1",
      refreshToken: undefined,
      expiresIn: undefined,
      tokenType: "Bearer",
      scope: [],
    });
  });

  it("throws with the HTTP status when Google rejects the exchange", async () => {
    fetchMock.mockResolvedValue(failureResponse(400, googleErrorBody()));
    const { exchangeCodeForTokens } = await loadGoogleModule();

    await expect(
      exchangeCodeForTokens(CODE, VERIFIER, REDIRECT_URI)
    ).rejects.toThrowError(TOKEN_EXCHANGE_FAILURE_PATTERN);
  });

  it("redacts token-shaped runs from the failure body but keeps the error code", async () => {
    fetchMock.mockResolvedValue(failureResponse(400, googleErrorBody()));
    const { exchangeCodeForTokens } = await loadGoogleModule();

    await expect(
      exchangeCodeForTokens(CODE, VERIFIER, REDIRECT_URI)
    ).rejects.toThrowError();

    const logged = loggedErrorText();
    expect(logged).not.toContain(LEAKED_TOKEN);
    expect(logged).toContain("[REDACTED]");
    // Short diagnostics stay readable — that is why the floor is 40 and not 20.
    expect(logged).toContain(DIAGNOSTIC_ERROR_CODE);

    const allLogged = allLoggedErrorText(logMock);
    expect(allLogged).not.toContain(LEAKED_TOKEN);
  });

  it("rejects a 200 response whose body does not match the token schema", async () => {
    fetchMock.mockResolvedValue(okJsonResponse({ token_type: "Bearer" }));
    const { exchangeCodeForTokens } = await loadGoogleModule();

    // A missing access_token must fail loudly rather than resolve to a
    // GoogleTokens whose accessToken is undefined.
    await expect(
      exchangeCodeForTokens(CODE, VERIFIER, REDIRECT_URI)
    ).rejects.toThrowError();
  });

  it("propagates a transport failure instead of returning a partial token", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const { exchangeCodeForTokens } = await loadGoogleModule();

    await expect(
      exchangeCodeForTokens(CODE, VERIFIER, REDIRECT_URI)
    ).rejects.toThrowError("network down");
  });
});

describe("refreshAccessToken", () => {
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

  it("posts a refresh_token grant without the PKCE fields", async () => {
    fetchMock.mockResolvedValue(okJsonResponse(FULL_TOKEN_PAYLOAD));
    const { refreshAccessToken } = await loadGoogleModule();

    await refreshAccessToken(REFRESH_TOKEN);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(TOKEN_URL);
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe(
      "application/x-www-form-urlencoded"
    );

    const body = init.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe(REFRESH_TOKEN);
    expect(body.get("client_id")).toBe(CLIENT_ID);
    expect(body.get("client_secret")).toBe(CLIENT_SECRET);
    expect(body.get("code_verifier")).toBeNull();
    expect(body.get("redirect_uri")).toBeNull();
  });

  it("maps the refreshed token response and splits scope on spaces", async () => {
    fetchMock.mockResolvedValue(okJsonResponse(FULL_TOKEN_PAYLOAD));
    const { refreshAccessToken } = await loadGoogleModule();

    await expect(refreshAccessToken(REFRESH_TOKEN)).resolves.toEqual({
      accessToken: "access-1",
      refreshToken: "refresh-2",
      expiresIn: 3599,
      tokenType: "Bearer",
      scope: [DRIVE_SCOPE, USERINFO_SCOPE],
    });
  });

  it("returns an empty scope list when the refresh response omits scope", async () => {
    fetchMock.mockResolvedValue(okJsonResponse(MINIMAL_TOKEN_PAYLOAD));
    const { refreshAccessToken } = await loadGoogleModule();

    // Google routinely omits scope on refresh; an empty list, not a crash, is
    // what the callers that persist `scope` are written against.
    await expect(refreshAccessToken(REFRESH_TOKEN)).resolves.toMatchObject({
      scope: [],
    });
  });

  it("throws with the HTTP status when the refresh is rejected", async () => {
    fetchMock.mockResolvedValue(failureResponse(401, googleErrorBody()));
    const { refreshAccessToken } = await loadGoogleModule();

    await expect(refreshAccessToken(REFRESH_TOKEN)).rejects.toThrowError(
      TOKEN_REFRESH_FAILURE_PATTERN
    );
  });

  it("redacts token-shaped runs from the refresh failure body", async () => {
    fetchMock.mockResolvedValue(failureResponse(401, googleErrorBody()));
    const { refreshAccessToken } = await loadGoogleModule();

    await expect(refreshAccessToken(REFRESH_TOKEN)).rejects.toThrowError();

    const logged = loggedErrorText();
    expect(logged).not.toContain(LEAKED_TOKEN);
    expect(logged).toContain("[REDACTED]");
    expect(logged).toContain(DIAGNOSTIC_ERROR_CODE);

    const allLogged = allLoggedErrorText(logMock);
    expect(allLogged).not.toContain(LEAKED_TOKEN);
  });
});
