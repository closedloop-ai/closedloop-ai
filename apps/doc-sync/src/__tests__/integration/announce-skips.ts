import { integrationPg, MISSING_PG_KEYS } from "./integration-env";

/** Vitest global setup: a skipped integration suite is announced, never silent. */
export default function announceSkips(): void {
  if (integrationPg) {
    return;
  }
  process.stderr.write(
    [
      "",
      "=".repeat(72),
      "apps/doc-sync integration: NOT RUN against a real Postgres",
      `  Postgres: ${MISSING_PG_KEYS} is unset, so its suites are SKIPPED`,
      "  On a PR batch, pr-test.yml's doc-sync-integration-tests job sets them.",
      "=".repeat(72),
      "",
    ].join("\n")
  );
}
