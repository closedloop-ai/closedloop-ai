/**
 * ISS-12435 (PRD-795) post-deploy cleanup. Dry run by default: it lists and
 * counts, and deletes only with `--apply`.
 *
 *   node --import tsx/esm \
 *     packages/collaboration/scripts/delete-retired-inbox-notifications.ts \
 *     --recipients <snapshot.json> [--apply]
 *
 * `LIVEBLOCKS_SECRET` must already be in the environment; load it without
 * putting it in shell history (`read -rs LIVEBLOCKS_SECRET`, then export it).
 * `<snapshot.json>` is a JSON array of `{ "userId", "organizationId" }`, taken
 * from `loops` before the data step empties it (the PR runbook has the query).
 * Prints one JSON report and exits non-zero when any recipient failed.
 */
import { readFileSync } from "node:fs";
import { Liveblocks } from "@liveblocks/node";
import {
  cleanupRetiredInboxNotifications,
  recipientsSchema,
} from "./retired-inbox-notification-cleanup";

const RECIPIENTS_FLAG = "--recipients";
const APPLY_FLAG = "--apply";

async function main(argv: readonly string[]): Promise<number> {
  const secret = process.env.LIVEBLOCKS_SECRET;
  if (!secret) {
    process.stderr.write("LIVEBLOCKS_SECRET is required.\n");
    return 2;
  }
  const recipientsPath = argv[argv.indexOf(RECIPIENTS_FLAG) + 1];
  if (!(argv.includes(RECIPIENTS_FLAG) && recipientsPath)) {
    process.stderr.write(`${RECIPIENTS_FLAG} <snapshot.json> is required.\n`);
    return 2;
  }
  const recipients = recipientsSchema.parse(
    JSON.parse(readFileSync(recipientsPath, "utf8"))
  );
  const report = await cleanupRetiredInboxNotifications({
    client: new Liveblocks({ secret }),
    recipients,
    apply: argv.includes(APPLY_FLAG),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.failures.length === 0 ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2));
