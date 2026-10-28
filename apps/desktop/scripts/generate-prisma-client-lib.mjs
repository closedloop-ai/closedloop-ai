// @ts-check

/**
 * ISS-5303 — the testable half of `generate-prisma-client.mjs`.
 *
 * The entrypoint is a shell: it resolves the desktop paths from
 * `import.meta.url` and runs `pnpm exec prisma generate`. The two decisions that
 * make the skip safe — what the inputs hash to, and whether the previously
 * generated client still matches that hash — live here.
 *
 * This module is import-safe: no subprocess, no path derivation and no
 * filesystem access at module scope. Every path it touches is injected.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Every module `prisma generate` must leave behind, relative to the generated
 * client directory. POSIX-separated, as they appear in imports.
 *
 * Lives here rather than in the entrypoint because two callers need it and a
 * second copy would drift: `generate-prisma-client.mjs` uses it to decide
 * whether the previous client can be reused, and `assert-test-prereqs-lib.mjs`
 * uses it as the `db:generate` half of the `test:node` entry gate. Before
 * ISS-8326's review, that gate named `client.ts` alone — so a generation
 * interrupted after `client.ts` but before `internal/class.ts` satisfied the
 * gate and then failed at collection anyway, which is the exact failure the
 * gate exists to replace.
 *
 * @type {ReadonlyArray<string>}
 */
export const GENERATED_CLIENT_OUTPUTS = [
  "client.ts",
  "browser.ts",
  "internal/class.ts",
  "internal/prismaNamespace.ts",
];

/**
 * Hash the generator's inputs into a single fingerprint.
 *
 * Both the repo-relative PATH and the BYTES of every input are folded in, so
 * renaming an input is as much a change as editing one. `repoRoot` anchors the
 * relative paths, keeping the fingerprint stable across checkout locations
 * (a worktree, a CI runner, `/tmp`) that would otherwise all hash differently.
 *
 * @param {readonly string[]} filePaths
 * @param {string} repoRoot
 * @returns {string}
 */
export function inputFingerprint(filePaths, repoRoot) {
  const hash = createHash("sha256");

  for (const filePath of filePaths) {
    hash.update(path.relative(repoRoot, filePath));
    hash.update("\0");
    hash.update(readFileSync(filePath));
    hash.update("\0");
  }

  return hash.digest("hex");
}

/**
 * Decide whether the already-generated client can be reused.
 *
 * Fail-closed on every uncertainty: a missing fingerprint file, a fingerprint
 * that does not match, or ANY required output missing all mean "regenerate".
 * The output check is what stops a half-written or hand-deleted client from
 * being certified fresh purely because the fingerprint file survived.
 *
 * @param {{
 *   fingerprintFile: string;
 *   generatedDir: string;
 *   requiredOutputs: readonly string[];
 *   fingerprintValue: string;
 * }} io
 * @returns {boolean}
 */
export function isGeneratedClientFresh({
  fingerprintFile,
  generatedDir,
  requiredOutputs,
  fingerprintValue,
}) {
  if (!existsSync(fingerprintFile)) {
    return false;
  }

  if (readFileSync(fingerprintFile, "utf8").trim() !== fingerprintValue) {
    return false;
  }

  return requiredOutputs.every((relativePath) =>
    existsSync(path.join(generatedDir, relativePath))
  );
}
