/**
 * @file sqlite-cov-iss11283-facade.test.ts
 * @description ISS-11283: facade closures on the object `openSqliteAgentDatabase`
 * returns that no other suite drives through the facade itself —
 *   - `claudeCodeOtel.persistSignals` naming a rejected signal that carries no
 *     `type` at all (a process-boundary payload the parameter type forbids);
 *   - the importer's `onPostImport` hook, which captures repo identity for a
 *     session whose cwd is a git work tree, and logs a capture that fails.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Harness } from "../src/main/collectors/types.js";
import {
  type ClaudeCodeOtelSideTableSignal,
  ClaudeCodeOtelSignalType,
} from "../src/main/otel/claude-code-otel-signal-contract.js";
import { deferred } from "./deferred.js";
import { runGitFixture } from "./helpers/git-fixture.js";
import { makeSession } from "./normalized-session-test-utils.js";
import {
  BOOT_NOW,
  linesStartingWith,
  makeStoreDir,
  type StoreDir,
} from "./sqlite-cov-iss11283-harness.js";

const UNTYPED_REJECTION_PREFIX =
  "claude-code otel signal 0 (untyped) rejected: ";
const CAPTURE_FAILED_PREFIX = "post-import repo identity capture failed: ";
const REFUSED = "iss11283 refused the repo row";
const ERROR_CLASS_PREFIX = /^\w*Error: /;

let store: StoreDir | undefined;
let repoDir: string | undefined;

afterEach(async () => {
  await store?.dispose();
  store = undefined;
  if (repoDir) {
    await rm(repoDir, { recursive: true, force: true });
    repoDir = undefined;
  }
});

describe("SqliteAgentDatabase facade closures (ISS-11283)", () => {
  it("names a rejected OTel signal with no type field as untyped", async () => {
    store = await makeStoreDir("otel-untyped");
    const { database, lines } = await store.boot();
    const signal: ClaudeCodeOtelSideTableSignal = {
      type: ClaudeCodeOtelSignalType.CostUsage,
      sessionId: "otel-session",
      model: "claude-sonnet-4-5",
      observedAt: BOOT_NOW,
      costUsd: 0.25,
    };
    // An IPC payload is not bound by the parameter type: drop the
    // discriminant the persister's warning reads the signal type from.
    Reflect.deleteProperty(signal, "type");

    const summary = await database.claudeCodeOtel.persistSignals([signal]);

    expect(summary).toEqual({ accepted: 0, rejected: 1 });
    const rejections = linesStartingWith(lines, UNTYPED_REJECTION_PREFIX);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.length).toBeGreaterThan(
      UNTYPED_REJECTION_PREFIX.length
    );
  });

  it("captures repo identity after an import whose cwd is a git work tree, and logs a capture that fails", async () => {
    repoDir = await mkdtemp(path.join(os.tmpdir(), "iss11283-repo-"));
    await runGitFixture(["init", "-q", repoDir]);
    store = await makeStoreDir("post-import");
    await store.seed([
      [
        `CREATE TRIGGER iss11283_refuse_repo BEFORE INSERT ON repos BEGIN SELECT RAISE(ABORT, '${REFUSED}'); END`,
      ],
    ]);
    const captureReported = deferred<string>();
    const captureLines: string[] = [];
    const { database } = await store.boot({
      resolveGitPath: () => "git",
      log: (message) => {
        if (message.startsWith(CAPTURE_FAILED_PREFIX)) {
          captureLines.push(message);
          captureReported.resolve(message);
        }
      },
    });

    await database.importer.importSession(
      makeSession({ sessionId: "post-import-session", cwd: repoDir }),
      Harness.Claude
    );
    const line = await captureReported.promise;

    expect(line).toContain(REFUSED);
    expect(line.slice(CAPTURE_FAILED_PREFIX.length)).not.toMatch(
      ERROR_CLASS_PREFIX
    );
    expect(captureLines).toEqual([line]);
    const repos = await database.prisma.client.$queryRawUnsafe<unknown[]>(
      "SELECT id FROM repos"
    );
    expect(repos).toEqual([]);
  });
});
