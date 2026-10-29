import { createServer } from "node:net";
import type { Server } from "@hocuspocus/server";
import { OIDC_CONFIG } from "@repo/http-service/test-support/oidc-fixture";
import { log } from "@repo/observability/log";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DOC_SYNC_SHUTDOWN_DEADLINE_MS } from "../env";
import { HealthPath } from "../http/health";
import { createDocSyncServer } from "../server";
import { pgDocumentStorage } from "../storage/document-storage";
import { PUBLIC_KEYS } from "./auth/test-tokens";
import { integrationPg } from "./integration/integration-env";
import { createTestSchema, type TestSchema } from "./integration/test-schema";

const UNREACHABLE_CONNECT_TIMEOUT_MS = 500;

let schema: TestSchema | undefined;
let started: { server: Server; shutdown: () => Promise<void> } | undefined;

async function healthStatus(
  pool: pg.Pool,
  probePool: pg.Pool = pool
): Promise<number> {
  started = createDocSyncServer(
    {
      port: 0,
      shutdownDeadlineMs: DEFAULT_DOC_SYNC_SHUTDOWN_DEADLINE_MS,
      tokenPublicKeys: PUBLIC_KEYS,
      allowedOrigins: [],
      internalOidc: OIDC_CONFIG,
    },
    pgDocumentStorage(pool, probePool),
    { flushLogs: () => Promise.resolve() }
  );
  await started.server.listen();
  const response = await fetch(
    `http://127.0.0.1:${started.server.address.port}${HealthPath.Health}`
  );
  return response.status;
}

/** A port nothing listens on: bound once, then released. */
function unusedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

describe.skipIf(!integrationPg)("GET /health against Postgres", () => {
  beforeEach(async () => {
    if (integrationPg) {
      schema = await createTestSchema(integrationPg);
    }
  });

  afterEach(async () => {
    await started?.shutdown();
    started = undefined;
    await schema?.drop();
    schema = undefined;
    vi.restoreAllMocks();
  });

  it("answers 200 while the document database answers", async () => {
    if (!schema) {
      throw new Error("no schema");
    }

    await expect(healthStatus(schema.connect())).resolves.toBe(200);
  });

  it("answers 200 while every store connection is checked out", async () => {
    if (!schema) {
      throw new Error("no schema");
    }
    const stores = schema.connect();
    const held = await Promise.all(
      Array.from({ length: stores.options.max }, () => stores.connect())
    );

    try {
      await expect(healthStatus(stores, schema.connect())).resolves.toBe(200);
    } finally {
      for (const client of held) {
        client.release();
      }
    }
  });

  it("answers 503 when the document database is unreachable", async () => {
    vi.spyOn(log, "error").mockImplementation(() => undefined);
    const unreachable = new pg.Pool({
      host: "127.0.0.1",
      port: await unusedPort(),
      user: "doc_sync",
      database: "doc_sync",
      connectionTimeoutMillis: UNREACHABLE_CONNECT_TIMEOUT_MS,
    });

    await expect(healthStatus(unreachable)).resolves.toBe(503);
  });
});
