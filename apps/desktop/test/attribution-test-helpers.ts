/**
 * @file attribution-test-helpers.ts
 * @description Attribution-specific fixtures for the FEA-1459 attribution-accuracy
 * suites (split out under FEA-2235 D2): the Codex-rollout / raw-transcript writers,
 * the attribution constants, and an empty attribution cache. The generic
 * Claude-transcript writer and the fully-populated session builder are shared
 * collector-test fixtures and live in `normalized-session-test-utils.ts`
 * (`writeClaudeTranscript`, `makePopulatedSession`); import those from there.
 */
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { hermeticGitEnv } from "../scripts/hermetic-git-env.mjs";
import { GIT_FIXTURE_CHILD_TIMEOUT_MS } from "./helpers/git-fixture.js";

export const CODEX_UUID = "22222222-2222-4222-8222-222222222222";
export const LARGE_CACHE_READ_TOKENS = 2_192_635_647;

export function writeRollout(name: string, lines: unknown[]): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codex-rollout-"));
  const filePath = path.join(dir, name);
  writeFileSync(
    filePath,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    "utf8"
  );
  return filePath;
}

/** Write a transcript file (raw JSONL) for extractTranscriptTokens tests. */
export function writeTranscriptFile(lines: unknown[]): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "transcript-"));
  const filePath = path.join(dir, "transcript.jsonl");
  writeFileSync(
    filePath,
    `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
    "utf8"
  );
  return filePath;
}

export function emptyAttributionCache() {
  return {
    attributionByCwd: new Map(),
    launchMetadataRootByCwd: new Map(),
    repoFullNameByPath: new Map(),
  };
}

/**
 * Seed a real git repo at `dir` whose `origin` remote resolves to
 * `github.com:<orgRepo>`, so the live cwd→repositoryFullName resolver yields
 * `orgRepo`. Shared by the repo-attribution suites (FEA-4299) so the git command
 * setup and remote shape cannot drift between them.
 *
 * HERMETIC (ISS-5836): the operator's `~/.gitconfig` must not reach the fixture.
 * `git init` with no `-b` takes its branch name from global `init.defaultBranch`,
 * and a global `[url] insteadOf` rewrites the origin this seeds — both are repo
 * state these suites then assert against, decided by machine config rather than
 * by the fixture.
 */
export function initGitRepoWithOrigin(dir: string, orgRepo: string): void {
  // Bounded as well as hermetic: `execSync` blocks the worker for the child's
  // whole life, so a wedged git outlives node:test's per-test timer and is only
  // caught by the coarse whole-runner cap. See GIT_FIXTURE_CHILD_TIMEOUT_MS.
  const options = {
    cwd: dir,
    stdio: "pipe",
    env: hermeticGitEnv(),
    timeout: GIT_FIXTURE_CHILD_TIMEOUT_MS,
  } as const;
  execSync("git init -q", options);
  execSync(`git remote add origin git@github.com:${orgRepo}.git`, options);
}
