/**
 * Database Health Check (via API endpoint)
 *
 * Calls the deployed API's /health/db endpoint instead of connecting
 * directly to the database. This avoids needing the GitHub runner's
 * dynamic IP whitelisted in the RDS security group.
 */

import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

class AuthError extends Error {}
class MisconfiguredEndpointError extends Error {}

function parseSeconds(value, fallbackSeconds) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackSeconds;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function getResultSummary(result) {
  const connectivity = result?.checks?.connectivity?.status ?? "unknown";
  const migrations = result?.checks?.migrations?.status ?? "unknown";
  const tables = result?.checks?.tables?.count ?? "unknown";
  return { connectivity, migrations, tables };
}

export async function runDatabaseHealthCheck({
  healthUrl = process.env.DB_HEALTH_URL,
  healthToken = process.env.DB_HEALTH_TOKEN,
  outputPath = process.env.DB_STATUS_PATH || "db-status.json",
  maxWaitSeconds = parseSeconds(process.env.DB_HEALTH_MAX_WAIT_SECONDS, 90),
  pollIntervalSeconds = parseSeconds(process.env.DB_HEALTH_POLL_INTERVAL_SECONDS, 10),
  requestTimeoutMs = parseSeconds(process.env.DB_HEALTH_REQUEST_TIMEOUT_SECONDS, 30) * 1000,
  fetchImpl = fetch,
  writeFileImpl = writeFile,
  logger = console,
} = {}) {
  if (!healthUrl) {
    logger.log("DB_HEALTH_URL not set, skipping database health check");
    await writeFileImpl(
      outputPath,
      JSON.stringify({ skipped: true, reason: "DB_HEALTH_URL not set" })
    );
    return 0;
  }

  if (!healthToken) {
    logger.error("DB_HEALTH_TOKEN not set, cannot authenticate to database health endpoint");
    await writeFileImpl(
      outputPath,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        ok: false,
        error: "DB_HEALTH_TOKEN not set",
        checks: {
          connectivity: {
            status: "error",
            error: "db_health_token_missing",
          },
        },
      })
    );
    return 1;
  }

  logger.log("Checking database health...");
  logger.log(`Endpoint: ${healthUrl}`);
  logger.log(
    `Max wait: ${maxWaitSeconds}s, Poll interval: ${pollIntervalSeconds}s, Request timeout: ${Math.round(
      requestTimeoutMs / 1000
    )}s`
  );

  const deadline = Date.now() + maxWaitSeconds * 1000;
  const pollIntervalMs = pollIntervalSeconds * 1000;
  let attempt = 0;
  let lastError = null;
  let lastResult = null;

  while (Date.now() <= deadline) {
    attempt += 1;

    try {
      const response = await fetchImpl(healthUrl, {
        headers: {
          Authorization: `Bearer ${healthToken}`,
        },
        signal: AbortSignal.timeout(requestTimeoutMs),
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new AuthError(`Authentication failed with status ${response.status}`);
        }
        if (response.status === 503) {
          throw new MisconfiguredEndpointError(
            `Health endpoint misconfigured with status ${response.status}`
          );
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();
      if (!result || typeof result !== "object") {
        throw new Error("Health endpoint returned invalid JSON payload");
      }

      lastResult = result;
      await writeFileImpl(outputPath, JSON.stringify(result, null, 2));

      const summary = getResultSummary(result);
      logger.log("\n--- Summary ---");
      logger.log(`Connectivity: ${summary.connectivity}`);
      logger.log(`Migrations: ${summary.migrations}`);
      logger.log(`Tables: ${summary.tables}`);
      logger.log(`Overall: ${result.ok ? "✓ Healthy" : "✗ Issues detected"}`);

      if (result.ok) {
        return 0;
      }

      lastError = new Error("Health endpoint returned ok=false");
    } catch (error) {
      lastError = error;
      logger.error(
        `\n✗ Database health check attempt ${attempt} failed: ${getErrorMessage(error)}`
      );
      if (error instanceof AuthError || error instanceof MisconfiguredEndpointError) {
        break;
      }
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }

    logger.log(
      `Retrying in ${Math.min(pollIntervalMs, remainingMs) / 1000}s (time remaining: ${Math.ceil(
        remainingMs / 1000
      )}s)...`
    );
    await sleep(Math.min(pollIntervalMs, remainingMs));
  }

  const errorMessage = getErrorMessage(lastError || "Database health check timed out");
  const summary = lastResult
    ? {
        ...lastResult,
        ok: false,
        error: `Database health check did not become healthy before timeout (${maxWaitSeconds}s): ${errorMessage}`,
      }
    : {
        timestamp: new Date().toISOString(),
        ok: false,
        error: `Database health check failed after ${maxWaitSeconds}s: ${errorMessage}`,
        checks: {
          connectivity: {
            status: "error",
            error: "db_health_endpoint_unreachable",
          },
        },
      };

  await writeFileImpl(outputPath, JSON.stringify(summary, null, 2));
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await runDatabaseHealthCheck();
  process.exit(code);
}
