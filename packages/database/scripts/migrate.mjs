#!/usr/bin/env node
/**
 * Runs Prisma migrations using IAM authentication.
 * This script generates an IAM token and runs prisma db push with it.
 */

import { execSync } from "node:child_process";
import { Signer } from "@aws-sdk/rds-signer";
import { awsCredentialsProvider } from "@vercel/functions/oidc";

async function main() {
  const {
    AWS_ROLE_ARN,
    AWS_REGION,
    PGHOST,
    PGUSER,
    PGDATABASE,
    PGPORT = "5432",
    DATABASE_URL,
  } = process.env;

  // If DATABASE_URL is set (e.g., local dev with password), use it directly
  if (DATABASE_URL) {
    console.log(
      "✓ DATABASE_URL found, running migrations with password auth..."
    );
    execSync("prisma format && prisma db push --accept-data-loss", {
      stdio: "inherit",
    });
    return;
  }

  // Otherwise, use IAM authentication
  if (!(AWS_ROLE_ARN && AWS_REGION && PGHOST && PGUSER && PGDATABASE)) {
    console.log("⚠️  Database credentials not configured - skipping migrations");
    console.log("   Required: DATABASE_URL (with password) OR");
    console.log(
      "   AWS_ROLE_ARN, AWS_REGION, PGHOST, PGUSER, PGDATABASE (for IAM auth)"
    );
    process.exit(0);
  }

  console.log("🔐 Generating IAM authentication token...");

  try {
    const signer = new Signer({
      hostname: PGHOST,
      port: Number(PGPORT),
      username: PGUSER,
      region: AWS_REGION,
      credentials: awsCredentialsProvider({
        roleArn: AWS_ROLE_ARN,
        clientConfig: { region: AWS_REGION },
      }),
    });

    const token = await signer.getAuthToken();

    // Construct DATABASE_URL with IAM token
    const databaseUrl = `postgresql://${PGUSER}:${encodeURIComponent(token)}@${PGHOST}:${PGPORT}/${PGDATABASE}?sslmode=require`;

    console.log("✓ Token generated, running migrations...");

    execSync("prisma format && prisma db push --accept-data-loss", {
      stdio: "inherit",
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
      },
    });

    console.log("✓ Migrations completed successfully");
  } catch (error) {
    console.error("❌ Migration failed:", error.message);
    process.exit(1);
  }
}

main();
