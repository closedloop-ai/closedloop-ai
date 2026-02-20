import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { VerifiedApiKeyContext } from "@repo/api/src/types/api-key";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const verifyApiKeyMock = vi.fn();
const checkApiReachableMock = vi.fn();

vi.mock("../api-client.js", () => {
  return {
    verifyApiKey: verifyApiKeyMock,
    checkApiReachable: checkApiReachableMock,
    createApiClient: vi.fn(() => ({})),
  };
});

const DEFAULT_CONTEXT: VerifiedApiKeyContext = {
  userId: "user_1",
  organizationId: "org_1",
  scopes: ["read", "write"],
};

function codeChallengeFor(verifier: string): string {
  return createHash("sha256")
    .update(verifier, "utf8")
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

type HandlerFn = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

type MockResponse = {
  body: string;
  headers: Record<string, string>;
  statusCode: number;
  headersSent: boolean;
  writeHead: (...args: unknown[]) => MockResponse;
  end: (...args: unknown[]) => MockResponse;
};

let handleOAuthAuthorize: HandlerFn;
let handleOAuthToken: HandlerFn;

function createMockRequest(options: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}): IncomingMessage {
  const body = options.body ?? "";
  const req = {
    method: options.method,
    url: options.url,
    headers: options.headers ?? {},
    [Symbol.asyncIterator]() {
      let sent = false;
      return {
        next: () => {
          if (sent || body.length === 0) {
            return Promise.resolve({ done: true, value: undefined });
          }
          sent = true;
          return Promise.resolve({
            done: false,
            value: Buffer.from(body, "utf8"),
          });
        },
      };
    },
  };

  return req as unknown as IncomingMessage;
}

function createMockResponse(): MockResponse {
  const response: MockResponse = {
    body: "",
    headers: {},
    statusCode: 200,
    headersSent: false,
    writeHead(...args: unknown[]) {
      const statusCode = args[0];
      const maybeHeaders = args[1];
      if (typeof statusCode === "number") {
        response.statusCode = statusCode;
      }
      if (
        maybeHeaders &&
        typeof maybeHeaders === "object" &&
        !Array.isArray(maybeHeaders)
      ) {
        response.headers = {
          ...response.headers,
          ...(maybeHeaders as Record<string, string>),
        };
      }
      response.headersSent = true;
      return response;
    },
    end(...args: unknown[]) {
      const chunk = args[0];
      if (chunk !== undefined) {
        response.body += Buffer.isBuffer(chunk)
          ? chunk.toString("utf8")
          : String(chunk);
      }
      response.headersSent = true;
      return response;
    },
  };

  return response;
}

function asServerResponse(response: MockResponse): ServerResponse {
  return response as unknown as ServerResponse;
}

beforeAll(async () => {
  process.env.INTERNAL_API_SECRET = "test-internal-secret";
  process.env.MCP_OAUTH_CLIENT_ID = "closedloop-mcp";
  process.env.MCP_OAUTH_REDIRECT_URIS = "http://localhost:7777/callback";

  const mod = await import("../index.js");
  handleOAuthAuthorize = mod.__testables.handleOAuthAuthorize as HandlerFn;
  handleOAuthToken = mod.__testables.handleOAuthToken as HandlerFn;
});

afterAll(() => {
  vi.resetAllMocks();
});

beforeEach(() => {
  verifyApiKeyMock.mockReset();
  checkApiReachableMock.mockReset();
  checkApiReachableMock.mockResolvedValue(true);
  verifyApiKeyMock.mockImplementation((apiKey: string) => {
    if (apiKey === "sk_live_valid") {
      return DEFAULT_CONTEXT;
    }
    if (apiKey === "sk_live_read_only") {
      return { ...DEFAULT_CONTEXT, scopes: ["read"] };
    }
    return null;
  });
});

describe("OAuth endpoints", () => {
  it("issues an auth code and exchanges it once with PKCE", async () => {
    const verifier = "pkce-verifier-1";
    const challenge = codeChallengeFor(verifier);
    const authorizeUrl = new URL("http://localhost/oauth/authorize");
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", "closedloop-mcp");
    authorizeUrl.searchParams.set(
      "redirect_uri",
      "http://localhost:7777/callback"
    );
    authorizeUrl.searchParams.set("scope", "read");
    authorizeUrl.searchParams.set("state", "state-123");
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const authorizeReq = createMockRequest({
      method: "GET",
      url: `${authorizeUrl.pathname}${authorizeUrl.search}`,
      headers: { authorization: "Bearer sk_live_valid" },
    });
    const authorizeRes = createMockResponse();
    await handleOAuthAuthorize(authorizeReq, asServerResponse(authorizeRes));

    expect(authorizeRes.statusCode).toBe(302);
    const location = authorizeRes.headers.Location;
    expect(location).toBeTruthy();
    const redirect = new URL(location ?? "");
    const code = redirect.searchParams.get("code");
    expect(code).toBeTruthy();
    expect(redirect.searchParams.get("state")).toBe("state-123");

    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "closedloop-mcp",
      code: code ?? "",
      redirect_uri: "http://localhost:7777/callback",
      code_verifier: verifier,
    });

    const tokenReq = createMockRequest({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });
    const tokenRes = createMockResponse();
    await handleOAuthToken(tokenReq, asServerResponse(tokenRes));
    expect(tokenRes.statusCode).toBe(200);
    const tokenJson = JSON.parse(tokenRes.body) as {
      access_token: string;
      scope: string;
    };
    expect(tokenJson.access_token.startsWith("mcp_at_")).toBe(true);
    expect(tokenJson.scope).toBe("read");

    const replayReq = createMockRequest({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });
    const replayRes = createMockResponse();
    await handleOAuthToken(replayReq, asServerResponse(replayRes));
    expect(replayRes.statusCode).toBe(400);
    const replayJson = JSON.parse(replayRes.body) as { error: string };
    expect(replayJson.error).toBe("invalid_grant");
  });

  it("rejects authorization_code exchange with an invalid PKCE verifier", async () => {
    const verifier = "pkce-verifier-2";
    const authorizeUrl = new URL("http://localhost/oauth/authorize");
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", "closedloop-mcp");
    authorizeUrl.searchParams.set(
      "redirect_uri",
      "http://localhost:7777/callback"
    );
    authorizeUrl.searchParams.set("code_challenge", codeChallengeFor(verifier));
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const authorizeReq = createMockRequest({
      method: "GET",
      url: `${authorizeUrl.pathname}${authorizeUrl.search}`,
      headers: { authorization: "Bearer sk_live_valid" },
    });
    const authorizeRes = createMockResponse();
    await handleOAuthAuthorize(authorizeReq, asServerResponse(authorizeRes));
    const location = authorizeRes.headers.Location;
    const redirect = new URL(location ?? "");
    const code = redirect.searchParams.get("code");
    expect(code).toBeTruthy();

    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "closedloop-mcp",
      code: code ?? "",
      redirect_uri: "http://localhost:7777/callback",
      code_verifier: "wrong-verifier",
    });

    const tokenReq = createMockRequest({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });
    const tokenRes = createMockResponse();
    await handleOAuthToken(tokenReq, asServerResponse(tokenRes));
    expect(tokenRes.statusCode).toBe(400);
    const tokenJson = JSON.parse(tokenRes.body) as { error: string };
    expect(tokenJson.error).toBe("invalid_grant");
  });

  it("rejects client_credentials when requested scope exceeds key scopes", async () => {
    const tokenBody = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: "closedloop-mcp",
      client_secret: "sk_live_read_only",
      scope: "write",
    });

    const tokenReq = createMockRequest({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });
    const tokenRes = createMockResponse();
    await handleOAuthToken(tokenReq, asServerResponse(tokenRes));
    expect(tokenRes.statusCode).toBe(400);
    const tokenJson = JSON.parse(tokenRes.body) as { error: string };
    expect(tokenJson.error).toBe("invalid_scope");
  });

  it("rejects authorization_code scope escalation at token exchange", async () => {
    const verifier = "pkce-verifier-scope";
    const authorizeUrl = new URL("http://localhost/oauth/authorize");
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", "closedloop-mcp");
    authorizeUrl.searchParams.set(
      "redirect_uri",
      "http://localhost:7777/callback"
    );
    authorizeUrl.searchParams.set("scope", "read");
    authorizeUrl.searchParams.set("code_challenge", codeChallengeFor(verifier));
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const authorizeReq = createMockRequest({
      method: "GET",
      url: `${authorizeUrl.pathname}${authorizeUrl.search}`,
      headers: { authorization: "Bearer sk_live_valid" },
    });
    const authorizeRes = createMockResponse();
    await handleOAuthAuthorize(authorizeReq, asServerResponse(authorizeRes));
    const location = authorizeRes.headers.Location;
    const redirect = new URL(location ?? "");
    const code = redirect.searchParams.get("code");
    expect(code).toBeTruthy();

    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "closedloop-mcp",
      code: code ?? "",
      redirect_uri: "http://localhost:7777/callback",
      code_verifier: verifier,
      scope: "write",
    });

    const tokenReq = createMockRequest({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });
    const tokenRes = createMockResponse();
    await handleOAuthToken(tokenReq, asServerResponse(tokenRes));
    expect(tokenRes.statusCode).toBe(400);
    const tokenJson = JSON.parse(tokenRes.body) as { error: string };
    expect(tokenJson.error).toBe("invalid_scope");
  });

  it("rejects authorization_code exchange for client mismatch", async () => {
    const verifier = "pkce-verifier-client";
    const authorizeUrl = new URL("http://localhost/oauth/authorize");
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", "closedloop-mcp");
    authorizeUrl.searchParams.set(
      "redirect_uri",
      "http://localhost:7777/callback"
    );
    authorizeUrl.searchParams.set("code_challenge", codeChallengeFor(verifier));
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const authorizeReq = createMockRequest({
      method: "GET",
      url: `${authorizeUrl.pathname}${authorizeUrl.search}`,
      headers: { authorization: "Bearer sk_live_valid" },
    });
    const authorizeRes = createMockResponse();
    await handleOAuthAuthorize(authorizeReq, asServerResponse(authorizeRes));
    const location = authorizeRes.headers.Location;
    const redirect = new URL(location ?? "");
    const code = redirect.searchParams.get("code");
    expect(code).toBeTruthy();

    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "wrong-client",
      code: code ?? "",
      redirect_uri: "http://localhost:7777/callback",
      code_verifier: verifier,
    });

    const tokenReq = createMockRequest({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });
    const tokenRes = createMockResponse();
    await handleOAuthToken(tokenReq, asServerResponse(tokenRes));
    expect(tokenRes.statusCode).toBe(401);
    const tokenJson = JSON.parse(tokenRes.body) as { error: string };
    expect(tokenJson.error).toBe("invalid_client");
  });

  it("rejects authorization_code exchange for redirect_uri mismatch", async () => {
    const verifier = "pkce-verifier-redirect";
    const authorizeUrl = new URL("http://localhost/oauth/authorize");
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", "closedloop-mcp");
    authorizeUrl.searchParams.set(
      "redirect_uri",
      "http://localhost:7777/callback"
    );
    authorizeUrl.searchParams.set("code_challenge", codeChallengeFor(verifier));
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const authorizeReq = createMockRequest({
      method: "GET",
      url: `${authorizeUrl.pathname}${authorizeUrl.search}`,
      headers: { authorization: "Bearer sk_live_valid" },
    });
    const authorizeRes = createMockResponse();
    await handleOAuthAuthorize(authorizeReq, asServerResponse(authorizeRes));
    const location = authorizeRes.headers.Location;
    const redirect = new URL(location ?? "");
    const code = redirect.searchParams.get("code");
    expect(code).toBeTruthy();

    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "closedloop-mcp",
      code: code ?? "",
      redirect_uri: "http://localhost:9999/other",
      code_verifier: verifier,
    });

    const tokenReq = createMockRequest({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });
    const tokenRes = createMockResponse();
    await handleOAuthToken(tokenReq, asServerResponse(tokenRes));
    expect(tokenRes.statusCode).toBe(400);
    const tokenJson = JSON.parse(tokenRes.body) as { error: string };
    expect(tokenJson.error).toBe("invalid_grant");
  });

  it("rejects authorization_code exchange for expired code", async () => {
    const verifier = "pkce-verifier-expired";
    const authorizeUrl = new URL("http://localhost/oauth/authorize");
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", "closedloop-mcp");
    authorizeUrl.searchParams.set(
      "redirect_uri",
      "http://localhost:7777/callback"
    );
    authorizeUrl.searchParams.set("code_challenge", codeChallengeFor(verifier));
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const authorizeReq = createMockRequest({
      method: "GET",
      url: `${authorizeUrl.pathname}${authorizeUrl.search}`,
      headers: { authorization: "Bearer sk_live_valid" },
    });
    const authorizeRes = createMockResponse();
    await handleOAuthAuthorize(authorizeReq, asServerResponse(authorizeRes));
    const location = authorizeRes.headers.Location;
    const redirect = new URL(location ?? "");
    const code = redirect.searchParams.get("code");
    expect(code).toBeTruthy();

    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 700_000);
    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "closedloop-mcp",
      code: code ?? "",
      redirect_uri: "http://localhost:7777/callback",
      code_verifier: verifier,
    });

    const tokenReq = createMockRequest({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });
    const tokenRes = createMockResponse();
    await handleOAuthToken(tokenReq, asServerResponse(tokenRes));
    nowSpy.mockRestore();

    expect(tokenRes.statusCode).toBe(400);
    const tokenJson = JSON.parse(tokenRes.body) as { error: string };
    expect(tokenJson.error).toBe("invalid_grant");
  });

  it("rejects unauthorized redirect_uri at authorization step", async () => {
    const authorizeUrl = new URL("http://localhost/oauth/authorize");
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", "closedloop-mcp");
    authorizeUrl.searchParams.set(
      "redirect_uri",
      "http://localhost:9999/not-allowed"
    );
    authorizeUrl.searchParams.set("code_challenge", codeChallengeFor("pkce"));
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const authorizeReq = createMockRequest({
      method: "GET",
      url: `${authorizeUrl.pathname}${authorizeUrl.search}`,
      headers: { authorization: "Bearer sk_live_valid" },
    });
    const authorizeRes = createMockResponse();
    await handleOAuthAuthorize(authorizeReq, asServerResponse(authorizeRes));

    expect(authorizeRes.statusCode).toBe(400);
    const json = JSON.parse(authorizeRes.body) as { error: string };
    expect(json.error).toBe("invalid_request");
  });
});
