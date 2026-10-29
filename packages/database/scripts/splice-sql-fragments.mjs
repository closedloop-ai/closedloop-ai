/**
 * ISS-8554 — expand the shared facet fragments into the TypedSQL statements.
 *
 * THE WRITE PATH. `pnpm run sync:typed-sql` runs this before generating, so the
 * committed `.sql` files carry the expanded predicate a reviewer and Prisma both
 * read directly. The matching CHECK is `scripts/lint/check-typed-sql-fragments.ts`;
 * both import `splice-sql-fragments-core.mjs`, so there is one expansion
 * implementation and the writer cannot drift from the guard.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertFacetCountPairing,
  expand,
  OPEN,
  sqlDir,
} from "./splice-sql-fragments-core.mjs";

let expandedCount = 0;
for (const name of readdirSync(sqlDir).filter((file) =>
  file.endsWith(".sql")
)) {
  const path = join(sqlDir, name);
  const current = readFileSync(path, "utf8");
  if (!current.split("\n").some((line) => OPEN.test(line))) {
    continue;
  }
  const next = expand(current, `prisma/sql/${name}`);
  if (next !== current) {
    writeFileSync(path, next);
  }
  expandedCount += 1;
}

const pairingProblems = assertFacetCountPairing();
if (pairingProblems.length > 0) {
  process.stderr.write(
    "splice-sql-fragments: sessionFacetCounts.sql and facet-dimensions.sql\n" +
      "disagree about which parameter carries which dimension:\n" +
      pairingProblems.map((problem) => `  ${problem}\n`).join("")
  );
  process.exit(1);
}

process.stdout.write(
  `splice-sql-fragments: expanded fragments into ${expandedCount} statement(s).\n`
);
