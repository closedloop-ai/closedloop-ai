/**
 * ISS-12552: run the historical attribution backfill.
 * Resumes this policy and extractor version pair's unfinished run, if any.
 *
 * Usage:
 *   tsx scripts/attribution-backfill.ts --org <organization id> \
 *     [--page-size <n>] [--max-pages <n>]
 *
 * `--max-pages` stops early, leaving the run resumable; omit it to finish.
 * Refuses to run for an organization `attribution-evidence-policy` is off for
 * (PRD-800 "Rollout").
 */
import { fileURLToPath } from "node:url";
import { runAttributionBackfill } from "../app/agent-sessions/service/attribution/attribution-backfill";
import { assertAttributionEvidenceOnForOrganizations } from "./attribution-script-gate";

function numberFlag(name: string): number | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = Number(process.argv[index + 1]);
  if (!(Number.isSafeInteger(value) && value > 0)) {
    throw new Error(`${name} requires a positive integer`);
  }
  return value;
}

function stringFlag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = process.argv[index + 1];
  if (!value) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

export async function main(): Promise<void> {
  const organizationId = stringFlag("--org");
  await assertAttributionEvidenceOnForOrganizations(
    organizationId ? [organizationId] : []
  );
  const outcome = await runAttributionBackfill({
    pageSize: numberFlag("--page-size"),
    maxPages: numberFlag("--max-pages"),
    organizationId,
  });
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack : String(error)}\n`
    );
    process.exitCode = 1;
  });
}
