/**
 * @file tcc-protected-attribution-wiring.test.ts
 * @description ISS-11914: session attribution and repo-identity capture must not
 * read a file or spawn `git` under a TCC-protected cwd (~/Documents,
 * ~/Library/CloudStorage, …), which raises a macOS permission prompt. Each case
 * drives the production entry point against a real git checkout with real
 * Engineer launch metadata, under a fake home, and counts `git` spawns through
 * a shim. The control cases prove the same fixture resolves outside a protected
 * folder, so a passing protected case is not a fixture that could never resolve.
 */
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import {
  resolveSessionAttribution,
  resolveSessionAttributionWithSourceAsync,
} from "../src/main/agent-sync/agent-session-attribution.js";
import {
  AttributionRepoSource,
  resetAttributionPathMemo,
  resolveAttributionRepoFullName,
  revalidateAttributionRepoFullName,
} from "../src/main/agent-sync/attribution-path-memo.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import { captureRepoIdentity } from "../src/main/enrichment/repo-identity.js";
import { configureBinaryPathsResolver } from "../src/server/operations/binary-path-overrides.js";
import {
  type RepoFullNameOutcome,
  RepoFullNameStatus,
} from "../src/server/operations/git-helpers.js";
import {
  emptyAttributionCache,
  initGitRepoWithOrigin,
  readShimCount,
  writeCountingGitShim,
} from "./attribution-test-helpers.js";

const ORG_REPO = "acme/widget";
// `loopId` is the field launch metadata from builds before ISS-12435 carried;
// attribution no longer forwards it.
const LAUNCH = { artifactId: "ISS-1", loopId: "loop-1", baseBranch: "main" };
const NOW = "2026-10-06T12:00:00.000Z";
const PROTECTED_CHECKOUTS = [
  ["Documents", "proj"],
  ["Library", "CloudStorage", "Dropbox", "proj"],
];

let fakeHome: string;
let shim: string;

beforeEach(async () => {
  fakeHome = realpathSync(
    await mkdtemp(path.join(os.tmpdir(), "iss11914-home-"))
  );
  vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
  shim = writeCountingGitShim(fakeHome, "git-shim");
  configureBinaryPathsResolver(() => ({ git: shim }));
  resetAttributionPathMemo();
});

afterEach(async () => {
  vi.restoreAllMocks();
  configureBinaryPathsResolver(null);
  resetAttributionPathMemo();
  await rm(fakeHome, { recursive: true, force: true });
});

describe("session attribution under a TCC-protected cwd", () => {
  for (const segments of PROTECTED_CHECKOUTS) {
    const label = segments.join("/");

    test(`sync resolver keeps the cwd but reads no metadata and runs no git (~/${label})`, () => {
      const checkout = seedCheckout(segments);

      const attribution = resolveSessionAttribution(
        path.join(checkout, "src"),
        emptyAttributionCache()
      );

      assert.deepEqual(attribution, attributionAt(checkout));
      assert.equal(readShimCount(shim), 0);
    });

    test(`async resolver keeps the cwd but reads no metadata and runs no git (~/${label})`, async () => {
      const checkout = seedCheckout(segments);

      const { attribution } = await resolveSessionAttributionWithSourceAsync(
        path.join(checkout, "src"),
        emptyAttributionCache()
      );

      assert.deepEqual(attribution, attributionAt(checkout));
      assert.equal(readShimCount(shim), 0);
    });
  }

  test("a cwd that reaches a protected checkout through a symlink reads no metadata and runs no git", async () => {
    const checkout = seedCheckout(["Documents", "proj"]);
    const link = path.join(fakeHome, "code", "link");
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(checkout, link);

    assert.deepEqual(
      resolveSessionAttribution(
        path.join(link, "src"),
        emptyAttributionCache()
      ),
      attributionAt(link)
    );
    const { attribution } = await resolveSessionAttributionWithSourceAsync(
      path.join(link, "src"),
      emptyAttributionCache()
    );
    assert.deepEqual(attribution, attributionAt(link));
    assert.equal(readShimCount(shim), 0);
  });

  test("control: the same checkout outside a protected folder resolves both ways", async () => {
    const checkout = seedCheckout(["code", "proj"]);
    const resolved = {
      repositoryFullName: ORG_REPO,
      worktreePath: checkout,
      sourceArtifactId: LAUNCH.artifactId,
      baseBranch: LAUNCH.baseBranch,
    };

    assert.deepEqual(
      resolveSessionAttribution(
        path.join(checkout, "src"),
        emptyAttributionCache()
      ),
      resolved
    );
    assert.equal(readShimCount(shim), 1);
    const { attribution } = await resolveSessionAttributionWithSourceAsync(
      path.join(checkout, "src"),
      emptyAttributionCache()
    );
    assert.deepEqual(attribution, resolved);
    assert.equal(readShimCount(shim), 2);
  });
});

describe("attribution path memo under a TCC-protected path", () => {
  test("resolve and revalidate never call the git loader", async () => {
    const { load, calls } = recordingLoader();
    const now = Date.now();

    for (const repoPath of [
      path.join(fakeHome, "Documents", "proj"),
      "/Volumes/External/proj",
    ]) {
      assert.deepEqual(
        await resolveAttributionRepoFullName(repoPath, now, load),
        {
          repositoryFullName: null,
          source: AttributionRepoSource.Live,
        }
      );
      assert.equal(
        await revalidateAttributionRepoFullName(repoPath, now, load),
        null
      );
    }
    assert.deepEqual(calls, []);

    const unprotected = path.join(fakeHome, "code", "proj");
    assert.equal(
      await revalidateAttributionRepoFullName(unprotected, now, load),
      ORG_REPO
    );
    assert.deepEqual(calls, [unprotected]);
  });
});

describe("repo identity capture under a TCC-protected cwd", () => {
  test("returns the empty identity without running git or writing", async () => {
    const checkout = seedCheckout(["Downloads", "proj"]);
    const { prisma, write } = recordingPrisma();

    assert.deepEqual(await captureRepoIdentity(shim, checkout, prisma, NOW), {
      repoId: null,
      gitDir: null,
      repoFullName: null,
      isWorktree: false,
    });
    assert.equal(readShimCount(shim), 0);
    assert.equal(write.mock.calls.length, 0);
  });

  test("control: the same checkout outside a protected folder is captured", async () => {
    const checkout = seedCheckout(["code", "proj"]);
    const { prisma, write } = recordingPrisma();

    const result = await captureRepoIdentity(shim, checkout, prisma, NOW);

    assert.equal(result.repoFullName, ORG_REPO);
    assert.ok(readShimCount(shim) > 0);
    assert.equal(write.mock.calls.length, 1);
  });
});

/** A git checkout with an `origin` and Engineer launch metadata under the fake home. */
function seedCheckout(segments: string[]): string {
  const dir = path.join(fakeHome, ...segments);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  initGitRepoWithOrigin(dir, ORG_REPO);
  const workDir = path.join(dir, ".closedloop-ai", "work");
  mkdirSync(workDir, { recursive: true });
  writeFileSync(
    path.join(workDir, "launch-metadata.json"),
    JSON.stringify(LAUNCH)
  );
  return dir;
}

/** What attribution keeps when it may not look inside the checkout. */
function attributionAt(worktreePath: string) {
  return {
    repositoryFullName: null,
    worktreePath,
    sourceArtifactId: null,
    baseBranch: null,
  };
}

function recordingLoader(): {
  load: (repoPath: string) => Promise<RepoFullNameOutcome>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    load: (repoPath) => {
      calls.push(repoPath);
      return Promise.resolve({
        status: RepoFullNameStatus.Resolved,
        repoFullName: ORG_REPO,
      });
    },
  };
}

function recordingPrisma() {
  const write = vi.fn(
    (run: (client: { $queryRawUnsafe: () => Promise<unknown> }) => unknown) =>
      run({ $queryRawUnsafe: async () => [{ id: "repo-1" }] })
  );
  return { prisma: { write } as unknown as DesktopPrisma, write };
}
