import { generateKeyPairSync } from "node:crypto";
import { OIDC_CONFIG } from "@repo/http-service/test-support/oidc-fixture";
import { EnvValidationError } from "@repo/observability/boot-env";
import { log } from "@repo/observability/log";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DOC_SYNC_PG_POOL_MAX,
  DEFAULT_DOC_SYNC_PG_PORT,
  DEFAULT_DOC_SYNC_PORT,
  DEFAULT_DOC_SYNC_SHUTDOWN_DEADLINE_MS,
  DOC_SYNC_ENV_INVALID_EVENT,
  DocSyncPgAuth,
  loadDocSyncEnvOrExit,
  MAX_DOC_SYNC_PG_POOL_MAX,
  MAX_TCP_PORT,
  MAX_TIMER_DELAY_MS,
  parseDocSyncEnv,
} from "../env";

const PORT = "DOC_SYNC_PORT";
const DEADLINE = "DOC_SYNC_SHUTDOWN_DEADLINE_MS";
const PG_AUTH = "DOC_SYNC_PG_AUTH";
const PG_HOST = "DOC_SYNC_PG_HOST";
const PG_PORT = "DOC_SYNC_PG_PORT";
const PG_USER = "DOC_SYNC_PG_USER";
const PG_DATABASE = "DOC_SYNC_PG_DATABASE";
const PG_PASSWORD = "DOC_SYNC_PG_PASSWORD";
const PG_POOL_MAX = "DOC_SYNC_PG_POOL_MAX";
const REGION = "AWS_REGION";
const TOKEN_KEYS = "REALTIME_TOKEN_PUBLIC_KEYS";
const ORIGINS = "DOC_SYNC_ALLOWED_ORIGINS";
const OIDC_ISSUER = "DOC_SYNC_INTERNAL_OIDC_ISSUER";
const OIDC_AUDIENCE = "DOC_SYNC_INTERNAL_OIDC_AUDIENCE";
const OIDC_OWNER_ID = "DOC_SYNC_INTERNAL_OIDC_OWNER_ID";
const OIDC_PROJECT_ID = "DOC_SYNC_INTERNAL_OIDC_PROJECT_ID";
const OIDC_ENVIRONMENT = "DOC_SYNC_INTERNAL_OIDC_ENVIRONMENT";
const ECS_METADATA = "ECS_CONTAINER_METADATA_URI_V4";
const CALLBACK_URL = "DOC_SYNC_CALLBACK_URL";
const OIDC_KEYS = [
  OIDC_ISSUER,
  OIDC_AUDIENCE,
  OIDC_OWNER_ID,
  OIDC_PROJECT_ID,
  OIDC_ENVIRONMENT,
];

const KID = "0b2c4d6e-1f3a-4b5c-8d7e-9f0a1b2c3d4e";
const PUBLIC_KEYS_JSON = JSON.stringify({
  [KID]: generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({
    type: "spki",
    format: "pem",
  }),
});

/** The five internal OIDC keys, every one required whatever the auth mode. */
const INTERNAL_OIDC: Record<string, string> = {
  [OIDC_ISSUER]: OIDC_CONFIG.issuer,
  [OIDC_AUDIENCE]: OIDC_CONFIG.audience,
  [OIDC_OWNER_ID]: OIDC_CONFIG.ownerId,
  [OIDC_PROJECT_ID]: OIDC_CONFIG.projectId,
  [OIDC_ENVIRONMENT]: OIDC_CONFIG.environment,
};

/** Every key password auth needs, so a case only states what it changes. */
const PASSWORD_PG: Record<string, string> = {
  ...INTERNAL_OIDC,
  [PG_AUTH]: DocSyncPgAuth.Password,
  [PG_HOST]: "localhost",
  [PG_USER]: "postgres",
  [PG_DATABASE]: "doc_sync",
  [PG_PASSWORD]: "local-password",
  [TOKEN_KEYS]: PUBLIC_KEYS_JSON,
};

const IAM_PG: Record<string, string> = {
  ...INTERNAL_OIDC,
  [PG_AUTH]: DocSyncPgAuth.Iam,
  [PG_HOST]: "doc-sync.cluster-abc.us-east-1.rds.amazonaws.com",
  [PG_USER]: "doc_sync",
  [PG_DATABASE]: "doc_sync",
  [REGION]: "us-east-1",
  [TOKEN_KEYS]: PUBLIC_KEYS_JSON,
};

/** The auth half of a parsed env: keys by kid, and no browser origin allowed. */
const DEFAULT_AUTH = {
  tokenPublicKeys: expect.any(Map),
  allowedOrigins: [],
  internalOidc: OIDC_CONFIG,
};

const PASSWORD_PG_CONFIG = {
  auth: DocSyncPgAuth.Password,
  host: "localhost",
  port: DEFAULT_DOC_SYNC_PG_PORT,
  user: "postgres",
  database: "doc_sync",
  password: "local-password",
  poolMax: DEFAULT_DOC_SYNC_PG_POOL_MAX,
};

function issueKeys(source: Record<string, string | undefined>): string[] {
  try {
    parseDocSyncEnv(source);
  } catch (error) {
    if (error instanceof EnvValidationError) {
      return error.issues.map((issue) => issue.key);
    }
    throw error;
  }
  return [];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseDocSyncEnv", () => {
  it("defaults every optional key when only the required ones are set", () => {
    expect(parseDocSyncEnv(PASSWORD_PG)).toEqual({
      port: DEFAULT_DOC_SYNC_PORT,
      shutdownDeadlineMs: DEFAULT_DOC_SYNC_SHUTDOWN_DEADLINE_MS,
      pg: PASSWORD_PG_CONFIG,
      ...DEFAULT_AUTH,
    });
  });

  it("reads a blank value as unset", () => {
    expect(
      parseDocSyncEnv({
        ...PASSWORD_PG,
        [PORT]: "  ",
        [DEADLINE]: "",
        [PG_PORT]: "",
        [PG_POOL_MAX]: " ",
      })
    ).toEqual({
      port: DEFAULT_DOC_SYNC_PORT,
      shutdownDeadlineMs: DEFAULT_DOC_SYNC_SHUTDOWN_DEADLINE_MS,
      pg: PASSWORD_PG_CONFIG,
      ...DEFAULT_AUTH,
    });
  });

  it("reads set values", () => {
    expect(
      parseDocSyncEnv({
        ...PASSWORD_PG,
        [PORT]: "4050",
        [DEADLINE]: "15000",
        [PG_PORT]: "6432",
        [PG_POOL_MAX]: "10",
      })
    ).toEqual({
      port: 4050,
      shutdownDeadlineMs: 15_000,
      pg: { ...PASSWORD_PG_CONFIG, port: 6432, poolMax: 10 },
      ...DEFAULT_AUTH,
    });
  });

  it("reads IAM auth with its region and no password", () => {
    expect(parseDocSyncEnv(IAM_PG).pg).toEqual({
      auth: DocSyncPgAuth.Iam,
      host: IAM_PG[PG_HOST],
      port: DEFAULT_DOC_SYNC_PG_PORT,
      user: "doc_sync",
      database: "doc_sync",
      region: "us-east-1",
      poolMax: DEFAULT_DOC_SYNC_PG_POOL_MAX,
    });
  });

  it("names every key password auth needs when none is set, each as its own issue", () => {
    expect(issueKeys({})).toEqual([
      PG_HOST,
      PG_USER,
      PG_DATABASE,
      TOKEN_KEYS,
      PG_AUTH,
      PG_PASSWORD,
      ...OIDC_KEYS,
    ]);
  });

  it.each(OIDC_KEYS)("reports %s missing under either auth mode", (key) => {
    expect(issueKeys({ ...PASSWORD_PG, [key]: undefined })).toEqual([key]);
    expect(issueKeys({ ...IAM_PG, [key]: " " })).toEqual([key]);
  });

  it("refuses a development OIDC environment on ECS, naming the key", () => {
    const development = { ...PASSWORD_PG, [OIDC_ENVIRONMENT]: "development" };

    expect(issueKeys(development)).toEqual([]);
    expect(
      issueKeys({ ...development, [ECS_METADATA]: "http://169.254.170.2/v4" })
    ).toEqual([OIDC_ENVIRONMENT]);
  });

  it.each([PG_HOST, PG_USER, PG_DATABASE, PG_AUTH, PG_PASSWORD, TOKEN_KEYS])(
    "reports %s missing under password auth",
    (key) => {
      expect(issueKeys({ ...PASSWORD_PG, [key]: undefined })).toEqual([key]);
    }
  );

  it.each([PG_HOST, PG_USER, PG_DATABASE, REGION, TOKEN_KEYS])(
    "reports %s missing under IAM auth",
    (key) => {
      expect(issueKeys({ ...IAM_PG, [key]: undefined })).toEqual([key]);
    }
  );

  it("does not ask IAM auth for a password", () => {
    expect(issueKeys({ ...IAM_PG, [PG_PASSWORD]: undefined })).toEqual([]);
  });

  it("refuses an unknown auth mode, naming the key", () => {
    expect(issueKeys({ ...PASSWORD_PG, [PG_AUTH]: "trust" })).toEqual([
      PG_AUTH,
    ]);
  });

  it.each([
    [PORT, "1"],
    [PORT, String(MAX_TCP_PORT)],
    [DEADLINE, "1"],
    [DEADLINE, String(MAX_TIMER_DELAY_MS)],
    [PG_PORT, "1"],
    [PG_PORT, String(MAX_TCP_PORT)],
    [PG_POOL_MAX, "1"],
    [PG_POOL_MAX, String(MAX_DOC_SYNC_PG_POOL_MAX)],
  ])("accepts %s at its bound %s", (key, value) => {
    expect(issueKeys({ ...PASSWORD_PG, [key]: value })).toEqual([]);
  });

  it.each([
    [PORT, "0"],
    [PORT, String(MAX_TCP_PORT + 1)],
    [PORT, "3050.5"],
    [PORT, "not-a-port"],
    [DEADLINE, "0"],
    [DEADLINE, String(MAX_TIMER_DELAY_MS + 1)],
    [DEADLINE, "-1"],
    [DEADLINE, "Infinity"],
    [PG_PORT, "0"],
    [PG_PORT, String(MAX_TCP_PORT + 1)],
    [PG_POOL_MAX, "0"],
    [PG_POOL_MAX, String(MAX_DOC_SYNC_PG_POOL_MAX + 1)],
    [PG_POOL_MAX, "2.5"],
  ])("refuses %s=%s, naming the key", (key, value) => {
    expect(issueKeys({ ...PASSWORD_PG, [key]: value })).toEqual([key]);
  });

  it("reads the token public keys by kid", () => {
    expect([...parseDocSyncEnv(PASSWORD_PG).tokenPublicKeys.keys()]).toEqual([
      KID,
    ]);
  });

  it.each([
    ["blank", " "],
    ["not a public key", JSON.stringify({ [KID]: "not a pem" })],
  ])("refuses %s token public keys, naming the key", (_label, value) => {
    expect(issueKeys({ ...PASSWORD_PG, [TOKEN_KEYS]: value })).toEqual([
      TOKEN_KEYS,
    ]);
  });

  it("reads the allowed origins, trimmed, skipping empty entries", () => {
    expect(
      parseDocSyncEnv({
        ...PASSWORD_PG,
        [ORIGINS]: " http://localhost:3000, ,https://app.example.com ",
      }).allowedOrigins
    ).toEqual(["http://localhost:3000", "https://app.example.com"]);
  });

  it.each(["http://localhost:3000/", "localhost:3000"])(
    "refuses the allowed origin %s, which is not a bare origin",
    (origin) => {
      expect(
        issueKeys({
          ...PASSWORD_PG,
          [ORIGINS]: `http://localhost:3000,${origin}`,
        })
      ).toEqual([ORIGINS]);
    }
  );

  it("names every invalid key, never its value", () => {
    try {
      parseDocSyncEnv({
        ...PASSWORD_PG,
        [PORT]: "99999",
        [DEADLINE]: "0",
        [PG_PASSWORD]: undefined,
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const { issues } = error as EnvValidationError;
      expect(issues.map((issue) => issue.key)).toEqual([
        PORT,
        DEADLINE,
        PG_PASSWORD,
      ]);
      expect(JSON.stringify(issues)).not.toContain("99999");
    }
  });

  it("turns change callbacks off while DOC_SYNC_CALLBACK_URL is unset or blank", () => {
    expect(parseDocSyncEnv(IAM_PG).callbacks).toBeUndefined();
    expect(
      parseDocSyncEnv({ ...IAM_PG, [CALLBACK_URL]: " " }).callbacks
    ).toBeUndefined();
  });

  it("reads the callback URL with AWS_REGION", () => {
    expect(
      parseDocSyncEnv({ ...IAM_PG, [CALLBACK_URL]: "https://api.example.com" })
        .callbacks
    ).toEqual({ url: "https://api.example.com", region: "us-east-1" });
  });

  it("names AWS_REGION when the callback URL is set without it, and a URL that is not http(s)", () => {
    expect(
      issueKeys({ ...PASSWORD_PG, [CALLBACK_URL]: "https://api.example.com" })
    ).toEqual([REGION]);
    expect(
      issueKeys({ ...IAM_PG, [CALLBACK_URL]: "ftp://api.example.com" })
    ).toEqual([CALLBACK_URL]);
  });
});

describe("loadDocSyncEnvOrExit", () => {
  it("returns the env without exiting when it is valid", async () => {
    const exit = vi.fn();
    const flushLogs = vi.fn(() => Promise.resolve());

    await expect(
      loadDocSyncEnvOrExit(
        { ...PASSWORD_PG, [PORT]: "4050" },
        { exit, flushLogs }
      )
    ).resolves.toEqual({
      port: 4050,
      shutdownDeadlineMs: DEFAULT_DOC_SYNC_SHUTDOWN_DEADLINE_MS,
      pg: PASSWORD_PG_CONFIG,
      ...DEFAULT_AUTH,
    });
    expect(exit).not.toHaveBeenCalled();
    expect(flushLogs).not.toHaveBeenCalled();
  });

  it("logs doc_sync.env_invalid, then flushes, then exits 1", async () => {
    const order: string[] = [];
    const error = vi.spyOn(log, "error").mockImplementation(() => {
      order.push("log");
    });
    const flushLogs = vi.fn(() => {
      order.push("flush");
      return Promise.resolve();
    });
    const exit = vi.fn(() => {
      order.push("exit");
    });

    await expect(
      loadDocSyncEnvOrExit({ ...PASSWORD_PG, [PORT]: "0" }, { exit, flushLogs })
    ).resolves.toBeUndefined();

    expect(order).toEqual(["log", "flush", "exit"]);
    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        event: DOC_SYNC_ENV_INVALID_EVENT,
        fatal: true,
        issues: [expect.objectContaining({ key: PORT })],
      })
    );
  });
});
