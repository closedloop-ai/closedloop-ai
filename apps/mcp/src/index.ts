import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { createServer } from "node:http";
import { isIPv4 } from "node:net";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { withDb } from "@repo/database";
import {
  type ApiClient,
  checkApiReachable,
  createApiClient,
  verifyApiKey,
} from "./api-client.js";
import {
  API_KEY_SCOPES,
  type VerifiedApiKeyContext,
} from "./api-key-contract.js";
import { registerBatchCreateArtifacts } from "./tools/batch-create-artifacts.js";
import { registerCreateArtifact } from "./tools/create-artifact.js";
import { registerCreateArtifactVersion } from "./tools/create-artifact-version.js";
import { registerCreateEntityLink } from "./tools/create-entity-link.js";
import { registerCreateExternalLink } from "./tools/create-external-link.js";
import { registerCreateIssue } from "./tools/create-issue.js";
import { registerCreateIssueComment } from "./tools/create-issue-comment.js";
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
import { registerGetMe } from "./tools/get-me.js";
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
const OAUTH_REFRESH_TOKEN_PREFIX = "mcp_rt_";
const SCOPE_SPLIT_REGEX = /\s+/;
const LEADING_QUESTION_MARK_REGEX = /^\?/;
const PORT = Number(process.env.MCP_PORT ?? 3010);
const SUPPORTED_PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26"];
const MCP_SERVER_URL = process.env.MCP_SERVER_URL ?? `http://localhost:${PORT}`;
const OAUTH_CLIENT_ID = process.env.MCP_OAUTH_CLIENT_ID ?? "closedloop-mcp";

function parsePositiveIntegerEnv(
  name: string,
  defaultValue: number,
  minimumValue = 1
): number {
  const rawValue = process.env[name];
  if (!rawValue) {
    return defaultValue;
  }

  const parsedValue = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsedValue) || parsedValue < minimumValue) {
    console.warn(
      `${name}="${rawValue}" is invalid. Using default value ${defaultValue}.`
    );
    return defaultValue;
  }

  return parsedValue;
}

const OAUTH_TOKEN_TTL_SECONDS = parsePositiveIntegerEnv(
  "MCP_OAUTH_TOKEN_TTL_SECONDS",
  3600
);
const OAUTH_REFRESH_TOKEN_TTL_SECONDS = parsePositiveIntegerEnv(
  "MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS",
  2_592_000
);
const OAUTH_AUTH_CODE_TTL_SECONDS = parsePositiveIntegerEnv(
  "MCP_OAUTH_AUTH_CODE_TTL_SECONDS",
  600
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
  // RFC 8252 loopback redirects are always allowed, so the allowlist is only
  // required when non-loopback redirect URIs need to be accepted.
  // Dynamic client registration (Claude Code, etc.) uses loopback only.
  if (
    !isLocalOauthEnvironment() &&
    getOAuthRedirectUriAllowlist().length === 0
  ) {
    console.warn(
      "MCP_OAUTH_REDIRECT_URIS is empty — only loopback redirect URIs will be accepted"
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
  {
    name: "create-issue-comment",
    register: registerCreateIssueComment,
    requiresWrite: true,
  },
  { name: "get-me", register: registerGetMe },
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

type StoredAuthorizationCodeRecord = AuthorizationCodeRecord & {
  id: string;
  consumedAt: Date | null;
};

type RefreshTokenRecord = {
  id: string;
  tokenFingerprint: string;
  encryptedApiKey: string;
  keyId: string;
  userId: string;
  organizationId: string;
  clientId: string;
  scopes: string[];
  familyId: string;
  expiresAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  replacedByTokenId: string | null;
};

type OAuthCleanupDbClient = {
  oAuthAuthorizationCode: {
    deleteMany(args: {
      where: {
        OR: Array<{ expiresAt: { lte: Date } } | { consumedAt: { not: null } }>;
      };
    }): Promise<unknown>;
  };
  oAuthRevokedToken: {
    deleteMany(args: { where: { expiresAt: { lte: Date } } }): Promise<unknown>;
  };
  oAuthRateLimit: {
    deleteMany(args: {
      where: { windowExpiresAt: { lte: Date } };
    }): Promise<unknown>;
  };
  oAuthRefreshToken: {
    deleteMany(args: { where: { expiresAt: { lte: Date } } }): Promise<unknown>;
  };
  $queryRawUnsafe?: (query: string, ...values: unknown[]) => Promise<unknown>;
};

function effectiveKeyScopes(scopes: string[]): string[] {
  return scopes.length > 0 ? scopes : [...API_KEY_SCOPES];
}

function hasWriteScope(scopes: string[]): boolean {
  return scopes.includes("write");
}

/**
 * OAuth 2.1: resolve the effective scope set by intersecting the requested
 * scopes with the scopes available on the API key.  Returns `null` when no
 * overlap exists (the caller should reject with `invalid_scope`).
 */
function resolveGrantedScopes(
  requestedScopes: string[],
  keyScopes: string[]
): string[] | null {
  if (requestedScopes.length === 0) {
    return keyScopes;
  }
  const intersection = requestedScopes.filter((s) => keyScopes.includes(s));
  return intersection.length > 0 ? intersection : null;
}

let lastOAuthCleanupMs = 0;
const OAUTH_CLEANUP_LOCK_ID = 8_173_421;

async function maybeCleanupOAuthSecurityTables(): Promise<void> {
  const nowMs = Date.now();
  if (nowMs - lastOAuthCleanupMs < OAUTH_CLEANUP_INTERVAL_MS) {
    return;
  }

  await withDb.tx(async (db) => {
    const client = db as unknown as OAuthCleanupDbClient;
    if (!client.$queryRawUnsafe) {
      await runOAuthCleanupQueries(nowMs, client);
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
      await runOAuthCleanupQueries(nowMs, client);
    } finally {
      await client.$queryRawUnsafe(
        "SELECT pg_advisory_unlock($1)",
        OAUTH_CLEANUP_LOCK_ID
      );
    }
  });
  lastOAuthCleanupMs = nowMs;
}

async function runOAuthCleanupQueries(
  nowMs: number,
  db: OAuthCleanupDbClient
): Promise<void> {
  await Promise.allSettled([
    cleanupExpiredAuthorizationCodes(db),
    cleanupExpiredRevokedTokens(db),
    cleanupExpiredRefreshTokens(db),
    db.oAuthRateLimit.deleteMany({
      where: { windowExpiresAt: { lte: new Date(nowMs) } },
    }),
  ]);
}

async function cleanupExpiredAuthorizationCodes(
  db: OAuthCleanupDbClient
): Promise<void> {
  await db.oAuthAuthorizationCode.deleteMany({
    where: {
      OR: [{ expiresAt: { lte: new Date() } }, { consumedAt: { not: null } }],
    },
  });
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

function loadAuthorizationCode(
  code: string
): Promise<StoredAuthorizationCodeRecord | null> {
  return withDb((db) =>
    db.oAuthAuthorizationCode.findUnique({
      where: { code },
      select: {
        id: true,
        encryptedApiKey: true,
        keyId: true,
        userId: true,
        organizationId: true,
        clientId: true,
        redirectUri: true,
        scopes: true,
        codeChallenge: true,
        codeChallengeMethod: true,
        expiresAt: true,
        consumedAt: true,
      },
    })
  ).then((record) => {
    if (!record) {
      return null;
    }
    return {
      id: record.id,
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
      consumedAt: record.consumedAt,
    };
  });
}

function getTokenFingerprint(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function issueOAuthRefreshToken(): string {
  return `${OAUTH_REFRESH_TOKEN_PREFIX}${randomBytes(48).toString("base64url")}`;
}

async function cleanupExpiredRevokedTokens(
  db: OAuthCleanupDbClient
): Promise<void> {
  await db.oAuthRevokedToken.deleteMany({
    where: { expiresAt: { lte: new Date() } },
  });
}

async function cleanupExpiredRefreshTokens(
  db: OAuthCleanupDbClient
): Promise<void> {
  await db.oAuthRefreshToken.deleteMany({
    where: { expiresAt: { lte: new Date() } },
  });
}

async function revokeAccessToken(
  token: string,
  expiresAtMs: number
): Promise<void> {
  const fingerprint = getTokenFingerprint(token);
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
  const fingerprint = getTokenFingerprint(token);
  const tokenRecord = await withDb((db) =>
    db.oAuthRevokedToken.findUnique({
      where: { tokenFingerprint: fingerprint },
      select: { expiresAt: true },
    })
  );
  return tokenRecord !== null && tokenRecord.expiresAt.getTime() > Date.now();
}

type OAuthRefreshTokenDbClient = {
  oAuthRefreshToken: {
    create(args: {
      data: {
        tokenFingerprint: string;
        encryptedApiKey: string;
        keyId: string;
        userId: string;
        organizationId: string;
        clientId: string;
        scopes: string[];
        familyId: string;
        expiresAt: Date;
      };
    }): Promise<{ id: string }>;
    findUnique(args: {
      where: { tokenFingerprint: string };
    }): Promise<RefreshTokenRecord | null>;
    updateMany(args: {
      where: {
        id?: string;
        familyId?: string;
        revokedAt?: null;
      };
      data: {
        lastUsedAt?: Date;
        revokedAt?: Date;
        replacedByTokenId?: string;
      };
    }): Promise<{ count: number }>;
  };
};

type CreateRefreshTokenInput = {
  encryptedApiKey: string;
  keyId: string;
  userId: string;
  organizationId: string;
  clientId: string;
  scopes: string[];
  familyId: string;
  expiresAt: Date;
};

async function createRefreshTokenRecord(
  client: OAuthRefreshTokenDbClient,
  input: CreateRefreshTokenInput
): Promise<{ token: string; tokenId: string; expiresIn: number }> {
  const token = issueOAuthRefreshToken();
  const tokenFingerprint = getTokenFingerprint(token);
  const created = await client.oAuthRefreshToken.create({
    data: {
      tokenFingerprint,
      encryptedApiKey: input.encryptedApiKey,
      keyId: input.keyId,
      userId: input.userId,
      organizationId: input.organizationId,
      clientId: input.clientId,
      scopes: input.scopes,
      familyId: input.familyId,
      expiresAt: input.expiresAt,
    },
  });

  return {
    token,
    tokenId: created.id,
    expiresIn: Math.max(
      1,
      Math.floor((input.expiresAt.getTime() - Date.now()) / 1000)
    ),
  };
}

function loadRefreshTokenRecord(
  token: string
): Promise<RefreshTokenRecord | null> {
  const tokenFingerprint = getTokenFingerprint(token);
  return withDb((db) => {
    const client = db as unknown as OAuthRefreshTokenDbClient;
    return client.oAuthRefreshToken.findUnique({
      where: { tokenFingerprint },
    });
  });
}

async function revokeRefreshTokenFamily(familyId: string): Promise<void> {
  await withDb((db) => {
    const client = db as unknown as OAuthRefreshTokenDbClient;
    return client.oAuthRefreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  });
}

function rotateRefreshToken(
  token: string,
  clientId: string,
  nextScopes: string[]
): Promise<
  | { status: "rotated"; token: string; expiresIn: number }
  | { status: "invalid" }
  | { status: "invalid_client" }
  | { status: "invalid_scope" }
  | { status: "reuse_detected" }
> {
  const tokenFingerprint = getTokenFingerprint(token);
  return withDb.tx(async (db) => {
    const client = db as unknown as OAuthRefreshTokenDbClient;
    const now = new Date();
    const nextExpiry = new Date(
      now.getTime() + OAUTH_REFRESH_TOKEN_TTL_SECONDS * 1000
    );
    const current = await client.oAuthRefreshToken.findUnique({
      where: { tokenFingerprint },
    });
    if (!current || current.expiresAt <= now) {
      return { status: "invalid" };
    }
    if (current.revokedAt !== null) {
      await client.oAuthRefreshToken.updateMany({
        where: { familyId: current.familyId, revokedAt: null },
        data: { revokedAt: now },
      });
      return { status: "reuse_detected" };
    }
    if (current.clientId !== clientId) {
      return { status: "invalid_client" };
    }
    if (nextScopes.some((scope) => !current.scopes.includes(scope))) {
      return { status: "invalid_scope" };
    }

    const revoked = await client.oAuthRefreshToken.updateMany({
      where: { id: current.id, revokedAt: null },
      data: {
        revokedAt: now,
        lastUsedAt: now,
      },
    });

    if (revoked.count !== 1) {
      await client.oAuthRefreshToken.updateMany({
        where: { familyId: current.familyId, revokedAt: null },
        data: { revokedAt: now },
      });
      return { status: "reuse_detected" };
    }

    const issued = await createRefreshTokenRecord(client, {
      encryptedApiKey: current.encryptedApiKey,
      keyId: current.keyId,
      userId: current.userId,
      organizationId: current.organizationId,
      clientId: current.clientId,
      scopes: nextScopes,
      familyId: current.familyId,
      expiresAt: nextExpiry,
    });

    await client.oAuthRefreshToken.updateMany({
      where: { id: current.id },
      data: { replacedByTokenId: issued.tokenId },
    });

    return {
      status: "rotated",
      token: issued.token,
      expiresIn: issued.expiresIn,
    };
  });
}

async function revokeRefreshToken(token: string): Promise<void> {
  const tokenFingerprint = getTokenFingerprint(token);
  await withDb.tx(async (db) => {
    const client = db as unknown as OAuthRefreshTokenDbClient;
    const record = await client.oAuthRefreshToken.findUnique({
      where: { tokenFingerprint },
    });
    if (!record) {
      return;
    }
    await client.oAuthRefreshToken.updateMany({
      where: { familyId: record.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  });
}

function normalizeAddress(address: string): string {
  return address.startsWith("::ffff:")
    ? address.slice("::ffff:".length)
    : address;
}

function ipv4ToNumber(address: string): number | null {
  if (!isIPv4(address)) {
    return null;
  }
  const octets = address.split(".").map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((value) => Number.isNaN(value))) {
    return null;
  }
  return (
    octets[0] * 256 ** 3 + octets[1] * 256 ** 2 + octets[2] * 256 + octets[3]
  );
}

function isAddressInCidr(address: string, cidr: string): boolean {
  const [baseAddress, prefixLengthRaw] = cidr.split("/");
  if (!(baseAddress && prefixLengthRaw)) {
    return false;
  }
  const prefixLength = Number.parseInt(prefixLengthRaw, 10);
  if (!Number.isFinite(prefixLength) || prefixLength < 0 || prefixLength > 32) {
    return false;
  }

  const addressInt = ipv4ToNumber(address);
  const baseInt = ipv4ToNumber(baseAddress);
  if (addressInt === null || baseInt === null) {
    return false;
  }

  const rangeSize = 2 ** (32 - prefixLength);
  const rangeStart = Math.floor(baseInt / rangeSize) * rangeSize;
  const rangeEnd = rangeStart + rangeSize - 1;
  return addressInt >= rangeStart && addressInt <= rangeEnd;
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
    return allowlist.some((entry) =>
      entry.includes("/") ? isAddressInCidr(address, entry) : entry === address
    );
  }

  if (!isLocalOauthEnvironment()) {
    return false;
  }

  return (
    address === "localhost" || address === "127.0.0.1" || address === "::1"
  );
}

function logMcpEvent(
  event: string,
  details?: Record<string, string | number | boolean | undefined>
): void {
  const payload = details
    ? Object.entries(details)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(" ")
    : "";
  console.log(`[mcp] ${event}${payload ? ` ${payload}` : ""}`);
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

type McpSession = {
  auth: ResolvedMcpAuth;
  lastActivityMs: number;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
};

const mcpSessions = new Map<string, McpSession>();

function cleanupExpiredMcpSessions(nowMs: number): void {
  for (const [sessionId, session] of mcpSessions.entries()) {
    if (nowMs - session.lastActivityMs > MCP_SERVER_CACHE_TTL_MS) {
      mcpSessions.delete(sessionId);
      session.server.close().catch(() => {});
    }
  }
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

async function handleMcpExistingSession(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  session: McpSession
): Promise<void> {
  session.lastActivityMs = Date.now();

  if (req.method === "GET" || req.method === "DELETE") {
    await session.transport.handleRequest(req, res);
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

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    sendJson(res, 400, {
      error: "invalid_request",
      error_description: "Malformed JSON request body",
    });
    return;
  }

  await session.transport.handleRequest(req, res, parsedBody);
}

async function parseMcpJsonBody(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse
): Promise<unknown | null> {
  let rawBody: string;
  try {
    rawBody = await readRequestBody(req);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      sendJson(res, 413, {
        error: "payload_too_large",
        error_description: `Request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`,
      });
      return null;
    }
    throw error;
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    sendJson(res, 400, {
      error: "invalid_request",
      error_description: "Malformed JSON request body",
    });
    return null;
  }
}

async function handleMcpStatelessRequest(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  auth: ResolvedMcpAuth,
  parsedBody: unknown
): Promise<void> {
  const server = createMcpServer(
    auth.context,
    auth.plaintextKey,
    auth.grantedScopes
  );
  const transport = new StreamableHTTPServerTransport({
    // Stateless fallback avoids hard session affinity requirements across ECS tasks.
    sessionIdGenerator: undefined,
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } finally {
    await server.close();
  }
}

async function handleSessionScopedMcpRequest(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  sessionId: string | undefined
): Promise<{ unknownSessionId: string | null; shouldContinue: boolean }> {
  if (!sessionId) {
    return { unknownSessionId: null, shouldContinue: true };
  }

  const session = mcpSessions.get(sessionId);
  if (session) {
    logMcpEvent("session-hit", { method: req.method, sessionId });
    await handleMcpExistingSession(req, res, session);
    if (req.method === "DELETE") {
      mcpSessions.delete(sessionId);
      await session.server.close();
      logMcpEvent("session-closed", { sessionId });
    }
    return { unknownSessionId: null, shouldContinue: false };
  }

  // Unknown session can happen behind non-sticky load balancers.
  // For POST requests we fall back to stateless handling below.
  if (req.method !== "POST") {
    logMcpEvent("session-miss", { method: req.method, sessionId });
    sendJson(res, 404, {
      error: "Session not found. Please reinitialize.",
    });
    return { unknownSessionId: null, shouldContinue: false };
  }

  return { unknownSessionId: sessionId, shouldContinue: true };
}

function sendMcpAuthChallenge(res: import("node:http").ServerResponse): void {
  sendOAuthJson(
    res,
    401,
    {
      error:
        "Missing or invalid Authorization header. Expected Bearer token (sk_live_* or OAuth access token).",
    },
    {
      "WWW-Authenticate": `Bearer resource_metadata="${MCP_SERVER_URL}/.well-known/oauth-protected-resource"`,
    }
  );
}

function hasOversizedContentLength(
  req: import("node:http").IncomingMessage
): boolean {
  const contentLengthHeader = req.headers["content-length"];
  const contentLength = Number(contentLengthHeader ?? 0);
  return (
    Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BODY_BYTES
  );
}

function handleUnauthenticatedMcpProbe(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  sessionId: string | undefined,
  hasAuthorizationHeader: boolean
): boolean {
  if (sessionId || hasAuthorizationHeader) {
    return false;
  }

  // OAuth-capable clients may probe /mcp before session initialization.
  // Return an auth challenge instead of a protocol-level 400 so clients can
  // start OAuth automatically.
  if (req.method === "POST" && hasOversizedContentLength(req)) {
    sendJson(res, 413, {
      error: "payload_too_large",
      error_description: `Request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`,
    });
    return true;
  }

  sendMcpAuthChallenge(res);
  return true;
}

async function handleMcp(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse
): Promise<void> {
  const nowMs = Date.now();
  cleanupExpiredMcpSessions(nowMs);

  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const hasAuthorizationHeader = typeof req.headers.authorization === "string";
  if (
    handleUnauthenticatedMcpProbe(req, res, sessionId, hasAuthorizationHeader)
  ) {
    return;
  }

  const sessionState = await handleSessionScopedMcpRequest(req, res, sessionId);
  if (!sessionState.shouldContinue) {
    return;
  }

  // New session — only POST is valid (must be an initialize request)
  if (req.method !== "POST") {
    sendJson(
      res,
      400,
      { error: "Missing Mcp-Session-Id header" },
      { Allow: "POST" }
    );
    return;
  }

  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.includes("application/json")) {
    sendJson(res, 415, {
      error: "Unsupported Media Type. Expected: application/json",
    });
    return;
  }
  if (hasOversizedContentLength(req)) {
    sendJson(res, 413, {
      error: "payload_too_large",
      error_description: `Request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`,
    });
    return;
  }

  const auth = await resolveMcpAuth(req.headers.authorization ?? null);
  if (!auth) {
    sendMcpAuthChallenge(res);
    return;
  }

  const parsedBody = await parseMcpJsonBody(req, res);
  if (parsedBody === null) {
    return;
  }

  if (sessionState.unknownSessionId) {
    logMcpEvent("session-fallback-stateless", {
      method: req.method,
      sessionId: sessionState.unknownSessionId,
    });
    await handleMcpStatelessRequest(req, res, auth, parsedBody);
    return;
  }

  logMcpEvent("session-initialize", { method: req.method });
  const server = createMcpServer(
    auth.context,
    auth.plaintextKey,
    auth.grantedScopes
  );
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomBytes(16).toString("hex"),
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, parsedBody);

  // Store session for subsequent requests
  const newSessionId = transport.sessionId;
  if (newSessionId) {
    mcpSessions.set(newSessionId, {
      server,
      transport,
      auth,
      lastActivityMs: Date.now(),
    });
    logMcpEvent("session-created", { sessionId: newSessionId });
  } else {
    // No session created — clean up
    await server.close();
    logMcpEvent("session-none");
  }
}

function parseFormUrlEncoded(body: string): Record<string, string> {
  const params = new URLSearchParams(body);
  return Object.fromEntries(params.entries());
}

function normalizeOAuthTokenBody(input: unknown): OAuthTokenBody | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const result: OAuthTokenBody = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") {
      result[key] = value;
    }
  }
  return result;
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

async function readFormBody(
  req: import("node:http").IncomingMessage
): Promise<Record<string, string>> {
  const raw = await readRequestBody(req);
  const params = new URLSearchParams(raw);
  const result: Record<string, string> = {};
  for (const [key, value] of params) {
    result[key] = value;
  }
  return result;
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
    const parsed = new URL(uri);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return false;
    }

    // RFC 8252 §7.3: Loopback redirects are always allowed with any port.
    // Native/CLI OAuth clients (e.g. Claude Code) use ephemeral random ports.
    const isLoopback =
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "[::1]";
    if (isLoopback) {
      return true;
    }

    // Non-loopback URIs must appear in the explicit allowlist
    const allowlist = getOAuthRedirectUriAllowlist();
    if (allowlist.length > 0) {
      return allowlist.includes(uri);
    }

    // No allowlist and not loopback — deny in non-local envs, allow in local
    return isLocalOauthEnvironment();
  } catch {
    return false;
  }
}

/**
 * RFC 7591 Dynamic Client Registration.
 * Clients POST their metadata and receive a client_id back.
 * We accept any registration since auth is enforced at the authorize step.
 */
async function handleOAuthRegister(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse
): Promise<void> {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" }, { Allow: "POST" });
    return;
  }

  let body: Record<string, unknown> | null;
  try {
    const parsedBody = await readJsonBody<unknown>(req);
    body =
      parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody)
        ? (parsedBody as Record<string, unknown>)
        : null;
  } catch {
    body = null;
  }
  if (!body) {
    sendJson(res, 400, {
      error: "invalid_client_metadata",
      error_description: "Invalid JSON body",
    });
    return;
  }

  const redirectUris = body.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    sendJson(res, 400, {
      error: "invalid_client_metadata",
      error_description: "redirect_uris is required",
    });
    return;
  }

  for (const uri of redirectUris) {
    if (typeof uri !== "string" || !isValidRedirectUri(uri)) {
      sendJson(res, 400, {
        error: "invalid_redirect_uri",
        error_description: `Invalid redirect_uri: ${uri}`,
      });
      return;
    }
  }

  const grantTypesResult = parseRegistrationGrantTypes(body.grant_types);
  if (grantTypesResult.errorDescription !== null) {
    sendJson(res, 400, {
      error: "invalid_client_metadata",
      error_description: grantTypesResult.errorDescription,
    });
    return;
  }

  const clientId = `dyn_${randomBytes(16).toString("hex")}`;
  const clientName =
    typeof body.client_name === "string" ? body.client_name : "MCP Client";

  sendJson(res, 201, {
    client_id: clientId,
    client_name: clientName,
    redirect_uris: redirectUris,
    grant_types: grantTypesResult.grantTypes,
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
}

function parseRegistrationGrantTypes(grantTypesInput: unknown): {
  grantTypes: string[];
  errorDescription: string | null;
} {
  if (grantTypesInput === undefined) {
    return {
      grantTypes: ["authorization_code", "refresh_token"],
      errorDescription: null,
    };
  }
  if (!Array.isArray(grantTypesInput) || grantTypesInput.length === 0) {
    return {
      grantTypes: [],
      errorDescription: "grant_types must be a non-empty array",
    };
  }
  if (grantTypesInput.some((grantType) => typeof grantType !== "string")) {
    return {
      grantTypes: [],
      errorDescription: "grant_types values must be strings",
    };
  }

  const supportedGrantTypes = new Set(["authorization_code", "refresh_token"]);
  const normalized = [...new Set(grantTypesInput as string[])];
  if (normalized.some((grantType) => !supportedGrantTypes.has(grantType))) {
    return {
      grantTypes: [],
      errorDescription:
        "Only authorization_code and refresh_token grant_types are supported",
    };
  }
  if (!normalized.includes("authorization_code")) {
    return {
      grantTypes: [],
      errorDescription: "authorization_code grant_type is required",
    };
  }

  return { grantTypes: normalized, errorDescription: null };
}

/**
 * Build the HTML login page for the OAuth authorize endpoint.
 * The user pastes their API key and submits the form.
 */
function buildAuthorizeHtml(queryString: string, error?: string): string {
  const errorHtml = error
    ? `<div style="background:#fee;border:1px solid #c00;padding:12px;border-radius:6px;margin-bottom:16px;color:#900">${error}</div>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize — ClosedLoop MCP</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
    .card { background: #fff; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.1); padding: 32px; max-width: 420px; width: 100%; }
    h1 { font-size: 20px; margin: 0 0 8px; color: #111; }
    p { color: #666; font-size: 14px; margin: 0 0 24px; }
    label { display: block; font-size: 13px; font-weight: 600; color: #333; margin-bottom: 6px; }
    input[type="password"] { width: 100%; padding: 10px 12px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; font-family: monospace; box-sizing: border-box; }
    button { width: 100%; padding: 10px; background: #111; color: #fff; border: none; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; margin-top: 16px; }
    button:hover { background: #333; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Authorize MCP Access</h1>
    <p>Enter your ClosedLoop API key to grant access to the MCP client.</p>
    ${errorHtml}
    <form method="POST" action="/oauth/authorize?${queryString}">
      <label for="api_key">API Key</label>
      <input type="password" id="api_key" name="api_key" placeholder="sk_live_..." required autofocus>
      <button type="submit">Authorize</button>
    </form>
  </div>
</body>
</html>`;
}

function sendAuthorizeHtmlForm(
  res: import("node:http").ServerResponse,
  url: URL,
  error?: string
): void {
  const queryString = url.search.replace(LEADING_QUESTION_MARK_REGEX, "");
  const html = buildAuthorizeHtml(queryString, error);
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

async function extractApiKeyFromRequest(
  req: import("node:http").IncomingMessage
): Promise<string | null> {
  const headerKey = extractApiKey(req.headers.authorization ?? null);
  if (headerKey) {
    return headerKey;
  }
  if (req.method !== "POST") {
    return null;
  }
  try {
    const body = await readFormBody(req);
    const formKey = body.api_key;
    return formKey?.startsWith("sk_live_") ? formKey : null;
  } catch {
    return null;
  }
}

function isValidOAuthClientId(clientId: string | null): boolean {
  return (
    !!clientId && (clientId.startsWith("dyn_") || clientId === OAUTH_CLIENT_ID)
  );
}

async function handleOAuthAuthorize(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse
): Promise<void> {
  if (req.method !== "GET" && req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" }, { Allow: "GET, POST" });
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

  const url = new URL(req.url ?? "", MCP_SERVER_URL);
  const redirectUri = url.searchParams.get("redirect_uri");
  const state = url.searchParams.get("state") ?? undefined;

  const apiKey = await extractApiKeyFromRequest(req);
  if (!apiKey) {
    sendAuthorizeHtmlForm(
      res,
      url,
      req.method === "POST" ? "Invalid API key. Please try again." : undefined
    );
    return;
  }

  const context = await verifyApiKey(apiKey);
  if (!context) {
    if (req.method === "POST") {
      sendAuthorizeHtmlForm(
        res,
        url,
        "Invalid API key. Please check and try again."
      );
      return;
    }
    sendJson(res, 401, {
      error: "invalid_client",
      error_description: "Invalid API key",
    });
    return;
  }

  if (!(redirectUri && isValidRedirectUri(redirectUri))) {
    sendJson(res, 400, {
      error: "invalid_request",
      error_description: "Invalid or missing redirect_uri",
    });
    return;
  }

  if (url.searchParams.get("response_type") !== "code") {
    redirectWithParams(res, redirectUri, {
      error: "unsupported_response_type",
      error_description: "Only response_type=code is supported",
      state,
    });
    return;
  }

  if (!isValidOAuthClientId(url.searchParams.get("client_id"))) {
    redirectWithParams(res, redirectUri, {
      error: "unauthorized_client",
      error_description: "Invalid client_id",
      state,
    });
    return;
  }

  const codeChallenge = url.searchParams.get("code_challenge");
  if (
    !codeChallenge ||
    url.searchParams.get("code_challenge_method") !== "S256"
  ) {
    redirectWithParams(res, redirectUri, {
      error: "invalid_request",
      error_description:
        "code_challenge and code_challenge_method=S256 are required",
      state,
    });
    return;
  }

  const requestedScopes = parseScopeParam(url.searchParams.get("scope") ?? "");
  const keyScopes = effectiveKeyScopes(context.scopes);
  const scopes = resolveGrantedScopes(requestedScopes, keyScopes);
  if (scopes === null) {
    redirectWithParams(res, redirectUri, {
      error: "invalid_scope",
      error_description:
        "None of the requested scopes are granted for this key",
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
    clientId: url.searchParams.get("client_id") as string,
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
  if (
    !body.client_id ||
    (!body.client_id.startsWith("dyn_") && body.client_id !== OAUTH_CLIENT_ID)
  ) {
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
  const scopes = resolveGrantedScopes(requestedScopes, keyScopes);
  if (scopes === null) {
    sendOAuthJson(res, 400, {
      error: "invalid_scope",
      error_description:
        "None of the requested scopes are granted for this key",
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
  if (!(body.code && body.code_verifier)) {
    sendOAuthJson(res, 400, {
      error: "invalid_request",
      error_description: "code and code_verifier are required",
    });
    return;
  }

  const codeRecord = await loadAuthorizationCode(body.code);
  if (
    !codeRecord ||
    codeRecord.consumedAt !== null ||
    codeRecord.expiresAt <= new Date()
  ) {
    sendOAuthJson(res, 400, {
      error: "invalid_grant",
      error_description: "Invalid or expired authorization code",
    });
    return;
  }

  const clientId = body.client_id ?? codeRecord.clientId;
  if (
    !clientId ||
    (!clientId.startsWith("dyn_") && clientId !== OAUTH_CLIENT_ID)
  ) {
    sendInvalidClient(res, "Invalid client_id");
    return;
  }
  if (codeRecord.clientId !== clientId) {
    sendOAuthJson(res, 400, {
      error: "invalid_grant",
      error_description: "Authorization code was not issued to this client",
    });
    return;
  }

  const redirectUri = body.redirect_uri ?? codeRecord.redirectUri;
  if (codeRecord.redirectUri !== redirectUri) {
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

  const refreshToken = await withDb.tx(async (db) => {
    const currentCode = await db.oAuthAuthorizationCode.findUnique({
      where: { code: body.code },
      select: {
        id: true,
        consumedAt: true,
        expiresAt: true,
        clientId: true,
        redirectUri: true,
      },
    });
    const now = new Date();
    if (
      !currentCode ||
      currentCode.id !== codeRecord.id ||
      currentCode.consumedAt !== null ||
      currentCode.expiresAt <= now ||
      currentCode.clientId !== clientId ||
      currentCode.redirectUri !== redirectUri
    ) {
      return null;
    }

    const consumeResult = await db.oAuthAuthorizationCode.updateMany({
      where: { id: currentCode.id, consumedAt: null },
      data: { consumedAt: now },
    });
    if (consumeResult.count !== 1) {
      return null;
    }

    return createRefreshTokenRecord(
      db as unknown as OAuthRefreshTokenDbClient,
      {
        encryptedApiKey: codeRecord.encryptedApiKey,
        keyId: codeRecord.keyId,
        userId: context.userId,
        organizationId: context.organizationId,
        clientId: codeRecord.clientId,
        scopes,
        familyId: randomUUID(),
        expiresAt: new Date(
          Date.now() + OAUTH_REFRESH_TOKEN_TTL_SECONDS * 1000
        ),
      }
    );
  });
  if (!refreshToken) {
    sendOAuthJson(res, 400, {
      error: "invalid_grant",
      error_description: "Invalid or expired authorization code",
    });
    return;
  }

  const accessToken = issueOAuthAccessToken(codeApiKey, context, scopes);

  sendOAuthJson(res, 200, {
    access_token: accessToken,
    refresh_token: refreshToken.token,
    token_type: "Bearer",
    expires_in: OAUTH_TOKEN_TTL_SECONDS,
    refresh_token_expires_in: refreshToken.expiresIn,
    scope: scopes.join(" "),
  });
}

async function handleRefreshTokenGrant(
  body: OAuthTokenBody,
  res: import("node:http").ServerResponse
): Promise<void> {
  if (!body.refresh_token?.startsWith(OAUTH_REFRESH_TOKEN_PREFIX)) {
    sendOAuthJson(res, 400, {
      error: "invalid_request",
      error_description: "refresh_token is required",
    });
    return;
  }

  // Best-effort pre-check for clearer OAuth errors; rotateRefreshToken below
  // revalidates token state transactionally as the authoritative gate.
  const refreshRecord = await loadRefreshTokenRecord(body.refresh_token);
  if (!refreshRecord || refreshRecord.expiresAt <= new Date()) {
    sendOAuthJson(res, 400, {
      error: "invalid_grant",
      error_description: "Invalid or expired refresh token",
    });
    return;
  }

  const clientId = body.client_id ?? refreshRecord.clientId;
  if (
    !clientId ||
    (!clientId.startsWith("dyn_") && clientId !== OAUTH_CLIENT_ID)
  ) {
    sendInvalidClient(res, "Invalid client_id");
    return;
  }
  if (refreshRecord.clientId !== clientId) {
    sendOAuthJson(res, 400, {
      error: "invalid_grant",
      error_description: "Refresh token was not issued to this client",
    });
    return;
  }

  if (refreshRecord.revokedAt !== null) {
    // Intentionally conservative: if a revoked token is presented by the bound
    // client, revoke the remaining family immediately. A concurrent rotation
    // may cause over-revocation (forcing re-auth), which is preferred over
    // under-revocation in replay scenarios.
    await revokeRefreshTokenFamily(refreshRecord.familyId);
    sendOAuthJson(res, 400, {
      error: "invalid_grant",
      error_description: "Refresh token reuse detected",
    });
    return;
  }

  const plaintextKey = decryptApiKey(
    refreshRecord.encryptedApiKey,
    refreshRecord.keyId
  );
  if (!plaintextKey) {
    await revokeRefreshTokenFamily(refreshRecord.familyId);
    sendOAuthJson(res, 400, {
      error: "invalid_grant",
      error_description: "Refresh token is no longer valid",
    });
    return;
  }

  const context = await verifyApiKey(plaintextKey);
  if (!context) {
    await revokeRefreshTokenFamily(refreshRecord.familyId);
    sendOAuthJson(res, 400, {
      error: "invalid_grant",
      error_description: "Refresh token is no longer valid",
    });
    return;
  }

  const keyScopes = effectiveKeyScopes(context.scopes);
  const grantScopes = refreshRecord.scopes.filter((scope) =>
    keyScopes.includes(scope)
  );
  const requestedScopes = parseScopeParam(body.scope);
  const scopes = requestedScopes.length > 0 ? requestedScopes : grantScopes;
  const hasInvalidScope = scopes.some((scope) => !grantScopes.includes(scope));
  if (hasInvalidScope) {
    sendOAuthJson(res, 400, {
      error: "invalid_scope",
      error_description: "Requested scope exceeds the refresh token grant",
    });
    return;
  }

  const rotated = await rotateRefreshToken(
    body.refresh_token,
    clientId,
    scopes
  );
  if (rotated.status === "reuse_detected") {
    sendOAuthJson(res, 400, {
      error: "invalid_grant",
      error_description: "Refresh token reuse detected",
    });
    return;
  }
  if (rotated.status === "invalid") {
    sendOAuthJson(res, 400, {
      error: "invalid_grant",
      error_description: "Invalid or expired refresh token",
    });
    return;
  }
  if (rotated.status === "invalid_client") {
    sendOAuthJson(res, 400, {
      error: "invalid_grant",
      error_description: "Refresh token was not issued to this client",
    });
    return;
  }
  if (rotated.status === "invalid_scope") {
    // Defensive fallback: scope validation currently happens before rotate call.
    sendOAuthJson(res, 400, {
      error: "invalid_scope",
      error_description: "Requested scope exceeds the refresh token grant",
    });
    return;
  }

  const accessToken = issueOAuthAccessToken(plaintextKey, context, scopes);
  sendOAuthJson(res, 200, {
    access_token: accessToken,
    refresh_token: rotated.token,
    token_type: "Bearer",
    expires_in: OAUTH_TOKEN_TTL_SECONDS,
    refresh_token_expires_in: rotated.expiresIn,
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
  const isFormEncoded = contentType.includes(
    "application/x-www-form-urlencoded"
  );
  const isJson = contentType.includes("application/json");
  if (!(isFormEncoded || isJson)) {
    sendOAuthJson(res, 415, {
      error:
        "Unsupported Media Type. Expected: application/x-www-form-urlencoded or application/json",
    });
    return;
  }

  let body: OAuthTokenBody;
  try {
    if (isFormEncoded) {
      const rawBody = await readRequestBody(req);
      body = parseFormUrlEncoded(rawBody);
    } else {
      const parsedBody = await readJsonBody<unknown>(req);
      const normalized = normalizeOAuthTokenBody(parsedBody);
      if (!normalized) {
        sendOAuthJson(res, 400, {
          error: "invalid_request",
          error_description: "Malformed JSON request body",
        });
        return;
      }
      body = normalized;
    }
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

  if (body.grant_type === "client_credentials") {
    await handleClientCredentialsGrant(body, res);
    return;
  }

  if (body.grant_type === "authorization_code") {
    await handleAuthorizationCodeGrant(body, res);
    return;
  }

  if (body.grant_type === "refresh_token") {
    await handleRefreshTokenGrant(body, res);
    return;
  }

  sendOAuthJson(res, 400, {
    error: "unsupported_grant_type",
    error_description:
      "Supported grant types are client_credentials, authorization_code, and refresh_token",
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
  if (
    !(
      body?.token &&
      (body.token.startsWith("mcp_at_") ||
        body.token.startsWith(OAUTH_REFRESH_TOKEN_PREFIX))
    )
  ) {
    sendOAuthJson(res, 400, {
      error: "invalid_request",
      error_description: "JSON body with access or refresh token is required",
    });
    return;
  }

  if (body.token.startsWith(OAUTH_REFRESH_TOKEN_PREFIX)) {
    await revokeRefreshToken(body.token);
    sendOAuthJson(res, 200, {
      revoked: true,
      token_type: "refresh_token",
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
    token_type: "access_token",
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
      authorization_servers: [MCP_SERVER_URL],
      scopes_supported: [...API_KEY_SCOPES],
      bearer_methods_supported: ["header"],
      resource_documentation: "https://docs.closedloop.ai/mcp",
    });
  },
  "/.well-known/oauth-authorization-server": (_req, res) => {
    sendJson(res, 200, {
      issuer: MCP_SERVER_URL,
      authorization_endpoint: `${MCP_SERVER_URL}/oauth/authorize`,
      token_endpoint: `${MCP_SERVER_URL}/oauth/token`,
      registration_endpoint: `${MCP_SERVER_URL}/oauth/register`,
      introspection_endpoint: `${MCP_SERVER_URL}/internal/oauth/introspect`,
      revocation_endpoint: `${MCP_SERVER_URL}/internal/oauth/revoke`,
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      grant_types_supported: [
        "authorization_code",
        "client_credentials",
        "refresh_token",
      ],
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
  if (
    pathname === "/mcp" ||
    pathname.startsWith("/oauth/") ||
    pathname.startsWith("/.well-known/oauth-")
  ) {
    console.log(
      `[http] method=${req.method ?? ""} path=${pathname} origin=${req.headers.origin ?? ""} host=${req.headers.host ?? ""}`
    );
  }

  if (pathname === "/oauth/register") {
    await handleOAuthRegister(req, res);
    return true;
  }

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

/**
 * CORS origin allowlist read from MCP_CORS_ORIGINS (comma-separated).
 * In local environments, all origins are allowed when unset.
 * A wildcard "*" entry allows any origin.
 */
const CORS_ALLOWED_ORIGINS = (process.env.MCP_CORS_ORIGINS ?? "")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

function getCorsOrigin(
  req: import("node:http").IncomingMessage
): string | null {
  const origin = req.headers.origin;
  if (!origin) {
    return null;
  }
  // Same-origin requests are always allowed
  if (origin === MCP_SERVER_URL) {
    return origin;
  }
  // Wildcard or explicit match
  if (
    CORS_ALLOWED_ORIGINS.includes("*") ||
    CORS_ALLOWED_ORIGINS.includes(origin)
  ) {
    return origin;
  }
  // Local dev: allow any origin when no allowlist is configured
  if (CORS_ALLOWED_ORIGINS.length === 0 && isLocalOauthEnvironment()) {
    return origin;
  }
  return null;
}

function setCorsHeaders(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse
): boolean {
  const allowedOrigin = getCorsOrigin(req);
  res.setHeader("Vary", "Origin");
  if (!allowedOrigin) {
    return false;
  }
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version"
  );
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  res.setHeader("Access-Control-Max-Age", "86400");
  return true;
}

export function createHttpServer(): import("node:http").Server {
  return createServer(async (req, res) => {
    // CORS: set headers on every response, handle preflight
    const corsAllowed = setCorsHeaders(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(corsAllowed ? 204 : 403);
      res.end();
      return;
    }

    // Reject cross-origin requests from disallowed origins (prevents blind CSRF)
    if (req.headers.origin && !corsAllowed) {
      console.warn(
        `[mcp] cors-blocked origin=${req.headers.origin} host=${req.headers.host ?? ""} method=${req.method ?? ""} path=${req.url ?? ""}`
      );
      res.writeHead(403);
      res.end();
      return;
    }

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
  isInternalAddressAllowed,
  requireRedirectAllowlistForEnvironment,
  requireInternalAllowlistForEnvironment,
  resetInMemorySecurityState: () => {
    lastOAuthCleanupMs = 0;
    mcpSessions.clear();
  },
};
