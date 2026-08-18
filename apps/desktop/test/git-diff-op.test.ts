import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import { registerGitDiffRoutes } from "../src/server/operations/git-diff.js";
import { GIT_GATEWAY_EXEC_TIMEOUT_MS } from "../src/server/operations/git-gateway-constants.js";
import { getResolvedGitPath } from "../src/server/operations/symphony-loop.js";
import type { ExecResult } from "../src/server/process-manager.js";
import {
  createGitOpTempDirs,
  dispatchOperation,
  FakeProcessManager,
} from "./helpers/git-gateway-op-harness.js";

const DIFF_PATH = "/api/gateway/git/diff";
const POST = "POST";
const FAILED_TO_GET_DIFF_REGEX = /Failed to get diff/;

const { makeTempDir } = createGitOpTempDirs("git-diff-op-");

function ok(stdout: string): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function fail(stderr: string, exitCode = 1): ExecResult {
  return { stdout: "", stderr, exitCode };
}

function newDispatcher(
  allowed: string,
  fake: FakeProcessManager
): OperationDispatcher {
  const dispatcher = new OperationDispatcher();
  registerGitDiffRoutes(dispatcher, fake.asProcessManager(), () => [allowed]);
  return dispatcher;
}

async function dispatchDiff(
  repoPath: string,
  fake: FakeProcessManager,
  body: Record<string, unknown>
): Promise<Awaited<ReturnType<typeof dispatchOperation>>> {
  const dispatcher = newDispatcher(repoPath, fake);
  return await dispatchOperation({
    dispatcher,
    method: POST,
    pathname: DIFF_PATH,
    body: JSON.stringify({ repoPath, ...body }),
  });
}

describe(`registerGitDiffRoutes POST ${DIFF_PATH} — branch diff`, () => {
  test("builds git show argv for base and HEAD revisions", async () => {
    const repoPath = makeTempDir();
    const fake = new FakeProcessManager([ok("old\n"), ok("new\n")]);

    const response = await dispatchDiff(repoPath, fake, {
      filePath: "src/file.ts",
      baseBranch: "main",
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(fake.calls[0].args, ["show", "origin/main:src/file.ts"]);
    assert.deepEqual(fake.calls[1].args, ["show", "HEAD:src/file.ts"]);
    // Resolved via the centralized git resolver and carrying a finite deadline.
    for (const call of fake.calls) {
      assert.equal(call.command, getResolvedGitPath());
      assert.deepEqual(call.options, {
        timeoutMs: GIT_GATEWAY_EXEC_TIMEOUT_MS,
      });
    }
    assert.equal(response.body.oldContent, "old\n");
    assert.equal(response.body.newContent, "new\n");
    assert.equal(response.body.isNew, false);
    assert.equal(response.body.isDeleted, false);
  });

  test("marks isNew when the base revision has no such file", async () => {
    const repoPath = makeTempDir();
    const fake = new FakeProcessManager([
      fail("fatal: path does not exist in origin/main", 128),
      ok("new content\n"),
    ]);

    const response = await dispatchDiff(repoPath, fake, {
      filePath: "src/added.ts",
      baseBranch: "main",
    });

    assert.equal(response.body.isNew, true);
    assert.equal(response.body.oldContent, "");
    assert.equal(response.body.newContent, "new content\n");
  });

  test("marks isDeleted when HEAD has no such file", async () => {
    const repoPath = makeTempDir();
    const fake = new FakeProcessManager([
      ok("old content\n"),
      fail("fatal: path does not exist in HEAD", 128),
    ]);

    const response = await dispatchDiff(repoPath, fake, {
      filePath: "src/removed.ts",
      baseBranch: "main",
    });

    assert.equal(response.body.isDeleted, true);
    assert.equal(response.body.newContent, "");
  });

  test("surfaces a 500 (not isNew) when the base git show fails operationally", async () => {
    const repoPath = makeTempDir();
    // A bad base ref is an operational failure, NOT a missing path. It must not
    // be silently reported as isNew with empty oldContent.
    const fake = new FakeProcessManager([
      fail("fatal: bad revision 'origin/nope'", 128),
      ok("new content\n"),
    ]);

    const response = await dispatchDiff(repoPath, fake, {
      filePath: "src/file.ts",
      baseBranch: "nope",
    });

    assert.equal(response.statusCode, 500);
    assert.match(String(response.body.error), FAILED_TO_GET_DIFF_REGEX);
  });

  test("surfaces a 500 (not isDeleted) when the HEAD git show fails operationally", async () => {
    const repoPath = makeTempDir();
    // The base show succeeds but the HEAD show fails for an operational reason
    // (not a missing path). It must not be classified as isDeleted.
    const fake = new FakeProcessManager([
      ok("old content\n"),
      fail("fatal: unable to read tree HEAD", 128),
    ]);

    const response = await dispatchDiff(repoPath, fake, {
      filePath: "src/file.ts",
      baseBranch: "main",
    });

    assert.equal(response.statusCode, 500);
    assert.match(String(response.body.error), FAILED_TO_GET_DIFF_REGEX);
  });

  test("adds isImage and mimeType for an image path in branch diff", async () => {
    const repoPath = makeTempDir();
    const fake = new FakeProcessManager([ok("bytesold"), ok("bytesnew")]);

    const response = await dispatchDiff(repoPath, fake, {
      filePath: "assets/logo.PNG",
      baseBranch: "main",
    });

    assert.equal(response.body.isImage, true);
    assert.equal(response.body.mimeType, "image/png");
  });
});

describe(`registerGitDiffRoutes POST ${DIFF_PATH} — working diff`, () => {
  test("builds status --porcelain argv scoped to the file and reads HEAD + working copy", async () => {
    const repoPath = makeTempDir();
    await fs.writeFile(path.join(repoPath, "file.ts"), "working copy\n");
    const fake = new FakeProcessManager([
      ok(" M file.ts\n"), // status --porcelain -- file.ts
      ok("head content\n"), // show HEAD:file.ts
    ]);

    const response = await dispatchDiff(repoPath, fake, {
      filePath: "file.ts",
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(fake.calls[0].args, [
      "status",
      "--porcelain",
      "--",
      "file.ts",
    ]);
    assert.deepEqual(fake.calls[1].args, ["show", "HEAD:file.ts"]);
    assert.equal(response.body.oldContent, "head content\n");
    assert.equal(response.body.newContent, "working copy\n");
    assert.equal(response.body.isNew, false);
    assert.equal(response.body.isDeleted, false);
  });

  test("treats an untracked file as new and skips the HEAD show", async () => {
    const repoPath = makeTempDir();
    await fs.writeFile(path.join(repoPath, "new.ts"), "fresh\n");
    const fake = new FakeProcessManager([ok("?? new.ts\n")]);

    const response = await dispatchDiff(repoPath, fake, { filePath: "new.ts" });

    assert.equal(response.body.isNew, true);
    assert.equal(response.body.oldContent, "");
    assert.equal(response.body.newContent, "fresh\n");
    // Only the status call ran — no `git show HEAD:` for a brand-new file.
    assert.equal(fake.calls.length, 1);
  });

  test("treats a deleted file as deleted with empty new content", async () => {
    const repoPath = makeTempDir();
    const fake = new FakeProcessManager([ok(" D old.ts\n"), ok("was here\n")]);

    const response = await dispatchDiff(repoPath, fake, { filePath: "old.ts" });

    assert.equal(response.body.isDeleted, true);
    assert.equal(response.body.newContent, "");
    assert.equal(response.body.oldContent, "was here\n");
  });

  test("classifies an AM porcelain entry (added then modified) as new", async () => {
    const repoPath = makeTempDir();
    await fs.writeFile(path.join(repoPath, "added-mod.ts"), "content\n");
    // `AM`: staged addition (index A) then a further worktree modification. The
    // two columns must be parsed separately — the entry is new, not deleted.
    const fake = new FakeProcessManager([ok("AM added-mod.ts\n")]);

    const response = await dispatchDiff(repoPath, fake, {
      filePath: "added-mod.ts",
    });

    assert.equal(response.body.isNew, true);
    assert.equal(response.body.isDeleted, false);
    // A new file skips the HEAD show; only the status call ran.
    assert.equal(fake.calls.length, 1);
  });

  test("classifies an MD porcelain entry (modified then deleted) as deleted", async () => {
    const repoPath = makeTempDir();
    // `MD`: staged modification (index M) then deleted in the worktree (Y = D).
    // Collapsing the code would misreport the flags; the entry is deleted.
    const fake = new FakeProcessManager([
      ok("MD mod-del.ts\n"),
      ok("head content\n"),
    ]);

    const response = await dispatchDiff(repoPath, fake, {
      filePath: "mod-del.ts",
    });

    assert.equal(response.body.isDeleted, true);
    assert.equal(response.body.isNew, false);
    assert.equal(response.body.newContent, "");
  });

  test("returns a 'no changes' payload when status output is empty", async () => {
    const repoPath = makeTempDir();
    const fake = new FakeProcessManager([ok("\n")]);

    const response = await dispatchDiff(repoPath, fake, {
      filePath: "clean.ts",
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.body.error, "File has no changes");
  });

  test("surfaces a 500 when the status read itself fails", async () => {
    const repoPath = makeTempDir();
    const fake = new FakeProcessManager([
      fail("fatal: not a git repository", 128),
    ]);

    const response = await dispatchDiff(repoPath, fake, {
      filePath: "file.ts",
    });

    assert.equal(response.statusCode, 500);
    assert.match(String(response.body.error), FAILED_TO_GET_DIFF_REGEX);
  });
});

describe(`registerGitDiffRoutes POST ${DIFF_PATH} — validation`, () => {
  test("rejects an invalid JSON body with 400", async () => {
    const repoPath = makeTempDir();
    const fake = new FakeProcessManager();
    const dispatcher = newDispatcher(repoPath, fake);

    const response = await dispatchOperation({
      dispatcher,
      method: POST,
      pathname: DIFF_PATH,
      body: "{bad",
    });

    assert.equal(response.statusCode, 400);
    assert.equal(fake.calls.length, 0);
  });

  test("rejects when filePath or repoPath is missing", async () => {
    const repoPath = makeTempDir();
    const fake = new FakeProcessManager();
    const dispatcher = newDispatcher(repoPath, fake);

    const response = await dispatchOperation({
      dispatcher,
      method: POST,
      pathname: DIFF_PATH,
      body: JSON.stringify({ repoPath }),
    });

    assert.equal(response.statusCode, 400);
    assert.equal(fake.calls.length, 0);
  });

  test("rejects a disallowed repo with 403", async () => {
    const allowed = makeTempDir();
    const outside = makeTempDir();
    const fake = new FakeProcessManager();
    const dispatcher = newDispatcher(allowed, fake);

    const response = await dispatchOperation({
      dispatcher,
      method: POST,
      pathname: DIFF_PATH,
      body: JSON.stringify({ repoPath: outside, filePath: "file.ts" }),
    });

    assert.equal(response.statusCode, 403);
    assert.equal(fake.calls.length, 0);
  });

  test("rejects a symlinked file that resolves outside the canonical repo root with 403", async () => {
    // Two sibling repos share one allowed sandbox root. A symlink inside repo A
    // points at a file in sibling repo B. The lexical path sits under the
    // sandbox (so the allow-list alone passes), but the canonical target
    // escapes repo A's root and must be rejected before any read.
    const sandbox = makeTempDir();
    const repoA = path.join(sandbox, "repo-a");
    const repoB = path.join(sandbox, "repo-b");
    await fs.mkdir(repoA, { recursive: true });
    await fs.mkdir(repoB, { recursive: true });
    const secret = path.join(repoB, "secret.ts");
    await fs.writeFile(secret, "sibling secret\n");
    await fs.symlink(secret, path.join(repoA, "link.ts"));

    const fake = new FakeProcessManager();
    const dispatcher = new OperationDispatcher();
    registerGitDiffRoutes(dispatcher, fake.asProcessManager(), () => [sandbox]);

    const response = await dispatchOperation({
      dispatcher,
      method: POST,
      pathname: DIFF_PATH,
      body: JSON.stringify({ repoPath: repoA, filePath: "link.ts" }),
    });

    assert.equal(response.statusCode, 403);
    assert.equal(fake.calls.length, 0);
  });

  test("returns 404 when the repo path does not exist", async () => {
    const parent = makeTempDir();
    const missing = path.join(parent, "gone");
    const fake = new FakeProcessManager();
    const dispatcher = newDispatcher(parent, fake);

    const response = await dispatchOperation({
      dispatcher,
      method: POST,
      pathname: DIFF_PATH,
      body: JSON.stringify({ repoPath: missing, filePath: "file.ts" }),
    });

    assert.equal(response.statusCode, 404);
    assert.equal(fake.calls.length, 0);
  });
});
