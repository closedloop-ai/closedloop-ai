import path from "node:path";

/**
 * ISS-5983: the Prisma config the CLI loads when `prisma migrate deploy` is
 * spawned from an `apps/api` RUNTIME function instead of the `@repo/database`
 * build.
 *
 * Why a second config at all: Prisma 7 reads the datasource URL ONLY from a
 * config file (`prisma migrate deploy` fails with "The datasource.url property
 * is required in your Prisma config file" when given `DATABASE_URL` alone), and
 * it discovers that file from the process CWD. The build satisfies both by
 * running with CWD = `packages/database`, where `prisma.config.ts` lives.
 *
 * That TS config cannot be relied on inside a serverless bundle: loading it
 * pulls `dotenv`, `./keys` (→ `@t3-oss/env-nextjs` + full env validation) and
 * `./schema-utils` into a SPAWNED subprocess, none of which Next's file tracing
 * can see. This file is deliberately dependency-free and computes absolute
 * paths from its own location, so it works wherever the tracer places it.
 *
 * `datasource.url` is read from the environment because that is the contract
 * `migration-pipeline.ts` already uses: it spawns the CLI with `DATABASE_URL`
 * set to the freshly IAM-signed, schema-scoped connection string.
 */

const packageDir = path.resolve(import.meta.dirname, "..");

export default {
  schema: path.join(packageDir, "prisma", "schema.prisma"),
  migrations: {
    path: path.join(packageDir, "prisma", "migrations"),
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
};
