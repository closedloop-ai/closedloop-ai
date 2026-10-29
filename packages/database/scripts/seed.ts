#!/usr/bin/env node

/**
 * CLI entry point for the database seed script.
 *
 * Initializes a PrismaClient via DATABASE_URL, resolves an authenticated user
 * and their organization from the database, invokes runSeed(), logs a summary,
 * and disconnects the client. ISS-6804: all of that lives in
 * `./seed/program.ts` (`runSeedProgram`), which takes `argv`/`env` as arguments
 * and returns an exit code, so the `/preview-schemas/seed` route can run the
 * same program in-process; this file only binds it to the process.
 *
 * Usage:
 *   DATABASE_URL=<url> pnpm --filter=@repo/database seed
 *
 * Environment variables inspected at startup:
 *   DATABASE_URL      — required; the pg connection string. Seeding is
 *                       restricted to localhost targets by default. Set
 *                       SEED_ALLOW_REMOTE=1 to enable staging/preview runs;
 *                       production hostnames are always rejected regardless.
 *   SEED_ALLOW_REMOTE — set to "1" to allow non-localhost DATABASE_URL
 *                       (staging, preview). Production denylist still applies.
 *   SEED_RESET_ALLOW_REMOTE — set to "1" to allow destructive --reset against a
 *                          non-localhost DATABASE_URL. SEED_ALLOW_REMOTE alone
 *                          is NOT sufficient because --reset --force skips the
 *                          only interactive confirmation. Production denylist
 *                          still applies.
 *   SEED_FORCE_OVERWRITE — set to "1" to seed into a non-empty org (staging
 *                          restore). Risks clobbering existing integration rows.
 *   ALLOW_INSECURE_SSL — set to "1" to skip TLS certificate verification for
 *                        self-signed dev/RDS endpoints. Default: verify.
 *
 * Full production-guard tracking: FEA-1328.
 */

import { runSeedProgram } from "./seed/program";

runSeedProgram({ argv: process.argv.slice(2), env: process.env }).then(
  (result) => {
    process.exit(result.exitCode);
  }
);
