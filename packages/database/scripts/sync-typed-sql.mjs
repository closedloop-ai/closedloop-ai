/**
 * ISS-8554 — regenerate the TypedSQL modules and copy them somewhere Prisma
 * will not delete.
 *
 * WHY THIS EXISTS AT ALL. `prisma generate --sql` needs a live database to infer
 * each statement's parameter and result types, and turbo's `db:generate` — the
 * single producer of `generated/` — does not have one. So a clean build cannot
 * produce these modules, and the `sql` export would not resolve.
 *
 * WHY THE FILES ARE NOT SIMPLY COMMITTED WHERE PRISMA WRITES THEM. That was
 * tried first and does not hold: a PLAIN `prisma generate` EMPTIES
 * `generated/sql`. Both `db:generate` and the root postinstall run exactly that,
 * so an ordinary `pnpm install` would delete the tracked files, break the build,
 * and leave eight spurious deletions in the working tree. Measured, not
 * theorised — 7 files before, 0 after.
 *
 * So the committed copy lives at `packages/database/typed-sql/`, outside the
 * directory Prisma manages. Nothing regenerates it implicitly; this script is
 * the only writer, and `pnpm check:typed-sql-generated` fails CI when a `.sql`
 * statement changes without it being run.
 *
 * The copy is safe to relocate because the generated modules' only non-relative
 * import is `@prisma/client/runtime/client`, a package specifier that resolves
 * identically from anywhere in the workspace. The barrel's `./sql/*.ts` imports
 * stay correct because the pair is copied together, preserving their layout.
 *
 * Usage, from packages/database, with a database that has the current schema:
 *   DATABASE_URL=postgresql://... node scripts/sync-typed-sql.mjs
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dbRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatedBarrel = join(dbRoot, "generated", "sql.ts");
const generatedDir = join(dbRoot, "generated", "sql");
const committedRoot = join(dbRoot, "typed-sql");
const committedBarrel = join(committedRoot, "sql.ts");
const committedDir = join(committedRoot, "sql");

const skipGenerate = process.argv.includes("--copy-only");

if (!skipGenerate) {
  if (!process.env.DATABASE_URL) {
    process.stderr.write(
      "sync-typed-sql: DATABASE_URL is required — `prisma generate --sql` prepares\n" +
        "every statement against a real server to infer its types. Point it at a\n" +
        "database carrying the current schema, or pass --copy-only to copy an\n" +
        "already-generated output.\n"
    );
    process.exit(1);
  }
  execFileSync(
    "node",
    [
      join(dbRoot, "node_modules", "prisma", "build", "index.js"),
      "generate",
      "--sql",
      "--no-hints",
      "--schema=./prisma/schema.prisma",
    ],
    { cwd: dbRoot, stdio: "inherit" }
  );
}

if (!(existsSync(generatedBarrel) && existsSync(generatedDir))) {
  process.stderr.write(
    "sync-typed-sql: no generated SQL output to copy. Run without --copy-only,\n" +
      "or run `prisma generate --sql` first.\n"
  );
  process.exit(1);
}

// Replaced wholesale rather than merged, so a statement deleted from prisma/sql
// does not leave a stale module behind that still compiles and still exports.
rmSync(committedRoot, { recursive: true, force: true });
mkdirSync(committedDir, { recursive: true });
cpSync(generatedBarrel, committedBarrel);
cpSync(generatedDir, committedDir, { recursive: true });

// Prisma emits its own formatting (no semicolons, a trailing space after
// `@ts-nocheck`, one very long line per statement). Biome reformats all of it,
// and the repo's pre-commit hook runs Biome on staged files — so without this
// pass every `sync:typed-sql` dirties the tree with formatting the next commit
// silently reverts, and a reviewer sees a diff that is mostly whitespace. The
// files carry `biome-ignore-all lint`, which suppresses LINTING but not
// FORMATTING, so formatting them here is what makes the output stable.
//
// Non-fatal: a formatter that is missing or unhappy must not fail the sync. The
// modules are already correct and committable at this point; only their
// whitespace is at stake, and the pre-commit hook applies the same pass anyway.
try {
  execFileSync(
    "pnpm",
    [
      "exec",
      "biome",
      "check",
      "--write",
      "--no-errors-on-unmatched",
      committedRoot,
    ],
    { cwd: dbRoot, stdio: "pipe" }
  );
} catch {
  process.stderr.write(
    "sync-typed-sql: biome formatting pass failed; the modules are still valid,\n" +
      "but expect the pre-commit hook to reformat them.\n"
  );
}

const copied = readdirSync(committedDir).filter((name) => name.endsWith(".ts"));
process.stdout.write(
  `sync-typed-sql: copied ${copied.length} module(s) into packages/database/typed-sql/\n` +
    "Commit the result — it is the only copy a build can see.\n"
);
