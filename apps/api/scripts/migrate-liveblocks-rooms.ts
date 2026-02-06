/**
 * Migration script to add tenantId to existing Liveblocks rooms.
 *
 * This script:
 * 1. Fetches all artifacts with documentSlugs from the database
 * 2. For each artifact, updates the corresponding Liveblocks room with tenantId
 * 3. Uses getOrCreateRoom to be idempotent (safe to re-run)
 *
 * Run with: tsx apps/api/scripts/migrate-liveblocks-rooms.ts
 */

import { Liveblocks } from "@liveblocks/node";
import { config } from "dotenv";

// Load environment variables from .env.local
config({ path: "apps/api/.env.local" });

async function migrateLiveblocksRooms() {
  console.log("Starting Liveblocks room migration...\n");

  // Get Liveblocks secret from environment
  const secret = process.env.LIVEBLOCKS_SECRET;
  if (!secret) {
    console.error("❌ LIVEBLOCKS_SECRET environment variable is not set");
    process.exit(1);
  }
  const liveblocks = new Liveblocks({ secret });

  // Validate database connection string exists
  if (!process.env.DATABASE_URL) {
    console.error("❌ DATABASE_URL environment variable is not set");
    process.exit(1);
  }

  // Dynamically import the generated Prisma client
  const { PrismaClient } = await import(
    "../../../packages/database/generated/client.js"
  );

  // Create Prisma client with adapter (required by generated client)
  // Use require for better compatibility with CJS modules
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pg = require("pg");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PrismaPg } = require("@prisma/adapter-pg");

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  try {
    // Test the connection
    await prisma.$connect();
    console.log("✅ Connected to database\n");

    // Fetch all artifacts with documentSlugs (PRDs, plans, issues)
    const artifacts = await prisma.artifact.findMany({
      where: {
        documentSlug: { not: null },
        isLatest: true, // Only process latest versions
      },
      select: {
        id: true,
        organizationId: true,
        documentSlug: true,
        type: true,
      },
    });

    console.log(`Found ${artifacts.length} artifacts with document slugs\n`);

    let successCount = 0;
    let errorCount = 0;
    const errors: Array<{ artifactId: string; error: string }> = [];

    for (const artifact of artifacts) {
      if (!artifact.documentSlug) {
        continue;
      }

      const roomId = `${artifact.organizationId}:artifact:${artifact.documentSlug}`;

      try {
        // Use getOrCreateRoom to update or create the room with tenantId
        await liveblocks.getOrCreateRoom(roomId, {
          defaultAccesses: [], // Private - require authentication
          tenantId: artifact.organizationId,
          metadata: {
            artifactId: artifact.id,
            artifactSubtype: artifact.subtype,
            documentSlug: artifact.documentSlug,
          },
        });

        successCount++;
        console.log(`✅ Migrated room: ${roomId}`);
      } catch (error) {
        errorCount++;
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        errors.push({ artifactId: artifact.id, error: errorMessage });
        console.error(`❌ Failed to migrate room ${roomId}: ${errorMessage}`);
      }
    }

    console.log(`\n${"=".repeat(60)}`);
    console.log("Migration complete!");
    console.log("=".repeat(60));
    console.log(`✅ Successfully migrated: ${successCount} rooms`);
    console.log(`❌ Failed: ${errorCount} rooms`);

    if (errors.length > 0) {
      console.log("\nErrors:");
      for (const { artifactId, error } of errors) {
        console.log(`  - Artifact ${artifactId}: ${error}`);
      }
      await prisma.$disconnect();
      process.exit(1);
    }

    console.log("\n🎉 All rooms successfully migrated!");
    console.log(
      "\n💡 Next step: Uncomment tenantId in packages/collaboration/auth.ts"
    );

    await prisma.$disconnect();
  } catch (error) {
    console.error("\n❌ Migration failed:", error);
    await prisma.$disconnect();
    process.exit(1);
  }
}

// Run migration
migrateLiveblocksRooms()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Unexpected error:", error);
    process.exit(1);
  });
