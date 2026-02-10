/**
 * Database Health Check
 *
 * Verifies database connectivity and migration status after deploy.
 * Runs in parallel with Vercel deployment checks.
 */

const databaseUrl = process.env.DATABASE_URL;
const outputPath = process.env.DB_STATUS_PATH || "db-status.json";

import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

if (!databaseUrl) {
  console.log("DATABASE_URL not set, skipping database health check");
  await writeFile(
    outputPath,
    JSON.stringify({ skipped: true, reason: "DATABASE_URL not set" })
  );
  process.exit(0);
}

// Parse connection string to get host for display (hide password)
function sanitizeUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.password = "***";
    return parsed.toString();
  } catch {
    return "[invalid url]";
  }
}

console.log("Checking database health...");
console.log(`Connection: ${sanitizeUrl(databaseUrl)}`);

const checks = {
  connectivity: { status: "pending", latencyMs: null, error: null },
  migrations: { status: "pending", pending: null, error: null },
};

// Load pg via CommonJS resolution so NODE_PATH can be honored in CI
let pg;
try {
  const require = createRequire(import.meta.url);
  pg = require("pg");
} catch {
  console.log("pg module not available, skipping database checks");
  await writeFile(
    outputPath,
    JSON.stringify({
      skipped: true,
      reason: "pg module not installed in CI environment",
    })
  );
  process.exit(0);
}

const { Client } = pg;

const sslRejectUnauthorizedEnv = process.env.DB_SSL_REJECT_UNAUTHORIZED;
const sslRejectUnauthorized =
  sslRejectUnauthorizedEnv == null || sslRejectUnauthorizedEnv === ""
    ? true
    : sslRejectUnauthorizedEnv.toLowerCase() !== "false";

let sslCa;
let sslCaSource;
const sslCaCandidates = [
  process.env.DB_SSL_CA_B64 ? "DB_SSL_CA_B64" : null,
  process.env.DB_SSL_CA_PATH ? "DB_SSL_CA_PATH" : null,
  process.env.PGSSLROOTCERT ? "PGSSLROOTCERT" : null,
].filter(Boolean);
if (sslCaCandidates.length > 1) {
  console.warn(
    `Multiple DB SSL CA sources set (${sslCaCandidates.join(
      ", "
    )}); using highest-precedence value.`
  );
}
try {
  if (process.env.DB_SSL_CA_B64) {
    sslCa = Buffer.from(process.env.DB_SSL_CA_B64, "base64").toString("utf8");
    sslCaSource = "DB_SSL_CA_B64";
  } else if (process.env.DB_SSL_CA_PATH) {
    sslCa = await readFile(process.env.DB_SSL_CA_PATH, "utf8");
    sslCaSource = `DB_SSL_CA_PATH (${process.env.DB_SSL_CA_PATH})`;
  } else if (process.env.PGSSLROOTCERT) {
    sslCa = await readFile(process.env.PGSSLROOTCERT, "utf8");
    sslCaSource = `PGSSLROOTCERT (${process.env.PGSSLROOTCERT})`;
  }
} catch (error) {
  console.error(`Failed to load DB SSL CA from ${sslCaSource || "env"}`); 
  console.error(error?.message || error);
  process.exit(1);
}

if (!sslRejectUnauthorized) {
  console.log("Database SSL: rejectUnauthorized=false (NOT recommended)");
} else if (sslCa) {
  console.log(`Database SSL: custom CA provided (${sslCaSource})`);
}

// Strip sslmode from the URL so the pg connection-string parser doesn't
// override our explicit ssl config (pg now treats sslmode=require as verify-full).
// We preserve the original sslmode to ensure SSL stays enabled.
const parsedUrl = new URL(databaseUrl);
const originalSslMode = parsedUrl.searchParams.get("sslmode");
parsedUrl.searchParams.delete("sslmode");

const clientConfig = { connectionString: parsedUrl.toString() };
if (originalSslMode || sslCa || !sslRejectUnauthorized) {
  clientConfig.ssl = { rejectUnauthorized: sslRejectUnauthorized };
  if (sslCa) {
    clientConfig.ssl.ca = sslCa;
  }
}

const client = new Client(clientConfig);

try {
  // Check 1: Connectivity
  console.log("\n1. Testing connectivity...");
  const connectStart = Date.now();
  await client.connect();
  checks.connectivity.latencyMs = Date.now() - connectStart;
  checks.connectivity.status = "ok";
  console.log(`   ✓ Connected in ${checks.connectivity.latencyMs}ms`);

  // Check 2: Basic query
  console.log("\n2. Running basic query...");
  const queryStart = Date.now();
  await client.query("SELECT 1 as health_check");
  const queryLatency = Date.now() - queryStart;
  console.log(`   ✓ Query successful in ${queryLatency}ms`);

  // Check 3: Migration status (if _prisma_migrations table exists)
  console.log("\n3. Checking migration status...");
  try {
    const migrationResult = await client.query(`
      SELECT COUNT(*) as total,
             COUNT(*) FILTER (WHERE finished_at IS NULL) as pending
      FROM _prisma_migrations
    `);
    const { total, pending } = migrationResult.rows[0];
    checks.migrations.total = Number.parseInt(total, 10);
    checks.migrations.pending = Number.parseInt(pending, 10);

    if (pending > 0) {
      checks.migrations.status = "error";
      checks.migrations.error = `${pending} pending migration(s) out of ${total}`;
    } else {
      checks.migrations.status = "ok";
    }

    if (pending > 0) {
      console.log(`   ✗ ${pending} pending migration(s) out of ${total}`);
    } else {
      console.log(`   ✓ All ${total} migrations applied`);
    }
  } catch (migrationError) {
    // Table might not exist if this is first deploy
    if (migrationError.message.includes("does not exist")) {
      checks.migrations.status = "ok";
      checks.migrations.note = "No migrations table (might be first deploy)";
      console.log("   ✓ No migrations table found (OK for first deploy)");
    } else {
      checks.migrations.status = "error";
      checks.migrations.error = migrationError.message;
      console.log(`   ✗ Error checking migrations: ${migrationError.message}`);
    }
  }

  // Check 4: Table count (sanity check)
  console.log("\n4. Counting tables...");
  const tableResult = await client.query(`
    SELECT COUNT(*) as count
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `);
  const tableCount = Number.parseInt(tableResult.rows[0].count, 10);
  console.log(`   ✓ Found ${tableCount} tables in public schema`);
} catch (error) {
  console.error(`\n✗ Database check failed: ${error.message}`);
  checks.connectivity.status = "error";
  checks.connectivity.error = error.message;
} finally {
  try {
    await client.end();
  } catch {
    // Ignore close errors
  }
}

const summary = {
  timestamp: new Date().toISOString(),
  ok: checks.connectivity.status === "ok" && checks.migrations.status === "ok",
  checks,
};

await writeFile(outputPath, JSON.stringify(summary, null, 2));

console.log("\n--- Summary ---");
console.log(`Connectivity: ${checks.connectivity.status}`);
console.log(`Migrations: ${checks.migrations.status}`);
console.log(`Overall: ${summary.ok ? "✓ Healthy" : "✗ Issues detected"}`);

if (!summary.ok) {
  process.exit(1);
}
