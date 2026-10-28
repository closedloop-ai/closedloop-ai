/**
 * ISS-11282 — branch coverage for git-helpers.ts `classifyExecFileFailure`,
 * reached through `resolveRepoFullNameOutcomeAsync`. Each guard is pinned
 * against a numeric exit code, so dropping a guard would let the failure fall
 * through to the memoizable `NoOrigin` answer. Only the `git remote get-url`
 * spawn is faked; every other `execFile` call reaches the real module.
 */
import type * as ChildProcess from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  RepoFullNameStatus,
  resolveRepoFullNameOutcomeAsync,
} from "../src/server/operations/git-helpers.js";

const remoteFailure = vi.hoisted(() => ({ value: undefined as unknown }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  const execFile = (...args: unknown[]) => {
    const argv = args[1];
    const callback = args.at(-1);
    if (
      remoteFailure.value !== undefined &&
      Array.isArray(argv) &&
      argv[0] === "remote" &&
      typeof callback === "function"
    ) {
      const failure = remoteFailure.value;
      setImmediate(() => callback(failure, "", ""));
      return;
    }
    return Reflect.apply(actual.execFile, undefined, args);
  };
  return { ...actual, execFile };
});

const tempDirs: string[] = [];

afterEach(() => {
  remoteFailure.value = undefined;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function existingDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "iss11282-helpers-"));
  tempDirs.push(dir);
  return dir;
}

describe("resolveRepoFullNameOutcomeAsync — exec failure classification", () => {
  test.each([
    {
      label: "a rejection that is not an object",
      failure: "spawn exploded",
      status: RepoFullNameStatus.SpawnFailed,
    },
    {
      label: "a killed child even with a numeric exit code",
      failure: { killed: true, signal: null, code: 1 },
      status: RepoFullNameStatus.SpawnFailed,
    },
    {
      label: "a signalled child even with a numeric exit code",
      failure: { killed: false, signal: "SIGTERM", code: 1 },
      status: RepoFullNameStatus.SpawnFailed,
    },
    {
      label: "a numeric exit code whose signal key is present but undefined",
      failure: { killed: false, signal: undefined, code: 2 },
      status: RepoFullNameStatus.NoOrigin,
    },
    {
      label: "a plain numeric exit code",
      failure: { killed: false, signal: null, code: 128 },
      status: RepoFullNameStatus.NoOrigin,
    },
  ])("$label classifies as $status", async ({ failure, status }) => {
    remoteFailure.value = failure;

    const outcome = await resolveRepoFullNameOutcomeAsync(existingDir());

    expect(outcome).toEqual({ status, repoFullName: null });
  });
});
