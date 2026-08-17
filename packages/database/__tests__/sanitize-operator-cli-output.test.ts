import { describe, expect, it } from "vitest";
import {
  PrismaMigrateDeployErrorCode,
  sanitizeOperatorCliOutput,
} from "../scripts/migrate-deploy-recovery";
import { makeDeployError } from "./test-helpers/deploy-error";

/*
 * ISS-6558 routed the failing Prisma CLI's own output into the ensure route's
 * 500 body and, through it, a GitHub Actions log. A connection failure names
 * its endpoint in PROSE — never as a `scheme://user:pass@host` URL and never as
 * a `PGHOST=` assignment — so the sanitizer's original patterns passed it
 * straight through (review: wongk). These cover each shape Prisma and libpq
 * actually emit, and each asserts BOTH halves of the contract: the endpoint is
 * gone AND the diagnosis is not, because a redaction that eats the error code
 * makes surfacing the output pointless.
 */
const ENDPOINT_HOST = "stage-db.cluster-c9v1.us-east-1.rds.amazonaws.com";
const ENDPOINT_PORT = "5432";
const REDACTION_MARKER = "[redacted sensitive value]";
const MIGRATION_NAME = "20260101000000_add_widget";
// No const object owns the connectivity codes: PrismaMigrateDeployErrorCode is
// deliberately the set `recoverMigrateDeployFailure` classifies on, and these
// are never classified — only reported.
const PRISMA_AUTH_FAILED_CODE = "P1000";
const PRISMA_UNREACHABLE_CODE = "P1001";
const PRISMA_REACHED_BUT_TIMED_OUT_CODE = "P1002";
const PRISMA_DATABASE_MISSING_CODE = "P1003";

function sanitizeStderr(stderr: string): string {
  return sanitizeOperatorCliOutput(makeDeployError({ stderr })) ?? "";
}

describe("sanitizeOperatorCliOutput endpoint redaction", () => {
  it.each([
    [
      PRISMA_UNREACHABLE_CODE,
      `Error: ${PRISMA_UNREACHABLE_CODE}: Can't reach database server at ${ENDPOINT_HOST}:${ENDPOINT_PORT}`,
      PRISMA_UNREACHABLE_CODE,
    ],
    [
      `${PRISMA_UNREACHABLE_CODE} (backtick-quoted host and port)`,
      `Error: ${PRISMA_UNREACHABLE_CODE}: Can't reach database server at \`${ENDPOINT_HOST}\`:\`${ENDPOINT_PORT}\`\n\nPlease make sure your database server is running at \`${ENDPOINT_HOST}\`:\`${ENDPOINT_PORT}\`.`,
      PRISMA_UNREACHABLE_CODE,
    ],
    [
      PRISMA_REACHED_BUT_TIMED_OUT_CODE,
      `Error: ${PRISMA_REACHED_BUT_TIMED_OUT_CODE}: The database server at \`${ENDPOINT_HOST}:${ENDPOINT_PORT}\` was reached but timed out.`,
      PRISMA_REACHED_BUT_TIMED_OUT_CODE,
    ],
    [
      PRISMA_DATABASE_MISSING_CODE,
      `Error: ${PRISMA_DATABASE_MISSING_CODE}: Database \`closedloop.public\` does not exist on the database server at \`${ENDPOINT_HOST}:${ENDPOINT_PORT}\`.`,
      PRISMA_DATABASE_MISSING_CODE,
    ],
    [
      `${PRISMA_AUTH_FAILED_CODE} (host with no port)`,
      `Error: ${PRISMA_AUTH_FAILED_CODE}: Authentication failed against database server at \`${ENDPOINT_HOST}\`, the provided database credentials for \`vercel_iam\` are not valid.`,
      PRISMA_AUTH_FAILED_CODE,
    ],
    [
      "a libpq connection failure nested in a Database error",
      `Error: ${PrismaMigrateDeployErrorCode.UserDefinedInvariant}\nDatabase error:\nERROR: connection to server at "${ENDPOINT_HOST}" port ${ENDPOINT_PORT} failed`,
      PrismaMigrateDeployErrorCode.UserDefinedInvariant,
    ],
  ])("redacts the endpoint %s reports, keeping the code", (_shape, stderr, code) => {
    const sanitized = sanitizeStderr(stderr);

    expect(sanitized).not.toContain(ENDPOINT_HOST);
    expect(sanitized).toContain(REDACTION_MARKER);
    // The code is the diagnosis. Redaction, never erasure.
    expect(sanitized).toContain(code);
  });

  it("leaves diagnostic text that merely follows the word `at` alone", () => {
    // The reason the pattern anchors on `server at` rather than sweeping every
    // host:port-shaped token: both of these carry the diagnosis, and a blanket
    // sweep eats them.
    const sanitized = sanitizeStderr(
      `Error: ${PrismaMigrateDeployErrorCode.MigrationFailedToApply}\nMigration name: ${MIGRATION_NAME}\nDatabase error:\nERROR: syntax error at or near "SELCT"\n  at schema.prisma:12`
    );

    expect(sanitized).toContain(MIGRATION_NAME);
    expect(sanitized).toContain('at or near "SELCT"');
    expect(sanitized).toContain("schema.prisma:12");
    expect(sanitized).not.toContain(REDACTION_MARKER);
  });
});

/*
 * The bound is a front slice of `stderr` then `stdout` joined, and the two
 * streams SPLIT the diagnosis: migration-pipeline-prisma-cli.test.ts pins a real
 * run writing `Error: P3009` to stderr while the migration name arrives on
 * stdout as `Applying migration 20260101_add`. Enough stderr therefore dropped
 * stdout — and the migration name with it — entirely (review: wongk).
 */
describe("sanitizeOperatorCliOutput diagnosis extraction", () => {
  const NOISY_STDERR = `Error: ${PrismaMigrateDeployErrorCode.FailedMigration}\n${"connection pool advisory notice ".repeat(30)}`;

  it("keeps the migration name that arrives on stdout past the bound", () => {
    const captured = sanitizeOperatorCliOutput(
      makeDeployError({
        stderr: NOISY_STDERR,
        stdout: `Applying migration ${MIGRATION_NAME}\n`,
      })
    );

    expect(captured).toContain(MIGRATION_NAME);
    expect(captured).toContain(PrismaMigrateDeployErrorCode.FailedMigration);
    // Still BOUNDED — the fix extracts the diagnosis, it does not stop bounding.
    expect(captured?.length).toBeLessThan(NOISY_STDERR.length);
  });

  it("sanitizes the diagnosis lines it appends past the bound", () => {
    // Sanitize-before-bound has to hold for the appended lines too, or the fix
    // for the truncation would reopen the leak the endpoint pattern just closed.
    const captured = sanitizeOperatorCliOutput(
      makeDeployError({
        stderr: NOISY_STDERR,
        stdout: `Error: ${PRISMA_UNREACHABLE_CODE}: Can't reach database server at ${ENDPOINT_HOST}:${ENDPOINT_PORT}\n`,
      })
    );

    expect(captured).toContain(PRISMA_UNREACHABLE_CODE);
    expect(captured).not.toContain(ENDPOINT_HOST);
    expect(captured).toContain(REDACTION_MARKER);
  });
});
