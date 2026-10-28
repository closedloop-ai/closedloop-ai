import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLIENT_ID,
  CLIENT_ID_ENV,
  CLIENT_SECRET,
  CLIENT_SECRET_ENV,
  clearCredentialEnv,
  loadGoogleModule,
  okJsonResponse,
  setCredentialEnv,
} from "./google-test-fixtures";

/**
 * The credential gate every OAuth call passes through.
 *
 * `getConfig` and `getRequiredCredentials` are module-private, so they are
 * exercised here through `exchangeCodeForTokens` — the shallowest exported
 * caller. What is pinned is the gate itself: when it refuses, what it refuses
 * on, and the fact that it reads the environment exactly once per process.
 */

vi.mock("server-only", () => ({}));

vi.mock("googleapis", () => ({
  google: { drive: vi.fn() },
}));

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const NOT_CONFIGURED_MESSAGE =
  "Google integration not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.";

const TOKEN_PAYLOAD = {
  access_token: "access-1",
  token_type: "Bearer",
  scope: "https://www.googleapis.com/auth/drive.readonly",
};

const CODE = "auth-code-1";
const VERIFIER = "code-verifier-1";
const REDIRECT_URI = "https://app.example.test/callback";

describe("credential configuration gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("refuses the exchange when neither credential is set", async () => {
    clearCredentialEnv();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { exchangeCodeForTokens } = await loadGoogleModule();

    await expect(
      exchangeCodeForTokens(CODE, VERIFIER, REDIRECT_URI)
    ).rejects.toThrowError(NOT_CONFIGURED_MESSAGE);
    // The gate must run before the network call, or a misconfigured deploy
    // would hit Google with an empty client_id and get an opaque 400 back.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses the exchange when only the client id is set", async () => {
    clearCredentialEnv();
    vi.stubEnv(CLIENT_ID_ENV, CLIENT_ID);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { exchangeCodeForTokens } = await loadGoogleModule();

    await expect(
      exchangeCodeForTokens(CODE, VERIFIER, REDIRECT_URI)
    ).rejects.toThrowError(NOT_CONFIGURED_MESSAGE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses the exchange when only the client secret is set", async () => {
    clearCredentialEnv();
    vi.stubEnv(CLIENT_SECRET_ENV, CLIENT_SECRET);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { exchangeCodeForTokens } = await loadGoogleModule();

    await expect(
      exchangeCodeForTokens(CODE, VERIFIER, REDIRECT_URI)
    ).rejects.toThrowError(NOT_CONFIGURED_MESSAGE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats an empty client secret as unset", async () => {
    clearCredentialEnv();
    vi.stubEnv(CLIENT_ID_ENV, CLIENT_ID);
    // `keys()` sets emptyStringAsUndefined, so a blank var in a .env file is
    // the same as a missing one rather than a credential of length zero.
    vi.stubEnv(CLIENT_SECRET_ENV, "");
    vi.stubGlobal("fetch", vi.fn());

    const { exchangeCodeForTokens } = await loadGoogleModule();

    await expect(
      exchangeCodeForTokens(CODE, VERIFIER, REDIRECT_URI)
    ).rejects.toThrowError(NOT_CONFIGURED_MESSAGE);
  });

  it("passes both credentials to Google when they are configured", async () => {
    setCredentialEnv();
    const fetchMock = vi.fn().mockResolvedValue(okJsonResponse(TOKEN_PAYLOAD));
    vi.stubGlobal("fetch", fetchMock);

    const { exchangeCodeForTokens } = await loadGoogleModule();

    await expect(
      exchangeCodeForTokens(CODE, VERIFIER, REDIRECT_URI)
    ).resolves.toMatchObject({ accessToken: "access-1" });

    const body = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(body.get("client_id")).toBe(CLIENT_ID);
    expect(body.get("client_secret")).toBe(CLIENT_SECRET);
  });

  it("reads the environment once and keeps serving the first result", async () => {
    setCredentialEnv();
    const fetchMock = vi.fn().mockResolvedValue(okJsonResponse(TOKEN_PAYLOAD));
    vi.stubGlobal("fetch", fetchMock);

    const { exchangeCodeForTokens } = await loadGoogleModule();
    await exchangeCodeForTokens(CODE, VERIFIER, REDIRECT_URI);

    // Pins current behavior: `_config` is memoized on first use, so clearing
    // the credentials afterwards does NOT re-close the gate. Looks odd because
    // a rotated-to-empty secret stays live until the process restarts — but
    // this is what main does, and every caller today is a long-lived server.
    clearCredentialEnv();

    await expect(
      exchangeCodeForTokens(CODE, VERIFIER, REDIRECT_URI)
    ).resolves.toMatchObject({ accessToken: "access-1" });

    const secondBody = fetchMock.mock.calls[1]?.[1]?.body as URLSearchParams;
    expect(secondBody.get("client_secret")).toBe(CLIENT_SECRET);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
