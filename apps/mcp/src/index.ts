import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  API_KEY_SCOPES,
  type VerifiedApiKeyContext,
} from "@repo/api/src/types/api-key";
import { withDb } from "@repo/database";
import {
  type ApiClient,
  checkApiReachable,
  createApiClient,
  verifyApiKey,
} from "./api-client.js";
import { registerBatchCreateArtifacts } from "./tools/batch-create-artifacts.js";
import { registerCreateArtifact } from "./tools/create-artifact.js";
import { registerCreateArtifactVersion } from "./tools/create-artifact-version.js";
import { registerCreateEntityLink } from "./tools/create-entity-link.js";
import { registerCreateExternalLink } from "./tools/create-external-link.js";
import { registerCreateIssue } from "./tools/create-issue.js";
import { registerCreateProject } from "./tools/create-project.js";
import { registerCreateWorkstream } from "./tools/create-workstream.js";
import { registerGeneratePlans } from "./tools/generate-plans.js";
import { registerGetArtifact } from "./tools/get-artifact.js";
import { registerGetDashboardStats } from "./tools/get-dashboard-stats.js";
import { registerGetGithubStatus } from "./tools/get-github-status.js";
import { registerGetGoogleStatus } from "./tools/get-google-status.js";
import { registerGetIssue } from "./tools/get-issue.js";
import { registerGetLinearStatus } from "./tools/get-linear-status.js";
import { registerGetLoop } from "./tools/get-loop.js";
import { registerGetProject } from "./tools/get-project.js";
import { registerGetProjectStatus } from "./tools/get-project-status.js";
import { registerGetRelatedArtifacts } from "./tools/get-related-artifacts.js";
import { registerGetWorkstream } from "./tools/get-workstream.js";
import { registerListArtifactVersions } from "./tools/list-artifact-versions.js";
import { registerListArtifacts } from "./tools/list-artifacts.js";
import { registerListEntityLinks } from "./tools/list-entity-links.js";
import { registerListExternalLinks } from "./tools/list-external-links.js";
import { registerListIssues } from "./tools/list-issues.js";
import { registerListLoops } from "./tools/list-loops.js";
import { registerListProjects } from "./tools/list-projects.js";
import { registerListTemplates } from "./tools/list-templates.js";
import { registerListUsers } from "./tools/list-users.js";
import { registerListWorkstreams } from "./tools/list-workstreams.js";
import { registerUpdateArtifact } from "./tools/update-artifact.js";
import { registerUpdateIssue } from "./tools/update-issue.js";
import { registerUpdateProject } from "./tools/update-project.js";
import { registerUpdateWorkstream } from "./tools/update-workstream.js";

const BEARER_API_KEY_REGEX = /^Bearer\s+(sk_live_\S+)$/;
const BEARER_OAUTH_TOKEN_REGEX = /^Bearer\s+(mcp_at_[A-Za-z0-9._-]+)$/;
const OAUTH_TOKEN_PREFIX_REGEX = /^mcp_at_/;
const SCOPE_SPLIT_REGEX = /\s+/;
const PORT = Number(process.env.MCP_PORT ?? 3010);
const SUPPORTED_PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26"];
const MCP_SERVER_URL = process.env.MCP_SERVER_URL ?? `http://localhost:${PORT}`;
const OAUTH_CLIENT_ID = process.env.MCP_OAUTH_CLIENT_ID ?? "closedloop-mcp";
const OAUTH_TOKEN_TTL_SECONDS = Number(
  process.env.MCP_OAUTH_TOKEN_TTL_SECONDS ?? 3600
);
const OAUTH_AUTH_CODE_TTL_SECONDS = Number(
  process.env.MCP_OAUTH_AUTH_CODE_TTL_SECONDS ?? 600
);
const NODE_ENV = process.env.NODE_ENV ?? "development";
const WEBAPP_ENV = process.env.WEBAPP_ENV ?? "local";
const OAUTH_RATE_LIMIT_WINDOW_MS = Number(
  process.env.MCP_OAUTH_RATE_LIMIT_WINDOW_MS ?? 60_000
);
const OAUTH_RATE_LIMIT_AUTHORIZE_MAX = Number(
  process.env.MCP_OAUTH_RATE_LIMIT_AUTHORIZE_MAX ?? 120
);
const OAUTH_RATE_LIMIT_TOKEN_MAX = Number(
  process.env.MCP_OAUTH_RATE_LIMIT_TOKEN_MAX ?? 60
);
const OAUTH_CLEANUP_INTERVAL_MS = Number(
  process.env.MCP_OAUTH_CLEANUP_INTERVAL_MS ?? 300_000
);
const MCP_SERVER_CACHE_TTL_MS = Number(
  process.env.MCP_SERVER_CACHE_TTL_MS ?? 60_000
);
const MAX_REQUEST_BODY_BYTES = Number(
  process.env.MCP_MAX_REQUEST_BODY_BYTES ?? 1_048_576
);
const TRUST_PROXY = ["1", "true", "yes"].includes(
  (process.env.MCP_TRUST_PROXY ?? "").toLowerCase()
);
const OAUTH_REDIRECT_URI_ALLOWLIST = (process.env.MCP_OAUTH_REDIRECT_URIS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const INTERNAL_ENDPOINT_ALLOWLIST = (process.env.MCP_INTERNAL_ALLOWED_IPS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Request body too large");
  }
}

function isLocalOauthEnvironment(): boolean {
  if (
    NODE_ENV === "production" ||
    WEBAPP_ENV === "stage" ||
    WEBAPP_ENV === "prod"
  ) {
    return false;
  }

  return (
    NODE_ENV === "development" || NODE_ENV === "test" || WEBAPP_ENV === "local"
  );
}

function getOAuthRedirectUriAllowlist(): string[] {
  return OAUTH_REDIRECT_URI_ALLOWLIST;
}

function getInternalEndpointAllowlist(): string[] {
  return INTERNAL_ENDPOINT_ALLOWLIST;
}

function requireRedirectAllowlistForEnvironment(): void {
  if (
    !isLocalOauthEnvironment() &&
    getOAuthRedirectUriAllowlist().length === 0
  ) {
    throw new Error(
      "MCP_OAUTH_REDIRECT_URIS must be set in non-local environments"
    );
  }
}

function requireInternalAllowlistForEnvironment(): void {
  if (
    !isLocalOauthEnvironment() &&
    getInternalEndpointAllowlist().length === 0
  ) {
    throw new Error(
      "MCP_INTERNAL_ALLOWED_IPS must be set in non-local environments"
    );
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is required but not set`);
  }
  return value;
}

const INTERNAL_AUTH_SECRET =
  process.env.MCP_INTERNAL_AUTH_SECRET ?? requireEnv("INTERNAL_API_SECRET");
const OAUTH_SIGNING_SECRET =
  process.env.MCP_OAUTH_SIGNING_SECRET ?? requireEnv("INTERNAL_API_SECRET");
const OAUTH_ENCRYPTION_SECRET =
  process.env.MCP_OAUTH_ENCRYPTION_SECRET ?? OAUTH_SIGNING_SECRET;
const OAUTH_PREVIOUS_SIGNING_SECRETS = (
  process.env.MCP_OAUTH_SIGNING_SECRETS ?? ""
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

type OAuthSigningKeyEntry = {
  encryptionKey: Buffer;
  kid: string;
  signingSecret: string;
};

function createSigningKeyEntry(secret: string): OAuthSigningKeyEntry {
  const kid = createHash("sha256")
    .update(secret, "utf8")
    .digest("hex")
    .slice(0, 16);
  return {
    kid,
    signingSecret: secret,
    encryptionKey: createHash("sha256")
      .update(`${OAUTH_ENCRYPTION_SECRET}:${kid}:api-key-encryption`, "utf8")
      .digest(),
  };
}

const OAUTH_SIGNING_KEYS = [
  createSigningKeyEntry(OAUTH_SIGNING_SECRET),
  ...OAUTH_PREVIOUS_SIGNING_SECRETS.map(createSigningKeyEntry),
];
const OAUTH_CURRENT_SIGNING_KEY = OAUTH_SIGNING_KEYS[0];
const OAUTH_SIGNING_KEY_BY_KID = new Map(
  OAUTH_SIGNING_KEYS.map((entry) => [entry.kid, entry] as const)
);
const API_KEY_SCOPE_SET = new Set<string>(API_KEY_SCOPES);
const OAUTH_NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  Pragma: "no-cache",
};

type ToolRegistration = {
  name: string;
  register: (server: McpServer, apiClient: ApiClient) => void;
  requiresWrite?: boolean;
};

const TOOL_REGISTRATIONS: ToolRegistration[] = [
  {
    name: "ping",
    register: (server) => {
      server.tool("ping", "Check MCP server connectivity", {}, () =>
        Promise.resolve({
          content: [{ type: "text" as const, text: "pong" }],
        })
      );
    },
  },
  { name: "list-projects", register: registerListProjects },
  { name: "get-project", register: registerGetProject },
  {
    name: "create-project",
    register: registerCreateProject,
    requiresWrite: true,
  },
  {
    name: "update-project",
    register: registerUpdateProject,
    requiresWrite: true,
  },
  { name: "get-project-status", register: registerGetProjectStatus },
  { name: "list-artifacts", register: registerListArtifacts },
  { name: "get-artifact", register: registerGetArtifact },
  {
    name: "create-artifact",
    register: registerCreateArtifact,
    requiresWrite: true,
  },
  {
    name: "update-artifact",
    register: registerUpdateArtifact,
    requiresWrite: true,
  },
  {
    name: "batch-create-artifacts",
    register: registerBatchCreateArtifacts,
    requiresWrite: true,
  },
  {
    name: "create-artifact-version",
    register: registerCreateArtifactVersion,
    requiresWrite: true,
  },
  { name: "list-artifact-versions", register: registerListArtifactVersions },
  { name: "get-related-artifacts", register: registerGetRelatedArtifacts },
  { name: "list-issues", register: registerListIssues },
  { name: "get-issue", register: registerGetIssue },
  {
    name: "create-issue",
    register: registerCreateIssue,
    requiresWrite: true,
  },
  {
    name: "update-issue",
    register: registerUpdateIssue,
    requiresWrite: true,
  },
  { name: "list-workstreams", register: registerListWorkstreams },
  { name: "get-workstream", register: registerGetWorkstream },
  {
    name: "create-workstream",
    register: registerCreateWorkstream,
    requiresWrite: true,
  },
  {
    name: "update-workstream",
    register: registerUpdateWorkstream,
    requiresWrite: true,
  },
  { name: "list-loops", register: registerListLoops },
  { name: "get-loop", register: registerGetLoop },
  { name: "list-users", register: registerListUsers },
  { name: "get-dashboard-stats", register: registerGetDashboardStats },
  { name: "list-entity-links", register: registerListEntityLinks },
  {
    name: "create-entity-link",
    register: registerCreateEntityLink,
    requiresWrite: true,
  },
  { name: "list-external-links", register: registerListExternalLinks },
  {
    name: "create-external-link",
    register: registerCreateExternalLink,
    requiresWrite: true,
  },
  { name: "list-templates", register: registerListTemplates },
  { name: "get-github-status", register: registerGetGithubStatus },
  { name: "get-linear-status", register: registerGetLinearStatus },
  { name: "get-google-status", register: registerGetGoogleStatus },
  {
    name: "generate-plans",
    register: registerGeneratePlans,
    requiresWrite: true,
  },
];

/**
 * Tool manifest for /.well-known/mcp.json Server Card.
 * Built once at startup from the tool registration list.
 */
const TOOL_NAMES = TOOL_REGISTRATIONS.map((entry) => entry.name);

/**
 * Create a new MCP server instance with all tools registered.
 * Each session gets its own McpServer bound to a verified API key context.
 */
function createMcpServer(
  context: VerifiedApiKeyContext,
  plaintextKey: string,
  grantedScopes: string[]
): McpServer {
  const server = new McpServer({
    name: "closedloop",
    version: "0.0.1",
  });

  const apiClient = createApiClient(context, plaintextKey);
  const allowWriteTools = hasWriteScope(grantedScopes);

  for (const registration of TOOL_REGISTRATIONS) {
    if (registration.requiresWrite && !allowWriteTools) {
      continue;
    }
    registration.register(server, apiClient);
  }

  return server;
}

/**
 * Extract the API key from the Authorization header.
 * Accepts "Bearer sk_live_..." format.
 */
function extractApiKey(authHeader: string | null): string | null {
  if (!authHeader) {
    return null;
  }
  const match = BEARER_API_KEY_REGEX.exec(authHeader);
  return match ? match[1] : null;
}

function extractOAuthToken(authHeader: string | null): string | null {
  if (!authHeader) {
    return null;
  }
  const match = BEARER_OAUTH_TOKEN_REGEX.exec(authHeader);
  return match ? match[1] : null;
}

type OAuthAccessTokenPayload = {
  apiKeyCiphertext: string;
  kid: string;
  userId: string;
  organizationId: string;
  scopes: string[];
  exp: number;
  iat: number;
};

type AuthorizationCodeRecord = {
  encryptedApiKey: string;
  keyId: string;
  userId: string;
  organizationId: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  codeChallenge: string;
  codeChallengeMethod: "S256";
  expiresAt: Date;
};

function effectiveKeyScopes(scopes: string[]): string[] {
  return scopes.length > 0 ? scopes : [...API_KEY_SCOPES];
}

function hasWriteScope(scopes: string[]): boolean {
  return scopes.includes("write");
}

let lastOAuthCleanupMs = 0;
const OAUTH_CLEANUP_LOCK_ID = 8_173_421;

async function maybeCleanupOAuthSecurityTables(): Promise<void> {
  const nowMs = Date.now();
  if (nowMs - lastOAuthCleanupMs < OAUTH_CLEANUP_INTERVAL_MS) {
    return;
  }

  await withDb(async (db) => {
    const client = db as unknown as {
      $queryRawUnsafe?: (
        query: string,
        ...values: unknown[]
      ) => Promise<unknown>;
    };
    if (!client.$queryRawUnsafe) {
      await runOAuthCleanupQueries(nowMs);
      return;
    }

    const lockRows = (await client.$queryRawUnsafe(
      "SELECT pg_try_advisory_lock($1) AS locked",
      OAUTH_CLEANUP_LOCK_ID
    )) as Array<{ locked: boolean }> | undefined;
    if (!lockRows?.[0]?.locked) {
      return;
    }

    try {
      await runOAuthCleanupQueries(nowMs);
    } finally {
      await client.$queryRawUnsafe(
        "SELECT pg_advisory_unlock($1)",
        OAUTH_CLEANUP_LOCK_ID
      );
    }
  });
  lastOAuthCleanupMs = nowMs;
}

async function runOAuthCleanupQueries(nowMs: number): Promise<void> {
  await Promise.allSettled([
    cleanupExpiredAuthorizationCodes(),
    cleanupExpiredRevokedTokens(),
    withDb((db) =>
      db.oAuthRateLimit.deleteMany({
        where: { windowExpiresAt: { lte: new Date(nowMs) } },
      })
    ),
  ]);
}

async function cleanupExpiredAuthorizationCodes(): Promise<void> {
  await withDb((db) =>
    db.oAuthAuthorizationCode.deleteMany({
      where: {
        OR: [{ expiresAt: { lte: new Date() } }, { consumedAt: { not: null } }],
      },
    })
  );
}

async function storeAuthorizationCode(
  code: string,
  record: AuthorizationCodeRecord
): Promise<void> {
  await withDb((db) =>
    db.oAuthAuthorizationCode.create({
      data: {
        code,
        encryptedApiKey: record.encryptedApiKey,
        keyId: record.keyId,
        userId: record.userId,
        organizationId: record.organizationId,
        clientId: record.clientId,
        redirectUri: record.redirectUri,
        scopes: record.scopes,
        codeChallenge: record.codeChallenge,
        codeChallengeMethod: record.codeChallengeMethod,
        expiresAt: record.expiresAt,
      },
    })
  );
}

function consumeAuthorizationCode(
  code: string
): Promise<AuthorizationCodeRecord | null> {
  return withDb.tx(async (db) => {
    const now = new Date();
    const record = await db.oAuthAuthorizationCode.findUnique({
      where: { code },
    });
    if (!record || record.consumedAt !== null || record.expiresAt <= now) {
      return null;
    }

    const consumeResult = await db.oAuthAuthorizationCode.updateMany({
      where: { id: record.id, consumedAt: null },
      data: { consumedAt: now },
    });
    if (consumeResult.count !== 1) {
      return null;
    }

    return {
      encryptedApiKey: record.encryptedApiKey,
      keyId: record.keyId,
      userId: record.userId,
      organizationId: record.organizationId,
      clientId: record.clientId,
      redirectUri: record.redirectUri,
      scopes: record.scopes,
      codeChallenge: record.codeChallenge,
      codeChallengeMethod: record.codeChallengeMethod as "S256",
      expiresAt: record.expiresAt,
    };
  });
}

function getAccessTokenFingerprint(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

async function cleanupExpiredRevokedTokens(): Promise<void> {
  await withDb((db) =>
    db.oAuthRevokedToken.deleteMany({
      where: { expiresAt: { lte: new Date() } },
    })
  );
}

async function revokeAccessToken(
  token: string,
  expiresAtMs: number
): Promise<void> {
  const fingerprint = getAccessTokenFingerprint(token);
  await withDb((db) =>
    db.oAuthRevokedToken.upsert({
      where: { tokenFingerprint: fingerprint },
      create: {
        tokenFingerprint: fingerprint,
        expiresAt: new Date(expiresAtMs),
      },
      update: {
        expiresAt: new Date(expiresAtMs),
        revokedAt: new Date(),
      },
    })
  );
}

async function isAccessTokenRevoked(token: string): Promise<boolean> {
  const fingerprint = getAccessTokenFingerprint(token);
  const tokenRecord = await withDb((db) =>
    db.oAuthRevokedToken.findUnique({
      where: { tokenFingerprint: fingerprint },
      select: { expiresAt: true },
    })
  );
  return tokenRecord !== null && tokenRecord.expiresAt.getTime() > Date.now();
}

function normalizeAddress(address: string): string {
  return address.startsWith("::ffff:")
    ? address.slice("::ffff:".length)
    : address;
}

function getClientAddress(req: import("node:http").IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (
    TRUST_PROXY &&
    typeof forwarded === "string" &&
    forwarded.trim().length > 0
  ) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) {
      return normalizeAddress(first);
    }
  }
  return normalizeAddress(req.socket?.remoteAddress ?? "unknown");
}

function isInternalAddressAllowed(address: string): boolean {
  const allowlist = getInternalEndpointAllowlist();
  if (allowlist.length > 0) {
    return allowlist.includes(address);
  }

  if (!isLocalOauthEnvironment()) {
    return false;
  }

  return (
    address === "localhost" || address === "127.0.0.1" || address === "::1"
  );
}

function consumeOAuthRateLimit(
  req: import("node:http").IncomingMessage,
  bucket: "authorize" | "token"
): Promise<{ limited: boolean; retryAfterSeconds: number }> {
  const limit =
    bucket === "authorize"
      ? OAUTH_RATE_LIMIT_AUTHORIZE_MAX
      : OAUTH_RATE_LIMIT_TOKEN_MAX;
  const now = new Date();
  const address = getClientAddress(req);

  return withDb.tx(async (db) => {
    const windowExpiresAt = new Date(
      now.getTime() + OAUTH_RATE_LIMIT_WINDOW_MS
    );
    const record = await db.oAuthRateLimit.findUnique({
      where: {
        bucket_subject: {
          bucket,
          subject: address,
        },
      },
    });

    if (!record || record.windowExpiresAt <= now) {
      await db.oAuthRateLimit.upsert({
        where: {
          bucket_subject: {
            bucket,
            subject: address,
          },
        },
        create: {
          bucket,
          subject: address,
          requestCount: 1,
          windowStartedAt: now,
          windowExpiresAt,
        },
        update: {
          requestCount: 1,
          windowStartedAt: now,
          windowExpiresAt,
        },
      });
      return { limited: false, retryAfterSeconds: 0 };
    }

    const incrementResult = await db.oAuthRateLimit.updateMany({
      where: {
        id: record.id,
        requestCount: { lt: limit },
      },
      data: { requestCount: { increment: 1 } },
    });
    if (incrementResult.count === 0) {
      return {
        limited: true,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((record.windowExpiresAt.getTime() - now.getTime()) / 1000)
        ),
      };
    }

    return { limited: false, retryAfterSeconds: 0 };
  });
}

function b64urlEncode(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function b64urlDecode(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(normalized + padding, "base64").toString("utf8");
}

function signTokenPayload(payloadB64: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(payloadB64)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function sha256Base64Url(input: string): string {
  return createHash("sha256")
    .update(input, "utf8")
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const digestKey = "mcp-constant-time-compare";
  const aDigest = createHmac("sha256", digestKey).update(a, "utf8").digest();
  const bDigest = createHmac("sha256", digestKey).update(b, "utf8").digest();
  return timingSafeEqual(aDigest, bDigest);
}

function encryptApiKey(apiKey: string, keyId: string): string {
  const keyEntry = OAUTH_SIGNING_KEY_BY_KID.get(keyId);
  if (!keyEntry) {
    throw new Error("Unknown OAuth key id");
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyEntry.encryptionKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(apiKey, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("base64url")}.${authTag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

function decryptApiKey(encrypted: string, keyId: string): string | null {
  const keyEntry = OAUTH_SIGNING_KEY_BY_KID.get(keyId);
  if (!keyEntry) {
    return null;
  }

  const parts = encrypted.split(".");
  if (parts.length !== 3) {
    return null;
  }

  try {
    const [ivPart, tagPart, ciphertextPart] = parts;
    const iv = Buffer.from(ivPart, "base64url");
    const authTag = Buffer.from(tagPart, "base64url");
    const ciphertext = Buffer.from(ciphertextPart, "base64url");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      keyEntry.encryptionKey,
      iv
    );
    decipher.setAuthTag(authTag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

function issueOAuthAccessToken(
  apiKey: string,
  context: VerifiedApiKeyContext,
  scopes: string[]
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: OAuthAccessTokenPayload = {
    apiKeyCiphertext: encryptApiKey(apiKey, OAUTH_CURRENT_SIGNING_KEY.kid),
    kid: OAUTH_CURRENT_SIGNING_KEY.kid,
    userId: context.userId,
    organizationId: context.organizationId,
    scopes,
    iat: now,
    exp: now + OAUTH_TOKEN_TTL_SECONDS,
  };
  const payloadB64 = b64urlEncode(JSON.stringify(payload));
  const signature = signTokenPayload(
    payloadB64,
    OAUTH_CURRENT_SIGNING_KEY.signingSecret
  );
  return `mcp_at_${payloadB64}.${signature}`;
}

function parseSignedOAuthAccessToken(
  token: string
): OAuthAccessTokenPayload | null {
  const raw = token.replace(OAUTH_TOKEN_PREFIX_REGEX, "");
  const parts = raw.split(".");
  if (parts.length !== 2) {
    return null;
  }
  const [payloadB64, signatureB64] = parts;
  try {
    const payload = JSON.parse(
      b64urlDecode(payloadB64)
    ) as Partial<OAuthAccessTokenPayload>;
    const keyCandidates =
      payload.kid && OAUTH_SIGNING_KEY_BY_KID.has(payload.kid)
        ? [OAUTH_SIGNING_KEY_BY_KID.get(payload.kid)]
        : OAUTH_SIGNING_KEYS;
    const actualSigBuf = Buffer.from(signatureB64, "utf8");
    const matchedEntry =
      keyCandidates.find((entry) => {
        if (!entry) {
          return false;
        }
        const expectedSig = signTokenPayload(payloadB64, entry.signingSecret);
        const expectedSigBuf = Buffer.from(expectedSig, "utf8");
        return (
          actualSigBuf.length === expectedSigBuf.length &&
          timingSafeEqual(actualSigBuf, expectedSigBuf)
        );
      }) ?? null;
    if (!matchedEntry) {
      return null;
    }

    const resolvedKid =
      payload.kid && OAUTH_SIGNING_KEY_BY_KID.has(payload.kid)
        ? payload.kid
        : matchedEntry.kid;
    const now = Math.floor(Date.now() / 1000);
    if (
      !payload.apiKeyCiphertext ||
      typeof payload.exp !== "number" ||
      !Array.isArray(payload.scopes) ||
      !payload.scopes.every(
        (scope) => typeof scope === "string" && API_KEY_SCOPE_SET.has(scope)
      ) ||
      typeof payload.userId !== "string" ||
      typeof payload.organizationId !== "string" ||
      payload.exp <= now
    ) {
      return null;
    }

    return {
      apiKeyCiphertext: payload.apiKeyCiphertext,
      kid: resolvedKid,
      userId: payload.userId,
      organizationId: payload.organizationId,
      scopes: payload.scopes,
      iat: typeof payload.iat === "number" ? payload.iat : now,
      exp: payload.exp,
    };
  } catch {
    return null;
  }
}

async function verifyOAuthAccessToken(
  token: string
): Promise<OAuthAccessTokenPayload | null> {
  await maybeCleanupOAuthSecurityTables();
  if (await isAccessTokenRevoked(token)) {
    return null;
  }
  return parseSignedOAuthAccessToken(token);
}

function sendJson(
  res: import("node:http").ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>
): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function sendOAuthJson(
  res: import("node:http").ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>
): void {
  sendJson(res, status, body, {
    ...OAUTH_NO_STORE_HEADERS,
    ...extraHeaders,
  });
}

function isInternalSecretValid(
  req: import("node:http").IncomingMessage
): boolean {
  const provided = req.headers["x-internal-secret"];
  return (
    typeof provided === "string" &&
    timingSafeStringEqual(provided, INTERNAL_AUTH_SECRET)
  );
}

function isInternalRequestAuthorized(
  req: import("node:http").IncomingMessage
): boolean {
  return (
    isInternalSecretValid(req) &&
    isInternalAddressAllowed(getClientAddress(req))
  );
}

function sendInternalUnauthorized(
  res: import("node:http").ServerResponse
): void {
  sendJson(res, 401, { error: "Unauthorized internal request" });
}

async function handleReady(
  res: import("node:http").ServerResponse
): Promise<void> {
  const apiReachable = await checkApiReachable();
  sendJson(res, apiReachable ? 200 : 503, {
    status: apiReachable ? "ready" : "not_ready",
    checks: { api: apiReachable ? "reachable" : "unreachable" },
    timestamp: new Date().toISOString(),
  });
}

type ResolvedMcpAuth = {
  plaintextKey: string;
  context: VerifiedApiKeyContext;
  grantedScopes: string[];
};

type CachedMcpServerEntry = {
  activeRequests: number;
  expiresAtMs: number;
  server: McpServer;
};

const mcpServerCache = new Map<string, CachedMcpServerEntry>();

function getMcpServerCacheKey(auth: ResolvedMcpAuth): string {
  const keyFingerprint = createHash("sha256")
    .update(auth.plaintextKey, "utf8")
    .digest("hex");
  const sortedScopes = [...auth.grantedScopes].sort().join(",");
  return `${auth.context.organizationId}:${auth.context.userId}:${keyFingerprint}:${sortedScopes}`;
}

function cleanupExpiredMcpServerCache(nowMs: number): void {
  for (const [cacheKey, entry] of mcpServerCache.entries()) {
    if (entry.activeRequests === 0 && entry.expiresAtMs <= nowMs) {
      mcpServerCache.delete(cacheKey);
    }
  }
}

function acquireMcpServer(auth: ResolvedMcpAuth): {
  release: () => void;
  server: McpServer;
} {
  const nowMs = Date.now();
  cleanupExpiredMcpServerCache(nowMs);
  const cacheKey = getMcpServerCacheKey(auth);
  const cachedEntry = mcpServerCache.get(cacheKey);

  if (
    cachedEntry &&
    cachedEntry.expiresAtMs > nowMs &&
    cachedEntry.activeRequests === 0
  ) {
    cachedEntry.activeRequests = 1;
    cachedEntry.expiresAtMs = nowMs + MCP_SERVER_CACHE_TTL_MS;
    return {
      server: cachedEntry.server,
      release: () => {
        cachedEntry.activeRequests = Math.max(
          cachedEntry.activeRequests - 1,
          0
        );
        cachedEntry.expiresAtMs = Date.now() + MCP_SERVER_CACHE_TTL_MS;
      },
    };
  }

  const server = createMcpServer(
    auth.context,
    auth.plaintextKey,
    auth.grantedScopes
  );
  if (!cachedEntry || cachedEntry.expiresAtMs <= nowMs) {
    const cacheEntry: CachedMcpServerEntry = {
      server,
      activeRequests: 1,
      expiresAtMs: nowMs + MCP_SERVER_CACHE_TTL_MS,
    };
    mcpServerCache.set(cacheKey, cacheEntry);
    return {
      server,
      release: () => {
        cacheEntry.activeRequests = Math.max(cacheEntry.activeRequests - 1, 0);
        cacheEntry.expiresAtMs = Date.now() + MCP_SERVER_CACHE_TTL_MS;
      },
    };
  }

  // Existing entry is in use; create an isolated server for concurrent request safety.
  return {
    server,
    release: () => {},
  };
}

async function resolveMcpAuth(
  authorizationHeader: string | null
): Promise<ResolvedMcpAuth | null> {
  const apiKeyFromHeader = extractApiKey(authorizationHeader);
  if (apiKeyFromHeader) {
    const context = await verifyApiKey(apiKeyFromHeader);
    if (!context) {
      return null;
    }
    return {
      plaintextKey: apiKeyFromHeader,
      context,
      grantedScopes: effectiveKeyScopes(context.scopes),
    };
  }

  const oauthToken = extractOAuthToken(authorizationHeader);
  if (!oauthToken) {
    return null;
  }

  const tokenPayload = await verifyOAuthAccessToken(oauthToken);
  if (!tokenPayload) {
    return null;
  }

  const plaintextKey = decryptApiKey(
    tokenPayload.apiKeyCiphertext,
    tokenPayload.kid
  );
  if (!plaintextKey) {
    return null;
  }

  const context = await verifyApiKey(plaintextKey);
  if (!context) {
    return null;
  }

  const keyScopes = effectiveKeyScopes(context.scopes);
  const grantedScopes = tokenPayload.scopes.filter((scope) =>
    keyScopes.includes(scope)
  );

  return {
    plaintextKey,
    context,
    grantedScopes,
  };
}

async function handleMcp(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse
): Promise<void> {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" }, { Allow: "POST" });
    return;
  }

  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.includes("application/json")) {
    sendJson(res, 415, {
      error: "Unsupported Media Type. Expected: application/json",
    });
    return;
  }
  const contentLengthHeader = req.headers["content-length"];
  const contentLength = Number(contentLengthHeader ?? 0);
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_REQUEST_BODY_BYTES
  ) {
    sendJson(res, 413, {
      error: "payload_too_large",
      error_description: `Request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`,
    });
    return;
  }

  // Validate MCP-Protocol-Version header (spec requirement)
  const protocolVersion = req.headers["mcp-protocol-version"] as
    | string
    | undefined;
  if (
    protocolVersion &&
    !SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)
  ) {
    sendJson(res, 400, {
      error: `Unsupported MCP protocol version: ${protocolVersion}. Supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}`,
    });
    return;
  }

  const auth = await resolveMcpAuth(req.headers.authorization ?? null);
  if (!auth) {
    sendJson(res, 401, {
      error:
        "Missing or invalid Authorization header. Expected Bearer token (sk_live_* or OAuth access token).",
    });
    return;
  }

  let rawBody: string;
  try {
    rawBody = await readRequestBody(req);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      sendJson(res, 413, {
        error: "payload_too_large",
        error_description: `Request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`,
      });
      return;
    }
    throw error;
  }
  const parsedBody = JSON.parse(rawBody);

  const acquiredServer = acquireMcpServer(auth);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  try {
    await acquiredServer.server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } finally {
    await acquiredServer.server.close();
    acquiredServer.release();
  }
}

function parseFormUrlEncoded(body: string): Record<string, string> {
  const params = new URLSearchParams(body);
  return Object.fromEntries(params.entries());
}

async function readRequestBody(
  req: import("node:http").IncomingMessage
): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const bufferChunk = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(String(chunk));
    totalBytes += bufferChunk.length;
    if (totalBytes > MAX_REQUEST_BODY_BYTES) {
      throw new RequestBodyTooLargeError();
    }
    chunks.push(bufferChunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJsonBody<T>(
  req: import("node:http").IncomingMessage
): Promise<T | null> {
  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.includes("application/json")) {
    return null;
  }
  const raw = await readRequestBody(req);
  if (!raw.trim()) {
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function redirectWithParams(
  res: import("node:http").ServerResponse,
  redirectUri: string,
  params: Record<string, string | undefined>
): void {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(key, value);
    }
  }
  res.writeHead(302, { Location: url.toString() });
  res.end();
}

function parseScopeParam(scopeParam?: string): string[] {
  if (!scopeParam?.trim()) {
    return [];
  }
  return scopeParam.trim().split(SCOPE_SPLIT_REGEX);
}

function isValidRedirectUri(uri: string): boolean {
  try {
    const allowlist = getOAuthRedirectUriAllowlist();
    const parsed = new URL(uri);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return false;
    }

    if (allowlist.length > 0) {
      return allowlist.includes(uri);
    }

    if (!isLocalOauthEnvironment()) {
      return false;
    }

    return (
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

async function handleOAuthAuthorize(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse
): Promise<void> {
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed" }, { Allow: "GET" });
    return;
  }

  await maybeCleanupOAuthSecurityTables();
  const authorizeRateLimit = await consumeOAuthRateLimit(req, "authorize");
  if (authorizeRateLimit.limited) {
    sendJson(
      res,
      429,
      {
        error: "rate_limited",
        error_description: "Too many authorize requests",
      },
      { "Retry-After": String(authorizeRateLimit.retryAfterSeconds) }
    );
    return;
  }

  const apiKey = extractApiKey(req.headers.authorization ?? null);
  if (!apiKey) {
    sendJson(res, 401, {
      error: "invalid_client",
      error_description: "Missing Bearer API key",
    });
    return;
  }

  const context = await verifyApiKey(apiKey);
  if (!context) {
    sendJson(res, 401, {
      error: "invalid_client",
      error_description: "Invalid API key",
    });
    return;
  }

  const url = new URL(req.url ?? "", MCP_SERVER_URL);
  const responseType = url.searchParams.get("response_type");
  const clientId = url.searchParams.get("client_id");
  const redirectUri = url.searchParams.get("redirect_uri");
  const state = url.searchParams.get("state") ?? undefined;
  const codeChallenge = url.searchParams.get("code_challenge");
  const codeChallengeMethod = url.searchParams.get("code_challenge_method");
  const requestedScopes = parseScopeParam(url.searchParams.get("scope") ?? "");

  if (!(redirectUri && isValidRedirectUri(redirectUri))) {
    sendJson(res, 400, {
      error: "invalid_request",
      error_description: "Invalid or missing redirect_uri",
    });
    return;
  }

  if (responseType !== "code") {
    redirectWithParams(res, redirectUri, {
      error: "unsupported_response_type",
      error_description: "Only response_type=code is supported",
      state,
    });
    return;
  }

  if (!clientId || clientId !== OAUTH_CLIENT_ID) {
    redirectWithParams(res, redirectUri, {
      error: "unauthorized_client",
      error_description: "Invalid client_id",
      state,
    });
    return;
  }

  if (!codeChallenge || codeChallengeMethod !== "S256") {
    redirectWithParams(res, redirectUri, {
      error: "invalid_request",
      error_description:
        "code_challenge and code_challenge_method=S256 are required",
      state,
    });
    return;
  }

  const keyScopes = effectiveKeyScopes(context.scopes);
  const scopes = requestedScopes.length > 0 ? requestedScopes : keyScopes;
  const hasInvalidScope = scopes.some((scope) => !keyScopes.includes(scope));
  if (hasInvalidScope) {
    redirectWithParams(res, redirectUri, {
      error: "invalid_scope",
      error_description: "Requested scope is not granted for this key",
      state,
    });
    return;
  }

  const code = `mcp_ac_${randomBytes(24).toString("base64url")}`;
  await storeAuthorizationCode(code, {
    encryptedApiKey: encryptApiKey(apiKey, OAUTH_CURRENT_SIGNING_KEY.kid),
    keyId: OAUTH_CURRENT_SIGNING_KEY.kid,
    userId: context.userId,
    organizationId: context.organizationId,
    clientId,
    redirectUri,
    scopes,
    codeChallenge,
    codeChallengeMethod: "S256",
    expiresAt: new Date(Date.now() + OAUTH_AUTH_CODE_TTL_SECONDS * 1000),
  });

  redirectWithParams(res, redirectUri, { code, state });
}

type OAuthTokenBody = Record<string, string>;

function sendInvalidClient(
  res: import("node:http").ServerResponse,
  description: string
): void {
  sendOAuthJson(res, 401, {
    error: "invalid_client",
    error_description: description,
  });
}

async function handleClientCredentialsGrant(
  body: OAuthTokenBody,
  res: import("node:http").ServerResponse
): Promise<void> {
  if (!body.client_id || body.client_id !== OAUTH_CLIENT_ID) {
    sendInvalidClient(res, "Invalid client credentials");
    return;
  }

  const apiKey = body.client_secret;
  if (!apiKey?.startsWith("sk_live_")) {
    sendInvalidClient(res, "Invalid client credentials");
    return;
  }

  const context = await verifyApiKey(apiKey);
  if (!context) {
    sendInvalidClient(res, "Invalid client credentials");
    return;
  }

  const keyScopes = effectiveKeyScopes(context.scopes);
  const requestedScopes = parseScopeParam(body.scope);
  const scopes = requestedScopes.length > 0 ? requestedScopes : keyScopes;
  const hasInvalidScope = scopes.some((scope) => !keyScopes.includes(scope));

  if (hasInvalidScope) {
    sendOAuthJson(res, 400, {
      error: "invalid_scope",
      error_description: "Requested scope is not granted for this key",
    });
    return;
  }

  const accessToken = issueOAuthAccessToken(apiKey, context, scopes);
  sendOAuthJson(res, 200, {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: OAUTH_TOKEN_TTL_SECONDS,
    scope: scopes.join(" "),
  });
}

async function handleAuthorizationCodeGrant(
  body: OAuthTokenBody,
  res: import("node:http").ServerResponse
): Promise<void> {
  if (!body.client_id || body.client_id !== OAUTH_CLIENT_ID) {
    sendInvalidClient(res, "Invalid client_id");
    return;
  }

  if (!(body.code && body.redirect_uri && body.code_verifier)) {
    sendOAuthJson(res, 400, {
      error: "invalid_request",
      error_description: "code, redirect_uri, and code_verifier are required",
    });
    return;
  }

  const codeRecord = await consumeAuthorizationCode(body.code);
  if (!codeRecord) {
    sendOAuthJson(res, 400, {
      error: "invalid_grant",
      error_description: "Invalid or expired authorization code",
    });
    return;
  }

  if (codeRecord.clientId !== body.client_id) {
    sendOAuthJson(res, 400, {
      error: "invalid_grant",
      error_description: "Authorization code was not issued to this client",
    });
    return;
  }

  if (codeRecord.redirectUri !== body.redirect_uri) {
    sendOAuthJson(res, 400, {
      error: "invalid_grant",
      error_description: "redirect_uri does not match authorization request",
    });
    return;
  }

  const derivedChallenge = sha256Base64Url(body.code_verifier);
  if (
    codeRecord.codeChallengeMethod !== "S256" ||
    !timingSafeStringEqual(derivedChallenge, codeRecord.codeChallenge)
  ) {
    sendOAuthJson(res, 400, {
      error: "invalid_grant",
      error_description: "Invalid PKCE code_verifier",
    });
    return;
  }

  const codeApiKey = decryptApiKey(
    codeRecord.encryptedApiKey,
    codeRecord.keyId
  );
  if (!codeApiKey) {
    sendOAuthJson(res, 400, {
      error: "invalid_grant",
      error_description: "Authorization code is no longer valid",
    });
    return;
  }

  const context = await verifyApiKey(codeApiKey);
  if (!context) {
    sendOAuthJson(res, 400, {
      error: "invalid_grant",
      error_description: "Authorization code is no longer valid",
    });
    return;
  }

  const keyScopes = effectiveKeyScopes(context.scopes);
  const codeScopes = codeRecord.scopes.filter((scope) =>
    keyScopes.includes(scope)
  );
  const requestedScopes = parseScopeParam(body.scope);
  const scopes = requestedScopes.length > 0 ? requestedScopes : codeScopes;
  const hasInvalidScope = scopes.some((scope) => !codeScopes.includes(scope));

  if (hasInvalidScope) {
    sendOAuthJson(res, 400, {
      error: "invalid_scope",
      error_description: "Requested scope exceeds the authorization code grant",
    });
    return;
  }

  const accessToken = issueOAuthAccessToken(codeApiKey, context, scopes);
  sendOAuthJson(res, 200, {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: OAUTH_TOKEN_TTL_SECONDS,
    scope: scopes.join(" "),
  });
}

async function handleOAuthToken(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse
): Promise<void> {
  if (req.method !== "POST") {
    sendOAuthJson(res, 405, { error: "Method not allowed" }, { Allow: "POST" });
    return;
  }

  await maybeCleanupOAuthSecurityTables();
  const tokenRateLimit = await consumeOAuthRateLimit(req, "token");
  if (tokenRateLimit.limited) {
    sendOAuthJson(
      res,
      429,
      { error: "rate_limited", error_description: "Too many token requests" },
      { "Retry-After": String(tokenRateLimit.retryAfterSeconds) }
    );
    return;
  }

  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.includes("application/x-www-form-urlencoded")) {
    sendOAuthJson(res, 415, {
      error:
        "Unsupported Media Type. Expected: application/x-www-form-urlencoded",
    });
    return;
  }

  let rawBody: string;
  try {
    rawBody = await readRequestBody(req);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      sendOAuthJson(res, 413, {
        error: "payload_too_large",
        error_description: `Request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`,
      });
      return;
    }
    throw error;
  }
  const body = parseFormUrlEncoded(rawBody);

  if (body.grant_type === "client_credentials") {
    await handleClientCredentialsGrant(body, res);
    return;
  }

  if (body.grant_type === "authorization_code") {
    await handleAuthorizationCodeGrant(body, res);
    return;
  }

  sendOAuthJson(res, 400, {
    error: "unsupported_grant_type",
    error_description:
      "Supported grant types are client_credentials and authorization_code",
  });
}

type InternalTokenBody = {
  token?: string;
};

async function handleOAuthIntrospect(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse
): Promise<void> {
  if (req.method !== "POST") {
    sendOAuthJson(res, 405, { error: "Method not allowed" }, { Allow: "POST" });
    return;
  }

  await maybeCleanupOAuthSecurityTables();
  if (!isInternalRequestAuthorized(req)) {
    sendInternalUnauthorized(res);
    return;
  }

  let body: InternalTokenBody | null;
  try {
    body = await readJsonBody<InternalTokenBody>(req);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      sendOAuthJson(res, 413, {
        error: "payload_too_large",
        error_description: `Request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`,
      });
      return;
    }
    throw error;
  }
  if (!body?.token?.startsWith("mcp_at_")) {
    sendOAuthJson(res, 400, {
      error: "invalid_request",
      error_description: "JSON body with token is required",
    });
    return;
  }

  const payload = parseSignedOAuthAccessToken(body.token);
  if (!payload || (await isAccessTokenRevoked(body.token))) {
    sendOAuthJson(res, 200, { active: false });
    return;
  }

  const plaintextKey = decryptApiKey(payload.apiKeyCiphertext, payload.kid);
  if (!plaintextKey) {
    sendOAuthJson(res, 200, { active: false });
    return;
  }

  const keyContext = await verifyApiKey(plaintextKey);
  if (!keyContext) {
    sendOAuthJson(res, 200, { active: false });
    return;
  }

  sendOAuthJson(res, 200, {
    active: true,
    token_type: "Bearer",
    scope: payload.scopes.join(" "),
    exp: payload.exp,
    iat: payload.iat,
    user_id: payload.userId,
    organization_id: payload.organizationId,
  });
}

async function handleOAuthRevoke(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse
): Promise<void> {
  if (req.method !== "POST") {
    sendOAuthJson(res, 405, { error: "Method not allowed" }, { Allow: "POST" });
    return;
  }

  await maybeCleanupOAuthSecurityTables();
  if (!isInternalRequestAuthorized(req)) {
    sendInternalUnauthorized(res);
    return;
  }

  let body: InternalTokenBody | null;
  try {
    body = await readJsonBody<InternalTokenBody>(req);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      sendOAuthJson(res, 413, {
        error: "payload_too_large",
        error_description: `Request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`,
      });
      return;
    }
    throw error;
  }
  if (!body?.token?.startsWith("mcp_at_")) {
    sendOAuthJson(res, 400, {
      error: "invalid_request",
      error_description: "JSON body with token is required",
    });
    return;
  }

  const payload = parseSignedOAuthAccessToken(body.token);
  if (!payload) {
    sendOAuthJson(res, 400, {
      error: "invalid_request",
      error_description: "Invalid token",
    });
    return;
  }

  await revokeAccessToken(body.token, payload.exp * 1000);
  sendOAuthJson(res, 200, {
    revoked: true,
    exp: payload.exp,
  });
}

type HttpRouteHandler = (
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse
) => void | Promise<void>;

const GET_ROUTES: Record<string, HttpRouteHandler> = {
  "/health": (_req, res) => {
    sendJson(res, 200, {
      status: "ok",
      version: "0.0.1",
      timestamp: new Date().toISOString(),
    });
  },
  "/ready": async (_req, res) => {
    await handleReady(res);
  },
  "/.well-known/oauth-protected-resource": (_req, res) => {
    sendJson(res, 200, {
      resource: MCP_SERVER_URL,
      authorization_servers: [
        `${MCP_SERVER_URL}/.well-known/oauth-authorization-server`,
      ],
      bearer_methods_supported: ["header"],
      resource_documentation: "https://docs.closedloop.ai/mcp",
    });
  },
  "/.well-known/oauth-authorization-server": (_req, res) => {
    sendJson(res, 200, {
      issuer: MCP_SERVER_URL,
      authorization_endpoint: `${MCP_SERVER_URL}/oauth/authorize`,
      token_endpoint: `${MCP_SERVER_URL}/oauth/token`,
      introspection_endpoint: `${MCP_SERVER_URL}/internal/oauth/introspect`,
      revocation_endpoint: `${MCP_SERVER_URL}/internal/oauth/revoke`,
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      grant_types_supported: ["authorization_code", "client_credentials"],
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: [...API_KEY_SCOPES],
    });
  },
  "/.well-known/mcp.json": (_req, res) => {
    sendJson(res, 200, {
      name: "closedloop",
      version: "0.0.1",
      description: "ClosedLoop AI software delivery platform — MCP server",
      url: `${MCP_SERVER_URL}/mcp`,
      transport: { type: "streamable-http" },
      authentication: { type: "bearer", format: "sk_live_*" },
      protocol_versions: SUPPORTED_PROTOCOL_VERSIONS,
      capabilities: { tools: true },
      tools: TOOL_NAMES,
    });
  },
};

async function dispatchHttpRequest(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse
): Promise<boolean> {
  const parsedUrl = new URL(req.url ?? "/", MCP_SERVER_URL);
  const pathname = parsedUrl.pathname;

  if (pathname === "/oauth/authorize") {
    await handleOAuthAuthorize(req, res);
    return true;
  }

  if (pathname === "/oauth/token") {
    await handleOAuthToken(req, res);
    return true;
  }

  if (pathname === "/internal/oauth/introspect") {
    await handleOAuthIntrospect(req, res);
    return true;
  }

  if (pathname === "/internal/oauth/revoke") {
    await handleOAuthRevoke(req, res);
    return true;
  }

  if (pathname === "/mcp") {
    await handleMcp(req, res);
    return true;
  }

  if (req.method === "GET") {
    const handler = GET_ROUTES[pathname];
    if (handler) {
      await handler(req, res);
      return true;
    }
  }

  return false;
}

export function createHttpServer(): import("node:http").Server {
  return createServer(async (req, res) => {
    try {
      const handled = await dispatchHttpRequest(req, res);
      if (!handled) {
        sendJson(res, 404, { error: "Not found" });
      }
    } catch (error) {
      console.error("MCP server error:", error);
      if (!res.headersSent) {
        sendJson(res, 500, { error: "Internal server error" });
      }
    }
  });
}

export function startHttpServer(port = PORT): import("node:http").Server {
  requireRedirectAllowlistForEnvironment();
  requireInternalAllowlistForEnvironment();
  const httpServer = createHttpServer();
  httpServer.listen(port, () => {
    console.log(`ClosedLoop MCP server running on port ${port}`);
    console.log(`MCP endpoint: http://localhost:${port}/mcp`);
    console.log(`Health: http://localhost:${port}/health`);
    console.log(`Ready:  http://localhost:${port}/ready`);
  });

  httpServer.on("error", (error) => {
    console.error("HTTP server error:", error);
    process.exit(1);
  });

  return httpServer;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  startHttpServer();
}

export const __testables = {
  dispatchHttpRequest,
  handleOAuthAuthorize,
  handleOAuthToken,
  handleOAuthIntrospect,
  handleOAuthRevoke,
  requireRedirectAllowlistForEnvironment,
  requireInternalAllowlistForEnvironment,
  resetInMemorySecurityState: () => {
    lastOAuthCleanupMs = 0;
    mcpServerCache.clear();
  },
};
