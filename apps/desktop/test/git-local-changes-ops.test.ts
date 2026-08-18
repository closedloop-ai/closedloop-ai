/**
 * ISS-5299 — git-local-changes uncovered-branch suite.
 *
 * Sibling to apps/desktop/test/git-local-changes.test.ts (on the biome.jsonc
 * shrink-only grandfather list), which uses real git repos and a real
 * ProcessManager for the integration paths. All git I/O here is intercepted by
 * FakeProcessManager so no real child processes are spawned.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import {
  GitLocalChangesRoute,
  registerGitLocalChangesRoutes,
} from "../src/server/operations/git-local-changes.js";
import type { ExecResult } from "../src/server/process-manager.js";
import {
  createGitOpTempDirs,
  dispatchOperation,
  FakeProcessManager,
} from "./helpers/git-gateway-op-harness.js";

const { makeTempDir } = createGitOpTempDirs("iss5299-glc-");

// ---------------------------------------------------------------------------
// Canned git results
// ---------------------------------------------------------------------------

const OK_BRANCH: ExecResult = { stdout: "feature\n", stderr: "", exitCode: 0 };
const OK_REMOTE: ExecResult = {
  stdout: "git@github.com:acme/widget.git\n",
  stderr: "",
  exitCode: 0,
};
const OK_PUSH_REMOTE: ExecResult = {
  stdout: "git@github.com:acme/widget.git\n",
  stderr: "",
  exitCode: 0,
};
const FAIL: ExecResult = {
  stdout: "",
  stderr: "command failed",
  exitCode: 128,
};
const EMPTY_STATUS: ExecResult = { stdout: "", stderr: "", exitCode: 0 };
const EMPTY_NUMSTAT: ExecResult = { stdout: "", stderr: "", exitCode: 0 };
const ONE_FILE_STATUS: ExecResult = {
  stdout: " M file.txt\n",
  stderr: "",
  exitCode: 0,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDispatcher(
  tmpDir: string,
  pm: FakeProcessManager
): OperationDispatcher {
  const dispatcher = new OperationDispatcher();
  registerGitLocalChangesRoutes(dispatcher, pm.asProcessManager(), () => [
    tmpDir,
  ]);
  return dispatcher;
}

function listQuery(
  repoPath: string,
  overrides: Record<string, string> = {}
): Record<string, string> {
  return {
    repoPath,
    repoFullName: "acme/widget",
    headBranch: "feature",
    ...overrides,
  };
}

function diffBody(
  repoPath: string,
  overrides: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    repoPath,
    repoFullName: "acme/widget",
    headBranch: "feature",
    path: "file.txt",
    ...overrides,
  });
}

function commitBody(
  repoPath: string,
  overrides: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    repoPath,
    repoFullName: "acme/widget",
    headBranch: "feature",
    message: "fix: update widget",
    ...overrides,
  });
}

// Drives the List route with a canned git status line, returns the files array.
async function listWithStatus(
  tmpDir: string,
  statusStdout: string
): Promise<Record<string, unknown>[]> {
  const pm = new FakeProcessManager([
    OK_BRANCH,
    OK_REMOTE,
    { stdout: statusStdout, stderr: "", exitCode: 0 },
    EMPTY_NUMSTAT,
  ]);
  const res = await dispatchOperation({
    dispatcher: makeDispatcher(tmpDir, pm),
    method: "GET",
    pathname: GitLocalChangesRoute.List,
    query: listQuery(tmpDir),
  });
  if (res.statusCode !== 200) {
    throw new Error(`unexpected status ${res.statusCode}`);
  }
  return res.body.files as Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// Group 1 — Route parameter validation (lines 83, 103, 116, 123, 146, 165, 200, 215, 881)
// ---------------------------------------------------------------------------

test("List 400 missing_identity when params absent (lines 83, 200)", async () => {
  const tmpDir = makeTempDir();
  const pm = new FakeProcessManager();
  const res = await dispatchOperation({
    dispatcher: makeDispatcher(tmpDir, pm),
    method: "GET",
    pathname: GitLocalChangesRoute.List,
    query: {},
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, "missing_identity");
  assert.equal(pm.calls.length, 0);
});

test("List 403 repo_not_allowed when repoPath outside sandbox (lines 83, 215)", async () => {
  const allowed = makeTempDir();
  const notAllowed = makeTempDir();
  const pm = new FakeProcessManager();
  const dispatcher = new OperationDispatcher();
  registerGitLocalChangesRoutes(dispatcher, pm.asProcessManager(), () => [
    allowed,
  ]);
  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: GitLocalChangesRoute.List,
    query: listQuery(notAllowed),
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, "repo_not_allowed");
  assert.equal(pm.calls.length, 0);
});

test("Diff 400 invalid_json when body is malformed (line 103)", async () => {
  const tmpDir = makeTempDir();
  const res = await dispatchOperation({
    dispatcher: makeDispatcher(tmpDir, new FakeProcessManager()),
    method: "POST",
    pathname: GitLocalChangesRoute.Diff,
    body: "not-json{",
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, "invalid_json");
});

test("Diff 400 missing_identity when body has no repoPath (lines 116, 200)", async () => {
  const tmpDir = makeTempDir();
  const res = await dispatchOperation({
    dispatcher: makeDispatcher(tmpDir, new FakeProcessManager()),
    method: "POST",
    pathname: GitLocalChangesRoute.Diff,
    body: JSON.stringify({
      repoFullName: "acme/widget",
      headBranch: "feature",
    }),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, "missing_identity");
});

test("Diff 400 missing_path when path absent from body (lines 123, 881 null branch)", async () => {
  const tmpDir = makeTempDir();
  // Validation succeeds; readString(undefined) → null → missing_path (line 881 null)
  const pm = new FakeProcessManager([OK_BRANCH, OK_REMOTE]);
  const res = await dispatchOperation({
    dispatcher: makeDispatcher(tmpDir, pm),
    method: "POST",
    pathname: GitLocalChangesRoute.Diff,
    body: JSON.stringify({
      repoPath: tmpDir,
      repoFullName: "acme/widget",
      headBranch: "feature",
    }),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, "missing_path");
  assert.equal(pm.calls.length, 2);
});

test("CommitPush 400 invalid_json when body is malformed (line 146)", async () => {
  const tmpDir = makeTempDir();
  const res = await dispatchOperation({
    dispatcher: makeDispatcher(tmpDir, new FakeProcessManager()),
    method: "POST",
    pathname: GitLocalChangesRoute.CommitPush,
    body: "{broken",
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, "invalid_json");
});

test("CommitPush 400 missing_message when message absent (lines 165, 881 null branch)", async () => {
  const tmpDir = makeTempDir();
  const pm = new FakeProcessManager([OK_BRANCH, OK_REMOTE, OK_PUSH_REMOTE]);
  const res = await dispatchOperation({
    dispatcher: makeDispatcher(tmpDir, pm),
    method: "POST",
    pathname: GitLocalChangesRoute.CommitPush,
    body: JSON.stringify({
      repoPath: tmpDir,
      repoFullName: "acme/widget",
      headBranch: "feature",
    }),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, "missing_message");
  assert.equal(pm.calls.length, 3);
});

// ---------------------------------------------------------------------------
// Group 2 — validateRepoRequest errors (lines 235, 262, 270, 293, 796, 870, 872)
// ---------------------------------------------------------------------------

test("List 500 branch_lookup_failed when rev-parse fails (lines 235, 796, 870, 872)", async () => {
  const tmpDir = makeTempDir();
  // FAIL has no errorCode → gitRead spreads {} (line 796 false branch)
  // gitFailure with timedOut=false → lines 870 and 872 false branches
  const pm = new FakeProcessManager([FAIL]);
  const res = await dispatchOperation({
    dispatcher: makeDispatcher(tmpDir, pm),
    method: "GET",
    pathname: GitLocalChangesRoute.List,
    query: listQuery(tmpDir),
  });
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.code, "branch_lookup_failed");
  assert.deepEqual(pm.calls[0].args, ["rev-parse", "--abbrev-ref", "HEAD"]);
  assert.equal(res.body.error, "command failed");
});

test("List 409 missing_origin when remote get-url fails (line 262)", async () => {
  const tmpDir = makeTempDir();
  const pm = new FakeProcessManager([OK_BRANCH, FAIL]);
  const res = await dispatchOperation({
    dispatcher: makeDispatcher(tmpDir, pm),
    method: "GET",
    pathname: GitLocalChangesRoute.List,
    query: listQuery(tmpDir),
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "missing_origin");
  assert.deepEqual(pm.calls[1].args, ["remote", "get-url", "origin"]);
});

test("List 409 repo_mismatch when origin remote is a different repo (line 270)", async () => {
  const tmpDir = makeTempDir();
  const wrongRemote: ExecResult = {
    stdout: "git@github.com:other-org/other-repo.git\n",
    stderr: "",
    exitCode: 0,
  };
  const pm = new FakeProcessManager([OK_BRANCH, wrongRemote]);
  const res = await dispatchOperation({
    dispatcher: makeDispatcher(tmpDir, pm),
    method: "GET",
    pathname: GitLocalChangesRoute.List,
    query: listQuery(tmpDir),
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "repo_mismatch");
  const details = res.body.details as Record<string, unknown>;
  assert.equal(details.actualRepoFullName, "other-org/other-repo");
});

test("CommitPush 409 missing_push_origin when push remote query fails (line 293)", async () => {
  const tmpDir = makeTempDir();
  const pm = new FakeProcessManager([OK_BRANCH, OK_REMOTE, FAIL]);
  const res = await dispatchOperation({
    dispatcher: makeDispatcher(tmpDir, pm),
    method: "POST",
    pathname: GitLocalChangesRoute.CommitPush,
    body: commitBody(tmpDir),
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "missing_push_origin");
  assert.deepEqual(pm.calls[2].args, [
    "remote",
    "get-url",
    "--push",
    "--all",
    "origin",
  ]);
});

// ---------------------------------------------------------------------------
// Group 3 — readLocalStatus / readNumstat / parseStatusLine / classifyStatus
// Lines: 590, 612, 660
// ---------------------------------------------------------------------------

test("List 200 with zero stats when numstat git call fails (line 590)", async () => {
  const tmpDir = makeTempDir();
  const okStatus: ExecResult = {
    stdout: " M tracked.txt\n",
    stderr: "",
    exitCode: 0,
  };
  // numstat fails → readNumstat returns empty map → all additions/deletions = 0
  const pm = new FakeProcessManager([OK_BRANCH, OK_REMOTE, okStatus, FAIL]);
  const res = await dispatchOperation({
    dispatcher: makeDispatcher(tmpDir, pm),
    method: "GET",
    pathname: GitLocalChangesRoute.List,
    query: listQuery(tmpDir),
  });
  assert.equal(res.statusCode, 200);
  const files = res.body.files as Record<string, unknown>[];
  assert.equal(files.length, 1);
  assert.equal(files[0].additions, 0);
  assert.equal(files[0].deletions, 0);
});

test("List silently drops status lines with empty payload (line 612)", async () => {
  const tmpDir = makeTempDir();
  // "?? " has code "??" but no filename → parseStatusLine returns null (line 612)
  const files = await listWithStatus(tmpDir, "?? \n M real.txt\n");
  assert.ok(files.some((f) => f.path === "real.txt"));
  assert.ok(files.every((f) => (f.path as string).trim() !== ""));
});

test("List classifies C-prefix status lines as copied (line 660)", async () => {
  const tmpDir = makeTempDir();
  const files = await listWithStatus(tmpDir, "C  original.txt -> copy.txt\n");
  const copied = files.find((f) => f.path === "copy.txt");
  assert.ok(copied, "copied file must appear");
  assert.equal(copied.status, "copied");
});

// ---------------------------------------------------------------------------
// Group 4 — readLocalDiff branches (lines 410, 428, 439, 476, 678, 704, 712)
// ---------------------------------------------------------------------------

test("Diff 400 invalid_path when filePath is absolute (line 678)", async () => {
  const tmpDir = makeTempDir();
  const pm = new FakeProcessManager([OK_BRANCH, OK_REMOTE]);
  const res = await dispatchOperation({
    dispatcher: makeDispatcher(tmpDir, pm),
    method: "POST",
    pathname: GitLocalChangesRoute.Diff,
    body: diffBody(tmpDir, { path: "/etc/passwd" }),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, "invalid_path");
});

test("Diff 400 invalid_path for absolute previousPath (lines 410, 885 truthy branch)", async () => {
  const tmpDir = makeTempDir();
  // readNullableString returns non-null → line 885 truthy → validateGitRelativePath fails
  const pm = new FakeProcessManager([OK_BRANCH, OK_REMOTE]);
  const res = await dispatchOperation({
    dispatcher: makeDispatcher(tmpDir, pm),
    method: "POST",
    pathname: GitLocalChangesRoute.Diff,
    body: diffBody(tmpDir, {
      path: "file.txt",
      previousPath: "/absolute/old.txt",
    }),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, "invalid_path");
  assert.equal(pm.calls.length, 2);
});

test("Diff 500 status_failed when git status call errors (lines 428, 870, 872)", async () => {
  const tmpDir = makeTempDir();
  const pm = new FakeProcessManager([OK_BRANCH, OK_REMOTE, FAIL]);
  const res = await dispatchOperation({
    dispatcher: makeDispatcher(tmpDir, pm),
    method: "POST",
    pathname: GitLocalChangesRoute.Diff,
    body: diffBody(tmpDir),
  });
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.code, "status_failed");
  assert.equal(pm.calls[2].args[0], "status");
});

test("Diff 404 no_local_changes when file missing from git status output (line 439)", async () => {
  const tmpDir = makeTempDir();
  const otherFileStatus: ExecResult = {
    stdout: " M other.txt\n",
    stderr: "",
    exitCode: 0,
  };
  const pm = new FakeProcessManager([OK_BRANCH, OK_REMOTE, otherFileStatus]);
  const res = await dispatchOperation({
    dispatcher: makeDispatcher(tmpDir, pm),
    method: "POST",
    pathname: GitLocalChangesRoute.Diff,
    body: diffBody(tmpDir, { path: "file.txt" }),
  });
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, "no_local_changes");
});

test("Diff isDeleted=true and empty newContent for a removed file (line 476)", async () => {
  const tmpDir = makeTempDir();
  const deletedStatus: ExecResult = {
    stdout: " D deleted.txt\n",
    stderr: "",
    exitCode: 0,
  };
  const notBinaryNumstat: ExecResult = {
    stdout: "0\t5\tdeleted.txt\n",
    stderr: "",
    exitCode: 0,
  };
  const headContent: ExecResult = {
    stdout: "old content\n",
    stderr: "",
    exitCode: 0,
  };
  const pm = new FakeProcessManager([
    OK_BRANCH,
    OK_REMOTE,
    deletedStatus,
    notBinaryNumstat,
    headContent,
  ]);
  const res = await dispatchOperation({
    dispatcher: makeDispatcher(tmpDir, pm),
    method: "POST",
    pathname: GitLocalChangesRoute.Diff,
    body: diffBody(tmpDir, { path: "deleted.txt" }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.isDeleted, true);
  assert.equal(res.body.isBinary, false);
  assert.equal(res.body.oldContent, "old content\n");
  assert.equal(res.body.newContent, ""); // isDeleted → { isBinary: false, content: "" }
});

test("Diff 403 path_escape when filePath resolves via symlink outside repo (line 704)", async () => {
  const tmpDir = makeTempDir();
  // A separate sandbox dir (sibling of tmpDir) that acts as the symlink target
  const outsideDir = makeTempDir();
  // Create the actual target file so fs.realpath can follow the symlink
  const outsideTarget = path.join(outsideDir, "outside-target.txt");
  await fs.writeFile(outsideTarget, "outside content", "utf-8");
  // Symlink inside tmpDir → existing file outside tmpDir
  const symlinkName = "escape-link.txt";
  await fs.symlink(outsideTarget, path.join(tmpDir, symlinkName));
  // validateGitRelativePath runs BEFORE git status (source line 406 < 421),
  // so only rev-parse + remote are consumed before the 403 is returned
  const pm = new FakeProcessManager([OK_BRANCH, OK_REMOTE]);
  const res = await dispatchOperation({
    dispatcher: makeDispatcher(tmpDir, pm),
    method: "POST",
    pathname: GitLocalChangesRoute.Diff,
    body: diffBody(tmpDir, { path: symlinkName }),
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, "path_escape");
});

test("Diff validation passes for non-existent file (line 712 catch falls through)", async () => {
  const tmpDir = makeTempDir();
  // "ghost.txt" does not exist → fs.realpath throws → catch (line 712) →
  // path.resolve stays inside repo → !isPathInside = false → ok: true →
  // git status shows no changes → 404
  const pm = new FakeProcessManager([
    OK_BRANCH,
    OK_REMOTE,
    { stdout: "", stderr: "", exitCode: 0 },
  ]);
  const res = await dispatchOperation({
    dispatcher: makeDispatcher(tmpDir, pm),
    method: "POST",
    pathname: GitLocalChangesRoute.Diff,
    body: diffBody(tmpDir, { path: "ghost.txt" }),
  });
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, "no_local_changes");
});

// ---------------------------------------------------------------------------
// Group 5 — readHeadContent and readWorkingFile catches (lines 732, 748)
// ---------------------------------------------------------------------------

test("Diff returns empty oldContent when git show HEAD fails (line 732 false branch)", async () => {
  const tmpDir = makeTempDir();
  const modifiedStatus: ExecResult = {
    stdout: " M file.txt\n",
    stderr: "",
    exitCode: 0,
  };
  const notBinaryNumstat: ExecResult = {
    stdout: "5\t2\tfile.txt\n",
    stderr: "",
    exitCode: 0,
  };
  const showFail: ExecResult = {
    stdout: "",
    stderr: "path not found in HEAD",
    exitCode: 128,
  };
  await fs.writeFile(path.join(tmpDir, "file.txt"), "new content\n", "utf-8");
  const pm = new FakeProcessManager([
    OK_BRANCH,
    OK_REMOTE,
    modifiedStatus,
    notBinaryNumstat,
    showFail,
  ]);
  const res = await dispatchOperation({
    dispatcher: makeDispatcher(tmpDir, pm),
    method: "POST",
    pathname: GitLocalChangesRoute.Diff,
    body: diffBody(tmpDir),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.oldContent, ""); // show failed → "" (line 732 falsy branch)
  assert.equal(res.body.newContent, "new content\n");
});

test("Diff returns empty newContent when working file is unreadable (line 748)", async () => {
  const tmpDir = makeTempDir();
  const modifiedStatus: ExecResult = {
    stdout: " M missing.txt\n",
    stderr: "",
    exitCode: 0,
  };
  const notBinaryNumstat: ExecResult = {
    stdout: "3\t1\tmissing.txt\n",
    stderr: "",
    exitCode: 0,
  };
  const headContent: ExecResult = {
    stdout: "old content\n",
    stderr: "",
    exitCode: 0,
  };
  // "missing.txt" does NOT exist → readWorkingFile fs.readFile throws → catch → { isBinary: false, content: "" }
  const pm = new FakeProcessManager([
    OK_BRANCH,
    OK_REMOTE,
    modifiedStatus,
    notBinaryNumstat,
    headContent,
  ]);
  const res = await dispatchOperation({
    dispatcher: makeDispatcher(tmpDir, pm),
    method: "POST",
    pathname: GitLocalChangesRoute.Diff,
    body: diffBody(tmpDir, { path: "missing.txt" }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.oldContent, "old content\n");
  assert.equal(res.body.newContent, "");
});

// ---------------------------------------------------------------------------
// Group 6 — readUntrackedTextStats branches (lines 759, 763, 767, 770)
// ---------------------------------------------------------------------------

test("List reports additions=0 for untracked binary or empty files (lines 759, 763)", async () => {
  const tmpDir = makeTempDir();
  const untrackedStatus: ExecResult = {
    stdout: "?? binary.bin\n?? empty.txt\n",
    stderr: "",
    exitCode: 0,
  };
  const pm = new FakeProcessManager([
    OK_BRANCH,
    OK_REMOTE,
    untrackedStatus,
    EMPTY_NUMSTAT,
  ]);
  await fs.writeFile(path.join(tmpDir, "binary.bin"), Buffer.from([0, 1, 2]));
  await fs.writeFile(path.join(tmpDir, "empty.txt"), "", "utf-8");
  const res = await dispatchOperation({
    dispatcher: makeDispatcher(tmpDir, pm),
    method: "GET",
    pathname: GitLocalChangesRoute.List,
    query: listQuery(tmpDir),
  });
  assert.equal(res.statusCode, 200);
  const files = res.body.files as Record<string, unknown>[];
  const bin = files.find((f) => f.path === "binary.bin");
  const empty = files.find((f) => f.path === "empty.txt");
  assert.ok(bin, "binary.bin must appear");
  assert.ok(empty, "empty.txt must appear");
  assert.equal(bin.additions, 0); // binary → { additions: 0 } (line 759)
  assert.equal(empty.additions, 0); // empty content → { additions: 0 } (line 763)
});

test("List counts lines for untracked text file with trailing newline (line 767)", async () => {
  const tmpDir = makeTempDir();
  const untrackedStatus: ExecResult = {
    stdout: "?? notes.txt\n",
    stderr: "",
    exitCode: 0,
  };
  const pm = new FakeProcessManager([
    OK_BRANCH,
    OK_REMOTE,
    untrackedStatus,
    EMPTY_NUMSTAT,
  ]);
  // 3 lines ending with newline → split gives 4 parts → count = 4 - 1 = 3
  await fs.writeFile(path.join(tmpDir, "notes.txt"), "a\nb\nc\n", "utf-8");
  const res = await dispatchOperation({
    dispatcher: makeDispatcher(tmpDir, pm),
    method: "GET",
    pathname: GitLocalChangesRoute.List,
    query: listQuery(tmpDir),
  });
  assert.equal(res.statusCode, 200);
  const files = res.body.files as Record<string, unknown>[];
  const notes = files.find((f) => f.path === "notes.txt");
  assert.ok(notes, "notes.txt must appear");
  assert.equal(notes.additions, 3); // endsWith("\n") → length-1 (line 767 true branch)
});

test("List reports additions=0 when untracked file cannot be read (line 770)", async () => {
  const tmpDir = makeTempDir();
  const untrackedStatus: ExecResult = {
    stdout: "?? ghost.txt\n",
    stderr: "",
    exitCode: 0,
  };
  const pm = new FakeProcessManager([
    OK_BRANCH,
    OK_REMOTE,
    untrackedStatus,
    EMPTY_NUMSTAT,
  ]);
  // ghost.txt does NOT exist → readUntrackedTextStats catch (line 770) → null → additions 0
  const res = await dispatchOperation({
    dispatcher: makeDispatcher(tmpDir, pm),
    method: "GET",
    pathname: GitLocalChangesRoute.List,
    query: listQuery(tmpDir),
  });
  assert.equal(res.statusCode, 200);
  const files = res.body.files as Record<string, unknown>[];
  const ghost = files.find((f) => f.path === "ghost.txt");
  assert.ok(ghost, "ghost.txt must appear");
  assert.equal(ghost.additions, 0);
});

// ---------------------------------------------------------------------------
// Group 7 — commitAndPushLocalChanges failures (lines 180, 516, 519, 528, 540, 548, 560)
// ---------------------------------------------------------------------------

test("CommitPush 409 no_local_changes when status is empty (lines 519, 180)", async () => {
  const tmpDir = makeTempDir();
  const pm = new FakeProcessManager([
    OK_BRANCH,
    OK_REMOTE,
    OK_PUSH_REMOTE,
    EMPTY_STATUS,
    EMPTY_NUMSTAT,
  ]);
  const res = await dispatchOperation({
    dispatcher: makeDispatcher(tmpDir, pm),
    method: "POST",
    pathname: GitLocalChangesRoute.CommitPush,
    body: commitBody(tmpDir),
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "no_local_changes");
});

test("CommitPush 500 status_failed when readLocalStatus git call fails (lines 516, 180)", async () => {
  const tmpDir = makeTempDir();
  const pm = new FakeProcessManager([
    OK_BRANCH,
    OK_REMOTE,
    OK_PUSH_REMOTE,
    FAIL,
  ]);
  const res = await dispatchOperation({
    dispatcher: makeDispatcher(tmpDir, pm),
    method: "POST",
    pathname: GitLocalChangesRoute.CommitPush,
    body: commitBody(tmpDir),
  });
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.code, "status_failed");
});

test("CommitPush 500 git_add_failed when git add errors (lines 528, 180)", async () => {
  const tmpDir = makeTempDir();
  const pm = new FakeProcessManager([
    OK_BRANCH,
    OK_REMOTE,
    OK_PUSH_REMOTE,
    ONE_FILE_STATUS,
    EMPTY_NUMSTAT,
    FAIL, // git add fails
  ]);
  const res = await dispatchOperation({
    dispatcher: makeDispatcher(tmpDir, pm),
    method: "POST",
    pathname: GitLocalChangesRoute.CommitPush,
    body: commitBody(tmpDir),
  });
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.code, "git_add_failed");
  assert.deepEqual(pm.calls[5].args, ["add", "--all"]);
});

test("CommitPush 500 git_commit_failed when git commit errors (lines 540, 180)", async () => {
  const tmpDir = makeTempDir();
  const addOk: ExecResult = { stdout: "", stderr: "", exitCode: 0 };
  const pm = new FakeProcessManager([
    OK_BRANCH,
    OK_REMOTE,
    OK_PUSH_REMOTE,
    ONE_FILE_STATUS,
    EMPTY_NUMSTAT,
    addOk,
    FAIL, // git commit fails
  ]);
  const res = await dispatchOperation({
    dispatcher: makeDispatcher(tmpDir, pm),
    method: "POST",
    pathname: GitLocalChangesRoute.CommitPush,
    body: commitBody(tmpDir),
  });
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.code, "git_commit_failed");
  assert.equal(pm.calls[6].args[0], "commit");
});

test("CommitPush 500 commit_sha_failed when rev-parse HEAD errors (lines 548, 180)", async () => {
  const tmpDir = makeTempDir();
  const addOk: ExecResult = { stdout: "", stderr: "", exitCode: 0 };
  const commitOk: ExecResult = {
    stdout: "[feature abc1234] fix: update widget",
    stderr: "",
    exitCode: 0,
  };
  const pm = new FakeProcessManager([
    OK_BRANCH,
    OK_REMOTE,
    OK_PUSH_REMOTE,
    ONE_FILE_STATUS,
    EMPTY_NUMSTAT,
    addOk,
    commitOk,
    FAIL, // rev-parse HEAD fails
  ]);
  const res = await dispatchOperation({
    dispatcher: makeDispatcher(tmpDir, pm),
    method: "POST",
    pathname: GitLocalChangesRoute.CommitPush,
    body: commitBody(tmpDir),
  });
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.code, "commit_sha_failed");
  assert.deepEqual(pm.calls[7].args, ["rev-parse", "HEAD"]);
});

test("CommitPush 500 git_push_failed when git push errors (lines 560, 180)", async () => {
  const tmpDir = makeTempDir();
  const addOk: ExecResult = { stdout: "", stderr: "", exitCode: 0 };
  const commitOk: ExecResult = {
    stdout: "[feature abc1234] fix: update",
    stderr: "",
    exitCode: 0,
  };
  const shaOk: ExecResult = {
    stdout: "abc123def456789\n",
    stderr: "",
    exitCode: 0,
  };
  const pm = new FakeProcessManager([
    OK_BRANCH,
    OK_REMOTE,
    OK_PUSH_REMOTE,
    ONE_FILE_STATUS,
    EMPTY_NUMSTAT,
    addOk,
    commitOk,
    shaOk,
    FAIL, // git push fails
  ]);
  const res = await dispatchOperation({
    dispatcher: makeDispatcher(tmpDir, pm),
    method: "POST",
    pathname: GitLocalChangesRoute.CommitPush,
    body: commitBody(tmpDir),
  });
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.code, "git_push_failed");
  assert.equal(pm.calls[8].args[0], "push");
  assert.equal(pm.calls[8].args[2], "HEAD:feature");
});

// ---------------------------------------------------------------------------
// Group 8 — parseRemoteDestination edge cases (lines 802, 809, 812, 827, 831, 837)
// ---------------------------------------------------------------------------

test("List 409 repo_mismatch when origin URL is empty string (line 802)", async () => {
  const tmpDir = makeTempDir();
  const emptyRemote: ExecResult = { stdout: "   \n", stderr: "", exitCode: 0 };
  const pm = new FakeProcessManager([OK_BRANCH, emptyRemote]);
  const res = await dispatchOperation({
    dispatcher: makeDispatcher(tmpDir, pm),
    method: "GET",
    pathname: GitLocalChangesRoute.List,
    query: listQuery(tmpDir),
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "repo_mismatch");
});

test("List 200 succeeds with HTTPS origin URL (lines 809, 812)", async () => {
  const tmpDir = makeTempDir();
  const httpsRemote: ExecResult = {
    stdout: "https://github.com/acme/widget.git\n",
    stderr: "",
    exitCode: 0,
  };
  const pm = new FakeProcessManager([
    OK_BRANCH,
    httpsRemote,
    EMPTY_STATUS,
    EMPTY_NUMSTAT,
  ]);
  const res = await dispatchOperation({
    dispatcher: makeDispatcher(tmpDir, pm),
    method: "GET",
    pathname: GitLocalChangesRoute.List,
    query: listQuery(tmpDir),
  });
  assert.equal(res.statusCode, 200);
});

test("List 200 succeeds with file:// origin URL (line 812)", async () => {
  const tmpDir = makeTempDir();
  const fileRemote: ExecResult = {
    stdout: "file:///local/acme/widget\n",
    stderr: "",
    exitCode: 0,
  };
  const pm = new FakeProcessManager([
    OK_BRANCH,
    fileRemote,
    EMPTY_STATUS,
    EMPTY_NUMSTAT,
  ]);
  const res = await dispatchOperation({
    dispatcher: makeDispatcher(tmpDir, pm),
    method: "GET",
    pathname: GitLocalChangesRoute.List,
    query: listQuery(tmpDir),
  });
  assert.equal(res.statusCode, 200);
});

test("List 409 repo_mismatch when SCP path has no owner/repo pattern (line 827)", async () => {
  const tmpDir = makeTempDir();
  // SCP match succeeds but fullNameFromPath("widget") returns null (no slash)
  const badScpRemote: ExecResult = {
    stdout: "git@github.com:widget\n",
    stderr: "",
    exitCode: 0,
  };
  const pm = new FakeProcessManager([OK_BRANCH, badScpRemote]);
  const res = await dispatchOperation({
    dispatcher: makeDispatcher(tmpDir, pm),
    method: "GET",
    pathname: GitLocalChangesRoute.List,
    query: listQuery(tmpDir),
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "repo_mismatch");
});

test("List 409 repo_mismatch when local path has no slash (lines 831, 837)", async () => {
  const tmpDir = makeTempDir();
  // Not a URL, no @ or :, not SCP → fallback → fullNameFromPath("widget") → no slash → null
  const localRemote: ExecResult = {
    stdout: "widget\n",
    stderr: "",
    exitCode: 0,
  };
  const pm = new FakeProcessManager([OK_BRANCH, localRemote]);
  const res = await dispatchOperation({
    dispatcher: makeDispatcher(tmpDir, pm),
    method: "GET",
    pathname: GitLocalChangesRoute.List,
    query: listQuery(tmpDir),
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "repo_mismatch");
});

// ---------------------------------------------------------------------------
// Group 9 — splitRenamePayload branches (lines 634, 638, 653)
// ---------------------------------------------------------------------------

test("splitRenamePayload handles backslash-escaped quote inside quoted rename path (lines 634, 638)", async () => {
  const tmpDir = makeTempDir();
  // Inside the quoted old path, \" is an escaped quote.
  // Processing: char='"' sets quoted=true; char='\' sets escaped=true (line 638);
  // next char='"' is consumed with escaped=true → line 634 fires (escaped=true branch).
  const files = await listWithStatus(
    tmpDir,
    'R  "old \\"spaced\\".txt" -> new.txt\n'
  );
  const renamed = files.find((f) => f.path === "new.txt");
  assert.ok(renamed, "renamed file must appear");
  assert.equal(renamed.status, "renamed");
  assert.ok(
    renamed.previousPath?.toString().includes("spaced"),
    "previousPath must decode the quoted name"
  );
});

test("splitRenamePayload returns null when rename code has no arrow separator (line 653)", async () => {
  const tmpDir = makeTempDir();
  // Code "R " triggers splitRenamePayload but no " -> " sequence → returns null (line 653)
  const files = await listWithStatus(tmpDir, "R  noarrowhere.txt\n");
  const entry = files.find((f) => f.path === "noarrowhere.txt");
  assert.ok(entry, "file must still appear");
  assert.equal(entry.previousPath, null);
  assert.equal(entry.status, "renamed");
});

// ---------------------------------------------------------------------------
// Group 10 — unquoteGitPath and simpleGitEscapeByte
// Lines: 901, 907, 924, 930, 933, 936, 939, 942, 945, 948, 951
// ---------------------------------------------------------------------------

test("unquoteGitPath pushes literal backslash for trailing-backslash content (line 901)", async () => {
  const tmpDir = makeTempDir();
  // '?? "trail\\"\n' → stdout value: ?? "trail\" + LF
  // content = trail\ (5 chars ending with \)
  // When index increments past content.length → line 901 fires.
  const files = await listWithStatus(tmpDir, '?? "trail\\"\n');
  assert.equal(files.length, 1);
  assert.ok(
    files[0].path?.toString().startsWith("trail") &&
      files[0].path?.toString().includes("\\"),
    "path must end with a literal backslash"
  );
});

test("unquoteGitPath decodes all simple escapes and passes unrecognized char through (lines 907, 924, 930–951)", async () => {
  const tmpDir = makeTempDir();
  // Each two-char sequence below is a literal backslash + letter in the git stdout.
  // "\\a" in a JS string = one backslash + 'a' (two chars, which git uses as escape).
  const escapeSeqs =
    "\\a" + // BEL (line 930)
    "\\b" + // BS  (line 933)
    "\\f" + // FF  (line 936)
    "\\n" + // LF  (line 939)
    "\\r" + // CR  (line 942)
    "\\t" + // TAB (line 945)
    "\\v" + // VT  (line 948)
    "\\\\" + // \\ → literal backslash (line 951)
    '\\"' + // \" → literal " (line 951)
    "\\x"; // \x → unrecognized, pass 'x' through (line 924)
  const quotedPath = `"${escapeSeqs}name.txt"`;
  const files = await listWithStatus(tmpDir, `?? ${quotedPath}\n`);
  assert.equal(files.length, 1);
  const decoded = files[0].path?.toString() ?? "";
  assert.ok(decoded.includes("\x07"), "\\a → BEL (0x07)");
  assert.ok(decoded.includes("\x08"), "\\b → BS (0x08)");
  assert.ok(decoded.includes("\x0c"), "\\f → FF (0x0c)");
  assert.ok(decoded.includes("\n"), "\\n → LF (0x0a)");
  assert.ok(decoded.includes("\r"), "\\r → CR (0x0d)");
  assert.ok(decoded.includes("\t"), "\\t → TAB (0x09)");
  assert.ok(decoded.includes("\x0b"), "\\v → VT (0x0b)");
  assert.ok(decoded.includes("\\"), "\\\\ → single backslash");
  assert.ok(decoded.includes('"'), '\\" → double quote');
  assert.ok(decoded.includes("x"), "\\x → literal x (unrecognized escape)");
});
