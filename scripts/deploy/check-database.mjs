/**
 * Database Health Check
 *
 * Verifies database connectivity and migration status after deploy.
 * Runs in parallel with Vercel deployment checks.
 */

const databaseUrl = process.env.DATABASE_URL;
const outputPath = process.env.DB_STATUS_PATH || "db-status.json";

import { writeFile } from "node:fs/promises";

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

// Dynamic import pg to handle environments where it's not installed
let pg;
try {
  pg = await import("pg");
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

const { Client } = pg.default || pg;
const client = new Client({ connectionString: databaseUrl });

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
  const result = await client.query("SELECT 1 as health_check");
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
    checks.migrations.total = Number.parseInt(total);
    checks.migrations.pending = Number.parseInt(pending);

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
  const tableCount = Number.parseInt(tableResult.rows[0].count);
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
