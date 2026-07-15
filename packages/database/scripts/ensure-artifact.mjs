import { spawnSync } from "node:child_process";

// Shared no-op/build guard for the database package's `ensure-*` scripts.
//
// Runs `command args` (inheriting stdio) and exits with the child's status,
// but ONLY when `isFresh()` returns false. When the artifact is already fresh
// this is a NO-OP (exit 0) — the property that keeps concurrent turbo tasks
// from racing to regenerate a shared artifact (see ensure-prisma-client.mjs).
//
// `isFresh` is a predicate so each caller can define "fresh" however it needs
// (a bare existence check for loops-api's dist/, an existence-plus-mtime check
// for the Prisma client) while the exit-code/no-op mechanics live in one place.
export function ensureArtifact({
  isFresh,
  command,
  args,
  cwd,
  missingMessage,
}) {
  if (isFresh()) {
    process.exit(0);
  }
  if (missingMessage) {
    console.log(missingMessage);
  }
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  process.exit(result.status ?? 1);
}
