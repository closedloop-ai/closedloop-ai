import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareAuditWorkspace } from "../src/passes/audit-workspace.js";
import {
  GIT_SPAWN_TEST_TIMEOUT_MS,
  HERMETIC_GIT_ENV,
  runGitFixture,
} from "./helpers/git-fixture.js";

const FIXTURE_IDENTITY_ENV = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
} as const;

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "audit-ws-git-"));
  const git = (args: string[]) =>
    runGitFixture(dir, args, { env: { ...FIXTURE_IDENTITY_ENV } });
  git(["init", "-q"]);
  writeFileSync(join(dir, "README.md"), "original\n", "utf8");
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);
  return dir;
}

describe("prepareAuditWorkspace", () => {
  it(
    "git repo → detached worktree that isolates writes from the operator tree",
    async () => {
      const repoDir = makeGitRepo();
      // Hermetic here too, not just for the fixture's own commits: the git
      // spawns this drives (`worktree add --detach`, `worktree remove`,
      // `worktree prune`) run the `post-checkout` hook, so an operator with a
      // global `core.hooksPath` would execute a machine-local hook inside the
      // test and re-pay the ISS-5403 latency this suite is fixing.
      const ws = await prepareAuditWorkspace(repoDir, { ...HERMETIC_GIT_ENV });
      try {
        expect(ws.isGitWorktree).toBe(true);
        expect(ws.dir).not.toBe(repoDir);
        // The copy carries the committed file…
        expect(readFileSync(join(ws.dir, "README.md"), "utf8")).toBe(
          "original\n"
        );
        // …and a write in the copy must NOT touch the operator's working tree.
        writeFileSync(join(ws.dir, "MALICIOUS.txt"), "pwned\n", "utf8");
        writeFileSync(join(ws.dir, "README.md"), "tampered\n", "utf8");
        expect(existsSync(join(repoDir, "MALICIOUS.txt"))).toBe(false);
        expect(readFileSync(join(repoDir, "README.md"), "utf8")).toBe(
          "original\n"
        );
      } finally {
        await ws.dispose();
      }
      // Disposed: the throwaway copy is gone.
      expect(existsSync(ws.dir)).toBe(false);
    },
    GIT_SPAWN_TEST_TIMEOUT_MS
  );

  it(
    "non-git dir → fs copy that isolates writes from the source",
    async () => {
      const repoDir = mkdtempSync(join(tmpdir(), "audit-ws-plain-"));
      writeFileSync(join(repoDir, "doc.md"), "source\n", "utf8");
      const ws = await prepareAuditWorkspace(repoDir, { ...HERMETIC_GIT_ENV });
      try {
        expect(ws.isGitWorktree).toBe(false);
        expect(ws.dir).not.toBe(repoDir);
        expect(readFileSync(join(ws.dir, "doc.md"), "utf8")).toBe("source\n");
        writeFileSync(join(ws.dir, "doc.md"), "tampered\n", "utf8");
        expect(readFileSync(join(repoDir, "doc.md"), "utf8")).toBe("source\n");
      } finally {
        await ws.dispose();
      }
      expect(existsSync(ws.dir)).toBe(false);
    },
    GIT_SPAWN_TEST_TIMEOUT_MS
  );

  it(
    "prepares a git repo with NO env override, inheriting the caller's environment",
    async () => {
      // `env` is a required parameter whose type merely admits `undefined`, and the
      // two branches build the child environment differently. The undefined arm is
      // what every production caller in `cli.ts` actually takes
      // (`prepareAuditWorkspace(config.repoDir, undefined)`), so it needs coverage
      // as much as the hermetic one the rest of this suite uses.
      const repoDir = makeGitRepo();
      const ws = await prepareAuditWorkspace(repoDir, undefined);
      try {
        expect(ws.isGitWorktree).toBe(true);
        expect(readFileSync(join(ws.dir, "README.md"), "utf8")).toBe(
          "original\n"
        );
      } finally {
        await ws.dispose();
      }
      expect(existsSync(ws.dir)).toBe(false);
    },
    GIT_SPAWN_TEST_TIMEOUT_MS
  );

  it(
    "dispose() twice is a clean no-op, not a second failing removal",
    async () => {
      // `dispose` is called from a `finally` in the review orchestrator and again
      // by a caller unwinding; the second pass must not throw and fail a run whose
      // work already succeeded.
      const repoDir = mkdtempSync(join(tmpdir(), "audit-ws-dispose-"));
      writeFileSync(join(repoDir, "doc.md"), "source\n", "utf8");
      const ws = await prepareAuditWorkspace(repoDir, { ...HERMETIC_GIT_ENV });

      await ws.dispose();
      await expect(ws.dispose()).resolves.toBeUndefined();
      expect(existsSync(ws.dir)).toBe(false);
    },
    GIT_SPAWN_TEST_TIMEOUT_MS
  );

  it(
    "falls back to a filesystem copy when the git worktree cannot be created",
    async () => {
      // A repo with NO commits is a git repo whose `worktree add HEAD` fails.
      // The pass must degrade to a plain copy rather than propagating the git
      // error — an audit that cannot make a worktree is still an audit that can
      // run against a copy. (The git failure text is deliberately swallowed here,
      // so this asserts the fallback, not an escaping message.)
      const repoDir = mkdtempSync(join(tmpdir(), "audit-ws-nocommit-"));
      runGitFixture(repoDir, ["init", "-q"], {
        env: { ...FIXTURE_IDENTITY_ENV },
      });
      writeFileSync(join(repoDir, "uncommitted.md"), "wip\n", "utf8");

      const ws = await prepareAuditWorkspace(repoDir, { ...HERMETIC_GIT_ENV });
      try {
        expect(ws.isGitWorktree).toBe(false);
        expect(readFileSync(join(ws.dir, "uncommitted.md"), "utf8")).toBe(
          "wip\n"
        );
      } finally {
        await ws.dispose();
      }
    },
    GIT_SPAWN_TEST_TIMEOUT_MS
  );
});
