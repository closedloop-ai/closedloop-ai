import { missingIntegrationDependencies } from "./integration-env";

/**
 * Vitest global setup: a skipped integration suite is announced, never silent
 * (PLN-2104 Tests, CI dependency).
 */
export default function announceSkips(): void {
  const missing = missingIntegrationDependencies();
  if (missing.length === 0) {
    return;
  }
  const lines = missing.map(
    ({ dependency, key }) =>
      `  ${dependency}: ${key} is unset, so its suites are SKIPPED`
  );
  process.stderr.write(
    [
      "",
      "=".repeat(72),
      "apps/realtime integration: NOT RUN against real services",
      ...lines,
      "  The PR gate gets Redis and Postgres from ISS-11210 requirement 14.",
      "=".repeat(72),
      "",
    ].join("\n")
  );
}
