/**
 * Shared parse of the shipped `scripts/migrate.ts`, for the guards that pin its
 * wiring (ISS-4601's completion line, ISS-4489's build-migrate kill-switch).
 *
 * `migrate.ts` cannot be imported to drive: it invokes `main()` at module scope
 * and terminates the process with `process.exit`, so loading it in a test would
 * kill the runner. Per AGENTS.md ("Test Practices") the sanctioned alternative
 * to a raw-text scan is parsing with `ts.createSourceFile` and asserting on the
 * resolved AST, which is what the callers do — so a comment naming a helper
 * cannot satisfy an assertion that the helper is called.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript6";

const MIGRATE_SCRIPT_PATH = fileURLToPath(
  new URL("../../scripts/migrate.ts", import.meta.url)
);

/** Parses the shipped migrate script with parent pointers set. */
export function parseMigrateScript(): ts.SourceFile {
  return ts.createSourceFile(
    MIGRATE_SCRIPT_PATH,
    readFileSync(MIGRATE_SCRIPT_PATH, "utf8"),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS
  );
}
