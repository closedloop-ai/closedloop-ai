import assert from "node:assert/strict";
import test from "node:test";

import { runDatabaseHealthCheck } from "./check-database.mjs";

function makeLogger() {
  return {
    log: () => {},
    error: () => {},
  };
}

test("runDatabaseHealthCheck succeeds when endpoint is healthy", async () => {
  const writes = [];
  let attempts = 0;
  let authHeader = null;

  const code = await runDatabaseHealthCheck({
    healthUrl: "https://api.example.com/health/db",
    healthToken: "top-secret-token",
    outputPath: "ignored.json",
    maxWaitSeconds: 1,
    pollIntervalSeconds: 0,
    requestTimeoutMs: 100,
    logger: makeLogger(),
    fetchImpl: async (_url, init) => {
      attempts += 1;
      authHeader = init?.headers?.Authorization ?? init?.headers?.authorization ?? null;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          ok: true,
          checks: {
            connectivity: { status: "ok" },
            migrations: { status: "ok" },
            tables: { status: "ok", count: 12 },
          },
        }),
      };
    },
    writeFileImpl: async (_path, content) => {
      writes.push(JSON.parse(content));
    },
  });

  assert.equal(code, 0);
  assert.equal(attempts, 1);
  assert.equal(authHeader, "Bearer top-secret-token");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].ok, true);
});

test("runDatabaseHealthCheck retries transient failures and then succeeds", async () => {
  const writes = [];
  let attempts = 0;

  const code = await runDatabaseHealthCheck({
    healthUrl: "https://api.example.com/health/db",
    healthToken: "top-secret-token",
    outputPath: "ignored.json",
    maxWaitSeconds: 2,
    pollIntervalSeconds: 0,
    requestTimeoutMs: 100,
    logger: makeLogger(),
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("ECONNRESET");
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          ok: true,
          checks: {
            connectivity: { status: "ok" },
            migrations: { status: "ok" },
            tables: { status: "ok", count: 9 },
          },
        }),
      };
    },
    writeFileImpl: async (_path, content) => {
      writes.push(JSON.parse(content));
    },
  });

  assert.equal(code, 0);
  assert.equal(attempts, 2);
  assert.equal(writes.at(-1).ok, true);
});

test("runDatabaseHealthCheck fails when endpoint stays unhealthy", async () => {
  const writes = [];

  const code = await runDatabaseHealthCheck({
    healthUrl: "https://api.example.com/health/db",
    healthToken: "top-secret-token",
    outputPath: "ignored.json",
    maxWaitSeconds: 0.01,
    pollIntervalSeconds: 0,
    requestTimeoutMs: 100,
    logger: makeLogger(),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        ok: false,
        checks: {
          connectivity: { status: "ok" },
          migrations: { status: "error", error: "pending migrations" },
          tables: { status: "ok", count: 9 },
        },
      }),
    }),
    writeFileImpl: async (_path, content) => {
      writes.push(JSON.parse(content));
    },
  });

  assert.equal(code, 1);
  assert.equal(writes.length >= 1, true);
  assert.equal(writes.at(-1).ok, false);
  assert.match(writes.at(-1).error, /did not become healthy within/);
});

test("runDatabaseHealthCheck fails immediately when token is missing", async () => {
  const writes = [];
  let attempts = 0;

  const code = await runDatabaseHealthCheck({
    healthUrl: "https://api.example.com/health/db",
    healthToken: "",
    outputPath: "ignored.json",
    logger: makeLogger(),
    fetchImpl: async () => {
      attempts += 1;
      return { ok: true, status: 200, statusText: "OK", json: async () => ({ ok: true }) };
    },
    writeFileImpl: async (_path, content) => {
      writes.push(JSON.parse(content));
    },
  });

  assert.equal(code, 1);
  assert.equal(attempts, 0);
  assert.equal(writes.at(-1).error, "DB_HEALTH_TOKEN not set");
});

test("runDatabaseHealthCheck does not retry authentication failures", async () => {
  let attempts = 0;

  const code = await runDatabaseHealthCheck({
    healthUrl: "https://api.example.com/health/db",
    healthToken: "wrong-token",
    outputPath: "ignored.json",
    maxWaitSeconds: 2,
    pollIntervalSeconds: 0,
    logger: makeLogger(),
    fetchImpl: async () => {
      attempts += 1;
      return {
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        json: async () => ({ ok: false, error: "unauthorized" }),
      };
    },
    writeFileImpl: async () => {},
  });

  assert.equal(code, 1);
  assert.equal(attempts, 1);
});

test("runDatabaseHealthCheck does not retry 503 endpoint misconfiguration", async () => {
  let attempts = 0;

  const code = await runDatabaseHealthCheck({
    healthUrl: "https://api.example.com/health/db",
    healthToken: "correct-token",
    outputPath: "ignored.json",
    maxWaitSeconds: 2,
    pollIntervalSeconds: 0,
    logger: makeLogger(),
    fetchImpl: async () => {
      attempts += 1;
      return {
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        json: async () => ({ ok: false, error: "service_unavailable" }),
      };
    },
    writeFileImpl: async () => {},
  });

  assert.equal(code, 1);
  assert.equal(attempts, 1);
});

test("runDatabaseHealthCheck retries 503 unhealthy payloads with checks", async () => {
  let attempts = 0;

  const code = await runDatabaseHealthCheck({
    healthUrl: "https://api.example.com/health/db",
    healthToken: "correct-token",
    outputPath: "ignored.json",
    maxWaitSeconds: 2,
    pollIntervalSeconds: 0,
    logger: makeLogger(),
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) {
        return {
          ok: false,
          status: 503,
          statusText: "Service Unavailable",
          json: async () => ({
            ok: false,
            checks: {
              connectivity: { status: "error", error: "db_connectivity_check_failed" },
              migrations: { status: "error", error: "not_run" },
              tables: { status: "error", error: "not_run" },
            },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          ok: true,
          checks: {
            connectivity: { status: "ok" },
            migrations: { status: "ok" },
            tables: { status: "ok", count: 12 },
          },
        }),
      };
    },
    writeFileImpl: async () => {},
  });

  assert.equal(code, 0);
  assert.equal(attempts, 2);
});
