import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "@libsql/client";
import {
  type ClaudeTelemetryUpload,
  routeClaudeTelemetrySync,
} from "../e2e/helpers/claude-code-telemetry-sync-fixture.js";
import type { launchDesktopApp } from "../e2e/helpers/desktop-app.js";
import {
  branchesDbPath,
  waitForMigrationsApplied,
} from "../e2e/helpers/desktop-seed-core.js";
import type { startAuthenticatedCloudRelay } from "../e2e/helpers/fake-cloud-relay.js";

export const SYNTHETIC_KEY = "sk_live_iss_10574_disposable_fixture";
export const SYNTHETIC_FRESH_KEY = "sk_live_iss_10574_fresh_fixture";
export const SYNTHETIC_SESSION_ID = "iss-10574-isolated-local-row";
export const PROFILE_ID = "iss-10574-disposable-profile";
export const INACTIVE_PROFILE_ID = "iss-10574-inactive-profile";
export const SYNTHETIC_ACCESS_TOKEN = "iss-10574-synthetic-access";
export const SYNTHETIC_REFRESH_TOKEN = "iss-10574-synthetic-refresh";
export const SYNTHETIC_USER_ID = "iss-10574-synthetic-user";
export const SYNTHETIC_ORGANIZATION_ID = "iss-10574-synthetic-org";
export const SYNTHETIC_GATEWAY_ID = "00000000-0000-4000-8000-000000010574";
export const TOKEN_EXPIRY = "2027-09-21T00:00:00.000Z";
export const MANUAL_ASSERTION_DEADLINE_MS = 10_000;
export const SYNTHETIC_BRANCH = "feature/iss-10574-local";
export const SYNTHETIC_REPO = "closedloop/iss-10574-fixture";

export type SyntheticBffRequest = {
  authorization: string | null;
  method: string;
  pathname: string;
  statusCode?: number;
};

export type SyntheticBff = {
  origin: string;
  requests: SyntheticBffRequest[];
  claudeUploads: () => readonly ClaudeTelemetryUpload[];
  provisionCount: () => number;
  close: () => Promise<void>;
  isRevokePending: () => boolean;
  releaseRevoke: () => void;
  setIdentity: (
    userId: string,
    organizationId: string,
    refreshToken: string
  ) => void;
  setOffline: (offline: boolean) => void;
};

type SyntheticBffState = {
  offline: boolean;
  userId: string;
  organizationId: string;
  refreshToken: string;
  requests: SyntheticBffRequest[];
  revokeResponse: ServerResponse | null;
  provisionCount: number;
  claudeUploads: ClaudeTelemetryUpload[];
};

export async function startSyntheticBff(): Promise<SyntheticBff> {
  const state: SyntheticBffState = {
    offline: false,
    userId: SYNTHETIC_USER_ID,
    organizationId: SYNTHETIC_ORGANIZATION_ID,
    refreshToken: SYNTHETIC_REFRESH_TOKEN,
    requests: [],
    revokeResponse: null,
    provisionCount: 0,
    claudeUploads: [],
  };
  const server = createServer((request, response) => {
    routeSyntheticBffRequest(state, request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("synthetic BFF did not bind a port");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests: state.requests,
    provisionCount: () => state.provisionCount,
    claudeUploads: () => state.claudeUploads,
    isRevokePending: () => state.revokeResponse !== null,
    releaseRevoke: () => {
      if (state.revokeResponse && !state.revokeResponse.writableEnded) {
        state.revokeResponse.statusCode = 204;
        state.revokeResponse.end();
      }
      state.revokeResponse = null;
    },
    setIdentity: (userId, organizationId, refreshToken) => {
      state.userId = userId;
      state.organizationId = organizationId;
      state.refreshToken = refreshToken;
    },
    setOffline: (offline) => {
      state.offline = offline;
    },
    close: () => closeServer(server),
  };
}

export async function seedSyntheticDesktopSession(
  app: Awaited<ReturnType<typeof launchDesktopApp>>["app"],
  userDataDir: string,
  identity: {
    userId: string;
    organizationId: string;
    refreshToken: string;
  } = {
    userId: SYNTHETIC_USER_ID,
    organizationId: SYNTHETIC_ORGANIZATION_ID,
    refreshToken: SYNTHETIC_REFRESH_TOKEN,
  }
): Promise<void> {
  const { privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString();
  const encrypted = await app.evaluate(
    ({ safeStorage }, payload) => ({
      session: safeStorage.encryptString(payload.session).toString("base64"),
      signingKey: safeStorage
        .encryptString(payload.privateKey)
        .toString("base64"),
    }),
    {
      session: JSON.stringify({
        refreshToken: identity.refreshToken,
        refreshTokenExpiresAt: TOKEN_EXPIRY,
        userId: identity.userId,
        organizationId: identity.organizationId,
        gatewayId: SYNTHETIC_GATEWAY_ID,
      }),
      privateKey: privateKeyPem,
    }
  );
  fs.writeFileSync(
    path.join(userDataDir, "desktop-session.json"),
    JSON.stringify({ encryptedSession: encrypted.session }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(userDataDir, "desktop-gateway-signing-keys.json"),
    JSON.stringify({
      encryptedPrivateKeysByGatewayId: {
        [SYNTHETIC_GATEWAY_ID]: encrypted.signingKey,
      },
    }),
    "utf8"
  );
}

export async function seedEncryptedApiKeys(
  app: Awaited<ReturnType<typeof launchDesktopApp>>["app"],
  userDataDir: string,
  key: string = SYNTHETIC_KEY,
  includeCompatibilityCopies = true
): Promise<void> {
  const encrypted = await app.evaluate(
    ({ safeStorage }, value) =>
      safeStorage.encryptString(value).toString("base64"),
    key
  );
  fs.writeFileSync(
    path.join(userDataDir, "desktop-secrets.json"),
    JSON.stringify({
      encryptedApiKey: encrypted,
      apiKeyProvenance: "DESKTOP_MANAGED",
      [`profile:${PROFILE_ID}`]: encrypted,
      [`profile:${PROFILE_ID}:provenance`]: "DESKTOP_MANAGED",
      ...(includeCompatibilityCopies
        ? {
            [`profile:${INACTIVE_PROFILE_ID}`]: encrypted,
            [`profile:${INACTIVE_PROFILE_ID}:provenance`]: "USER_CREATED",
            "profile:orphan-fixture": encrypted,
            "profile:orphan-fixture:provenance": "USER_CREATED",
          }
        : {}),
    }),
    "utf8"
  );
}

export function seedProfile(
  userDataDir: string,
  apiOrigin: string,
  relayOrigin: string,
  includeManagedMetadata = true
): void {
  const settingsPath = path.join(userDataDir, "desktop-settings.json");
  const settings = readJsonFile(settingsPath);
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      ...settings,
      apiOrigin,
      relayOrigin,
      webAppOrigin: "http://127.0.0.1:3000",
      cloudConnectionEnabled: true,
      activeConfigId: PROFILE_ID,
      savedConfigs: [
        {
          id: PROFILE_ID,
          name: "ISS-10574 Disposable",
          apiOrigin,
          relayOrigin,
          webAppOrigin: "http://127.0.0.1:3000",
          gatewayId: SYNTHETIC_GATEWAY_ID,
          ...(includeManagedMetadata
            ? {
                apiKeySource: "DESKTOP_MANAGED",
                gatewayPublicKeyPem: "synthetic-fixture-only",
                desktopSecurityUpgradeProtocolVersion: 1,
                lastComputeTargetId: "iss-10574-old-target",
                lastComputeTargetEnvironmentKey: "iss-10574-old-environment",
                desktopSecurityPromptDismissedAt: "2026-09-21T00:00:00.000Z",
                pendingOnboardingAttemptId: "iss-10574-old-attempt",
              }
            : {}),
          sandboxBaseDirectory: path.join(userDataDir, "sandbox"),
        },
        {
          id: INACTIVE_PROFILE_ID,
          name: "ISS-10574 Inactive Disposable",
          apiOrigin,
          relayOrigin,
          webAppOrigin: "http://127.0.0.1:3000",
          ...(includeManagedMetadata
            ? {
                apiKeySource: "USER_CREATED",
                gatewayId: SYNTHETIC_GATEWAY_ID,
                gatewayPublicKeyPem: "inactive-fixture-only",
                desktopSecurityUpgradeProtocolVersion: 1,
                lastComputeTargetId: "iss-10574-old-inactive-target",
                lastComputeTargetEnvironmentKey:
                  "iss-10574-old-inactive-environment",
                desktopSecurityPromptDismissedAt: "2026-09-21T00:00:00.000Z",
                pendingOnboardingAttemptId: "iss-10574-old-inactive-attempt",
              }
            : {}),
          sandboxBaseDirectory: path.join(userDataDir, "inactive-sandbox"),
        },
      ],
    }),
    "utf8"
  );
}

export async function seedPreservedDatabaseState(
  userDataDir: string
): Promise<void> {
  const client = createClient({
    url: `file:${branchesDbPath(userDataDir)}`,
    intMode: "number",
  });
  try {
    await client.batch([
      {
        sql: `INSERT INTO agent_component_invocation_sync_cursors
                (source_key, external_session_id, external_generation_id,
                 source_sequence, updated_at)
              VALUES (?, ?, ?, ?, ?)`,
        args: [
          "iss-10574-preserved-source",
          SYNTHETIC_SESSION_ID,
          "generation-1",
          42,
          "2026-09-21T11:30:00.000Z",
        ],
      },
    ]);
    await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    client.close();
  }
}

export async function readPreservedDatabaseState(userDataDir: string): Promise<{
  cursors: unknown[];
  sessions: unknown[];
  branches: unknown[];
}> {
  const client = createClient({
    url: `file:${branchesDbPath(userDataDir)}`,
    intMode: "number",
  });
  try {
    const cursors = await client.execute(
      "SELECT source_key, external_session_id, external_generation_id, source_sequence, updated_at FROM agent_component_invocation_sync_cursors WHERE source_key = 'iss-10574-preserved-source' ORDER BY external_session_id"
    );
    const sessions = await client.execute(
      "SELECT id, name, status, started_at, updated_at FROM sessions WHERE id IN ('iss-10574-isolated-local-row', 'iss-10574-local-branch-session') ORDER BY id"
    );
    const branches = await client.execute(
      "SELECT a.repo_full_name, a.branch_name, sal.session_id, sal.relation, sal.method FROM artifacts a JOIN session_artifact_links sal ON sal.artifact_id = a.id WHERE a.repo_full_name = 'closedloop/iss-10574-fixture' ORDER BY a.branch_name, sal.session_id"
    );
    return {
      cursors: cursors.rows,
      sessions: sessions.rows,
      branches: branches.rows,
    };
  } finally {
    client.close();
  }
}

export function seedPendingCleanupJournal(userDataDir: string): void {
  fs.writeFileSync(
    path.join(userDataDir, "desktop-sign-out-cleanup.json"),
    JSON.stringify({ pending: true }),
    "utf8"
  );
}

export function isCleanupPending(userDataDir: string): boolean {
  const filePath = path.join(userDataDir, "desktop-sign-out-cleanup.json");
  return fs.existsSync(filePath) && readJsonFile(filePath).pending === true;
}

export async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  failure: string,
  timeoutMs = MANUAL_ASSERTION_DEADLINE_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await delay(50);
  }
  throw new Error(failure);
}

export function relayLedger(
  relay: Awaited<ReturnType<typeof startAuthenticatedCloudRelay>>
): {
  acknowledgements: number;
  commands: number;
  hellos: number;
  presence: number;
} {
  return {
    acknowledgements: relay.ackCount(),
    commands: relay.commandCount(),
    hellos: relay.helloCount(),
    presence: relay.presenceCount(),
  };
}

export function readJsonFile(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<
    string,
    unknown
  >;
}

function routeSyntheticBffRequest(
  state: SyntheticBffState,
  request: IncomingMessage,
  response: ServerResponse
): void {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  const recorded: SyntheticBffRequest = {
    authorization: request.headers.authorization ?? null,
    method: request.method ?? "GET",
    pathname,
  };
  state.requests.push(recorded);
  response.once("finish", () => {
    recorded.statusCode = response.statusCode;
  });
  if (state.offline) {
    response.statusCode = 503;
    response.end();
    return;
  }
  if (
    request.method === "POST" &&
    pathname === "/desktop/managed-key/provision"
  ) {
    state.provisionCount += 1;
    writeJson(response, { apiKey: SYNTHETIC_FRESH_KEY });
    return;
  }
  if (request.method === "GET" && pathname === "/desktop/identity") {
    writeJson(response, {
      userId: state.userId,
      organizationId: state.organizationId,
      email: "fixture@closedloop.test",
      firstName: "Synthetic",
      lastName: "User",
      organizationName: "Synthetic fixture",
      organizationSlug: "iss-10574-fixture",
      sessionSyncPolicyEnabled: true,
      sessionSyncPolicySupported: true,
    });
    return;
  }
  if (routeClaudeTelemetrySync(request, response, state.claudeUploads)) {
    return;
  }
  if (
    routeSyntheticSession(state, request.method ?? "GET", pathname, response) ||
    routeSyntheticDirectory(pathname, response)
  ) {
    return;
  }
  response.statusCode = 404;
  response.end();
}

function routeSyntheticSession(
  state: SyntheticBffState,
  method: string,
  pathname: string,
  response: ServerResponse
): boolean {
  if (method === "POST" && pathname === "/desktop/session/refresh") {
    writeJson(response, {
      accessToken: SYNTHETIC_ACCESS_TOKEN,
      accessTokenExpiresAt: TOKEN_EXPIRY,
      refreshToken: state.refreshToken,
      refreshTokenExpiresAt: TOKEN_EXPIRY,
      userId: state.userId,
      organizationId: state.organizationId,
    });
    return true;
  }
  if (method === "POST" && pathname === "/desktop/session/revoke") {
    state.revokeResponse = response;
    return true;
  }
  return false;
}

function routeSyntheticDirectory(
  pathname: string,
  response: ServerResponse
): boolean {
  if (pathname !== "/users" && pathname !== "/repositories") {
    return false;
  }
  writeJson(response, []);
  return true;
}

function writeJson(response: ServerResponse, body: unknown): void {
  response.statusCode = 200;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/** Waits for the exact Desktop migration manifest before offline fixture writes. */
export async function awaitBootstrappedDesktopSchema(
  userDataDir: string
): Promise<void> {
  const client = createClient({
    url: `file:${branchesDbPath(userDataDir)}`,
    intMode: "number",
  });
  try {
    await waitForMigrationsApplied(client, 30_000);
  } finally {
    client.close();
  }
}
