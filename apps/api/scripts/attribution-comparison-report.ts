/**
 * ISS-12552: write the attribution rollout gate's
 * comparison report for the named organizations. Before reading anything
 * else it evaluates `attribution-evidence-policy` for each of them; the script
 * has no request user, so no caller's Dev Mode override applies.
 *
 * Usage:
 *   tsx scripts/attribution-comparison-report.ts --out <file.json> \
 *     --org <organization id> [--org <organization id>]... \
 *     [--allocation-limit <n>] [--receipts-since <ISO time>]
 *
 * Refuses to run unless `attribution-evidence-policy` is on for every named
 * organization (PRD-800 "Rollout").
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildAttributionComparisonReport } from "../app/agent-sessions/service/attribution/attribution-comparison";
import { assertAttributionEvidenceOnForOrganizations } from "./attribution-script-gate";

function values(name: string): string[] {
  return process.argv.flatMap((arg, index) =>
    arg === name && process.argv[index + 1]
      ? [process.argv[index + 1] ?? ""]
      : []
  );
}

function required(name: string): string {
  const [value] = values(name);
  if (!value) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

export async function main(): Promise<void> {
  const organizationIds = values("--org");
  await assertAttributionEvidenceOnForOrganizations(organizationIds);
  const [limit] = values("--allocation-limit");
  const [since] = values("--receipts-since");
  const report = await buildAttributionComparisonReport({
    ...(organizationIds.length > 0 ? { organizationIds } : {}),
    ...(limit === undefined ? {} : { allocationLimit: Number(limit) }),
    ...(since === undefined ? {} : { receiptsEpoch: new Date(since) }),
  });
  writeFileSync(required("--out"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report.global.links)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack : String(error)}\n`
    );
    process.exitCode = 1;
  });
}
