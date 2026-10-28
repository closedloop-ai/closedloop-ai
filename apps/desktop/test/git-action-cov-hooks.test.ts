/**
 * ISS-11282 — pins how git-action.ts classifies a failed commit: which output
 * words mark a pre-commit hook (case-insensitive, either stream), that the two
 * streams are joined with a newline rather than run together, and that a
 * failed `git add` inside the commit action is never read as a hook failure.
 */
import { LoopErrorCode } from "@closedloop-ai/loops-api/error-codes";
import {
  GitGatewayErrorCategory,
  GitHookType,
} from "@closedloop-ai/loops-api/friendly-error";
import { describe, expect, test } from "vitest";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import { registerGitActionRoutes } from "../src/server/operations/git-action.js";
import type { ExecResult } from "../src/server/process-manager.js";
import {
  createGitOpTempDirs,
  dispatchOperation,
  FakeProcessManager,
} from "./helpers/git-gateway-op-harness.js";

const { makeTempDir } = createGitOpTempDirs("iss11282-ghook-");
const COMMIT_MESSAGE = "update readme";

const OK_ADD: ExecResult = { stdout: "", stderr: "", exitCode: 0 };

function commit(results: ExecResult[]) {
  const repo = makeTempDir();
  const pm = new FakeProcessManager(results);
  const dispatcher = new OperationDispatcher();
  registerGitActionRoutes(dispatcher, pm.asProcessManager(), () => [repo]);
  return dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/git",
    body: JSON.stringify({
      action: "commit",
      repoPath: repo,
      message: COMMIT_MESSAGE,
    }),
  });
}

describe("git action commit — hook classification", () => {
  test.each([
    {
      label: "upper-case husky / pre-commit output",
      stderr: "HUSKY - PRE-COMMIT SCRIPT FAILED",
      stdout: "",
      hookType: GitHookType.Unknown,
    },
    {
      label: "a husky mention without pre-commit",
      stderr: "husky - script failed",
      stdout: "",
      hookType: GitHookType.Unknown,
    },
    {
      label: "a lint mention that only appears on stdout",
      stderr: "error: commit failed",
      stdout: "running lint",
      hookType: GitHookType.Lint,
    },
  ])(
    "$label is a pre-commit hook failure",
    async ({ stderr, stdout, hookType }) => {
      const response = await commit([OK_ADD, { stdout, stderr, exitCode: 1 }]);

      expect(response.statusCode).toBe(500);
      expect(response.body).toEqual({
        error: "Pre-commit hook failed",
        code: LoopErrorCode.ProcessFailed,
        details: {
          action: "commit",
          category: GitGatewayErrorCategory.PreCommitHook,
          hookType,
          stderrExcerpt: stderr,
        },
      });
    }
  );

  test("stderr and stdout are joined with a newline, so words split across them do not form 'hook'", async () => {
    const response = await commit([
      OK_ADD,
      { stdout: "ok", stderr: "error: ho", exitCode: 1 },
    ]);

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      error: "error: ho",
      code: LoopErrorCode.ProcessFailed,
      details: {
        action: "commit",
        category: GitGatewayErrorCategory.GitCommandFailed,
        exitCode: 1,
        stderrExcerpt: "error: ho",
      },
    });
  });

  test("a failed git add with hook-like output is a plain command failure", async () => {
    const response = await commit([
      { stdout: "", stderr: "hook: index.lock busy", exitCode: 128 },
    ]);

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      error: "hook: index.lock busy",
      code: LoopErrorCode.ProcessFailed,
      details: {
        action: "commit",
        category: GitGatewayErrorCategory.GitCommandFailed,
        exitCode: 128,
        stderrExcerpt: "hook: index.lock busy",
      },
    });
  });
});
