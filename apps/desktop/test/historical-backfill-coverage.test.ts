/**
 * @file historical-backfill-coverage.test.ts
 * @description ISS-10308 behavior pins for
 * `src/main/enrichment/historical-backfill.ts`: the fallback chain one
 * backfill candidate walks (live cwd capture, mined repo name, ancestor walk,
 * sibling heuristic) and what each step asks the filesystem, the DB, and git.
 *
 * The SQL anti-join that selects candidates is covered against a real migrated
 * store by `enrichment-repo-identity.test.ts`. Here the candidate rows come from
 * a fake `$queryRawUnsafe`, and every repo-identity / git / log collaborator is
 * a double driven by an in-memory "world", so each case can assert exactly
 * which paths were probed and with which arguments. Pins CURRENT behavior; does
 * not fix source.
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, test, vi } from "vitest";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import { runHistoricalBackfill } from "../src/main/enrichment/historical-backfill.js";
import type {
  IdentityCaptureResult,
  RepoRow,
} from "../src/main/enrichment/repo-identity.js";

const mocks = vi.hoisted(() => ({
  cwdExists: vi.fn<(path: string) => Promise<boolean>>(),
  captureRepoIdentity:
    vi.fn<
      (
        gitPath: string,
        cwd: string,
        prisma: unknown,
        now: string
      ) => Promise<IdentityCaptureResult>
    >(),
  isKnownRepoPath: vi.fn<(prisma: unknown, path: string) => Promise<boolean>>(),
  resolveRepoByFullName:
    vi.fn<(prisma: unknown, fullName: string) => Promise<RepoRow | null>>(),
  resolveRepoForCwd:
    vi.fn<(prisma: unknown, cwd: string) => Promise<RepoRow | null>>(),
  isInsideWorkTree: vi.fn<(gitPath: string, cwd: string) => Promise<boolean>>(),
  writePersistentLog:
    vi.fn<(level: string, tag: string, msg: string) => void>(),
}));

vi.mock("../src/main/enrichment/repo-identity.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  captureRepoIdentity: mocks.captureRepoIdentity,
  cwdExists: mocks.cwdExists,
  isKnownRepoPath: mocks.isKnownRepoPath,
  resolveRepoByFullName: mocks.resolveRepoByFullName,
  resolveRepoForCwd: mocks.resolveRepoForCwd,
}));
vi.mock("../src/main/enrichment/git-exec.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isInsideWorkTree: mocks.isInsideWorkTree,
}));
vi.mock("../src/main/logging/durable-log-sink.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  writePersistentLog: mocks.writePersistentLog,
}));

const GIT = "/usr/bin/git-for-test";
const NOW = "2026-09-15T12:00:00.000Z";

type Candidate = { cwd: string | null; metadata?: string | null };

/** What the doubles report, keyed by path. Reset before every case. */
type World = {
  existing: Set<string>;
  known: Set<string>;
  git: Map<string, boolean | Error | string>;
  reposByCwd: Map<string, RepoRow>;
  reposByName: Map<string, RepoRow>;
};

let world: World;
let queryRawUnsafe: ReturnType<typeof vi.fn>;
let prisma: DesktopPrisma;

function repoRow(id: string): RepoRow {
  return {
    id,
    git_dir: `/repos/${id}/.git`,
    remote_url: null,
    repo_full_name: null,
    default_branch: null,
    last_seen_at: NOW,
    created_at: NOW,
  };
}

function capturedFor(cwd: string): IdentityCaptureResult {
  return {
    repoId: `captured:${cwd}`,
    gitDir: `${cwd}/.git`,
    repoFullName: null,
    isWorktree: false,
  };
}

function run(candidates: Candidate[], batchSize = 50): Promise<number> {
  const rows = candidates.map((c, i) => ({
    session_id: `s-${i}`,
    cwd: c.cwd,
    harness: null,
    metadata: c.metadata ?? null,
    started_at: NOW,
  }));
  queryRawUnsafe.mockImplementation(
    async (_sql: string, limit: number, offset: number) =>
      rows.slice(offset, offset + limit)
  );
  return runHistoricalBackfill(GIT, prisma, batchSize, NOW);
}

function existsCalls(): string[] {
  return mocks.cwdExists.mock.calls.map(([p]) => p);
}

beforeEach(() => {
  world = {
    existing: new Set(),
    known: new Set(),
    git: new Map(),
    reposByCwd: new Map(),
    reposByName: new Map(),
  };
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
  mocks.cwdExists.mockImplementation(async (p) => world.existing.has(p));
  mocks.isKnownRepoPath.mockImplementation(async (_db, p) =>
    world.known.has(p)
  );
  mocks.resolveRepoForCwd.mockImplementation(
    async (_db, p) => world.reposByCwd.get(p) ?? null
  );
  mocks.resolveRepoByFullName.mockImplementation(
    async (_db, name) => world.reposByName.get(name) ?? null
  );
  mocks.isInsideWorkTree.mockImplementation((_git, p) => {
    const outcome = world.git.get(p) ?? false;
    return typeof outcome === "boolean"
      ? Promise.resolve(outcome)
      : Promise.reject(outcome);
  });
  mocks.captureRepoIdentity.mockImplementation(async (_git, cwd) =>
    capturedFor(cwd)
  );
  queryRawUnsafe = vi.fn();
  prisma = {
    client: { $queryRawUnsafe: queryRawUnsafe },
  } as unknown as DesktopPrisma;
});

describe("runHistoricalBackfill candidate loop", () => {
  test("binds batchSize and a zero offset, and returns 0 for no candidates", async () => {
    assert.equal(await run([], 7), 0);
    assert.equal(queryRawUnsafe.mock.calls.length, 1);
    assert.deepEqual(queryRawUnsafe.mock.calls[0]?.slice(1), [7, 0]);
  });

  test("counts only the candidates that resolved", async () => {
    world.existing.add("/live/one");
    world.existing.add("/live/two");

    assert.equal(
      await run([
        { cwd: "/live/one" },
        { cwd: "/gone/x" },
        { cwd: "/live/two" },
      ]),
      2
    );
  });

  test("skips an empty-string cwd without probing anything", async () => {
    assert.equal(await run([{ cwd: "" }]), 0);
    assert.deepEqual(existsCalls(), []);
  });
});

describe("step 1: the session cwd still exists", () => {
  test("captures identity at the cwd itself and stops", async () => {
    world.existing.add("/live/proj");

    assert.equal(await run([{ cwd: "/live/proj", metadata: "--repo a/b" }]), 1);
    assert.deepEqual(mocks.captureRepoIdentity.mock.calls, [
      [GIT, "/live/proj", prisma, NOW],
    ]);
    assert.equal(mocks.resolveRepoByFullName.mock.calls.length, 0);
    assert.deepEqual(existsCalls(), ["/live/proj"]);
  });

  // Pins current behavior; looks odd because a cwd that exists but is not a git
  // work tree yields the EMPTY identity (repoId null), and that object is
  // truthy, so the session is still counted as resolved.
  test("counts a capture that returned the empty identity as resolved", async () => {
    world.existing.add("/live/not-a-repo");
    mocks.captureRepoIdentity.mockResolvedValue({
      repoId: null,
      gitDir: null,
      repoFullName: null,
      isWorktree: false,
    });

    assert.equal(await run([{ cwd: "/live/not-a-repo" }]), 1);
  });

  test("falls through to the mined repo name when capture throws", async () => {
    world.existing.add("/live/broken");
    world.reposByName.set("acme/widget", repoRow("widget"));
    mocks.captureRepoIdentity.mockRejectedValue(new Error("git exploded"));

    assert.equal(
      await run([{ cwd: "/live/broken", metadata: "--repo Acme/Widget" }]),
      1
    );
    assert.deepEqual(mocks.resolveRepoByFullName.mock.calls, [
      [prisma, "acme/widget"],
    ]);
  });
});

describe("step 2: repo full name mined from metadata", () => {
  const MINING_CASES: ReadonlyArray<readonly [label: string, meta: string]> = [
    ["prRepository key", `{"prRepository":"Acme/Widget.git"}`],
    ["--repo flag", "gh pr view 12 --repo Acme/Widget.git"],
    ["origin ssh remote", "origin\tgit@github.com:Acme/Widget.git (fetch)"],
    [
      "fatal clone error",
      "fatal: repository 'https://github.com/Acme/Widget/'",
    ],
    ["repoFullName key", "{repoFullName: 'Acme/Widget'}"],
    ["github URL", "see https://github.com/Acme/Widget/pull/12"],
  ];

  for (const [label, meta] of MINING_CASES) {
    test(`mines a lowercased owner/repo from a ${label}`, async () => {
      world.reposByName.set("acme/widget", repoRow("widget"));

      assert.equal(await run([{ cwd: "/gone/p", metadata: meta }]), 1);
      assert.deepEqual(mocks.resolveRepoByFullName.mock.calls, [
        [prisma, "acme/widget"],
      ]);
      // A mined hit returns before the ancestor walk.
      assert.deepEqual(existsCalls(), ["/gone/p"]);
    });
  }

  test("uses the first pattern in its list, not the first match in the text", async () => {
    await run([
      {
        cwd: "/gone/p",
        metadata: `{"repoFullName":"Second/Two","prRepository":"First/One"}`,
      },
    ]);
    assert.deepEqual(mocks.resolveRepoByFullName.mock.calls, [
      [prisma, "first/one"],
    ]);
  });

  for (const metadata of [null, "no repository mentioned here"]) {
    test(`does not query by name for metadata ${JSON.stringify(metadata)}`, async () => {
      assert.equal(await run([{ cwd: "/gone/p", metadata }]), 0);
      assert.equal(mocks.resolveRepoByFullName.mock.calls.length, 0);
    });
  }

  test("continues to the ancestor walk when the mined name is unknown", async () => {
    assert.equal(await run([{ cwd: "/gone/a/b", metadata: "--repo x/y" }]), 0);
    assert.deepEqual(mocks.resolveRepoByFullName.mock.calls, [[prisma, "x/y"]]);
    assert.deepEqual(existsCalls(), ["/gone/a/b", "/gone/a", "/gone", ""]);
  });
});

describe("step 3: ancestor walk", () => {
  // Pins current behavior; looks odd because the last "ancestor" probed for an
  // absolute cwd is the empty string, not "/", so the filesystem root is never
  // checked.
  test("probes each parent from nearest to the empty-string root", async () => {
    assert.equal(await run([{ cwd: "/gone/a/b" }]), 0);
    assert.deepEqual(existsCalls(), ["/gone/a/b", "/gone/a", "/gone", ""]);
    assert.equal(mocks.resolveRepoForCwd.mock.calls.length, 0);
  });

  test("returns a repo already registered for an existing ancestor", async () => {
    world.existing.add("/work/app");
    world.reposByCwd.set("/work/app", repoRow("app"));

    assert.equal(await run([{ cwd: "/work/app/src" }]), 1);
    assert.deepEqual(mocks.resolveRepoForCwd.mock.calls, [
      [prisma, "/work/app"],
    ]);
    assert.equal(mocks.isKnownRepoPath.mock.calls.length, 0);
    assert.deepEqual(existsCalls(), ["/work/app/src", "/work/app"]);
  });

  test("skips an existing ancestor Desktop does not track, without running git", async () => {
    world.existing.add("/work/app");
    world.existing.add("/work");

    assert.equal(await run([{ cwd: "/work/app/src" }]), 0);
    assert.deepEqual(mocks.isKnownRepoPath.mock.calls, [
      [prisma, "/work/app"],
      [prisma, "/work"],
    ]);
    assert.equal(mocks.isInsideWorkTree.mock.calls.length, 0);
  });

  test("captures identity at a tracked ancestor that is a git work tree", async () => {
    world.existing.add("/work/app");
    world.known.add("/work/app");
    world.git.set("/work/app", true);

    assert.equal(await run([{ cwd: "/work/app/src" }]), 1);
    assert.deepEqual(mocks.isInsideWorkTree.mock.calls, [[GIT, "/work/app"]]);
    assert.deepEqual(mocks.captureRepoIdentity.mock.calls, [
      [GIT, "/work/app", prisma, NOW],
    ]);
  });

  test("moves on to the next ancestor when a tracked ancestor is not a work tree", async () => {
    world.existing.add("/work/app");
    world.existing.add("/work");
    world.known.add("/work/app");
    world.known.add("/work");
    world.git.set("/work", true);

    assert.equal(await run([{ cwd: "/work/app/src" }]), 1);
    assert.deepEqual(mocks.isInsideWorkTree.mock.calls, [
      [GIT, "/work/app"],
      [GIT, "/work"],
    ]);
    assert.deepEqual(mocks.captureRepoIdentity.mock.calls, [
      [GIT, "/work", prisma, NOW],
    ]);
  });

  const GIT_FAILURES: ReadonlyArray<
    readonly [thrown: Error | string, text: string]
  > = [
    [new Error("spawn EACCES"), "spawn EACCES"],
    ["plain string failure", "plain string failure"],
  ];

  for (const [thrown, text] of GIT_FAILURES) {
    test(`logs and stops the walk when git throws ${JSON.stringify(text)} at a tracked ancestor`, async () => {
      world.existing.add("/work/app");
      world.existing.add("/work");
      world.known.add("/work/app");
      world.known.add("/work");
      world.git.set("/work/app", thrown);
      world.git.set("/work", true);

      assert.equal(await run([{ cwd: "/work/app/src" }]), 0);
      assert.deepEqual(mocks.writePersistentLog.mock.calls, [
        [
          "warn",
          "backfill",
          `walkAncestors: isInsideWorkTree failed for known repo /work/app: ${text}`,
        ],
      ]);
      assert.deepEqual(mocks.isInsideWorkTree.mock.calls, [[GIT, "/work/app"]]);
      assert.equal(mocks.captureRepoIdentity.mock.calls.length, 0);
    });
  }
});

describe("step 4: sibling-checkout heuristic", () => {
  test("strips a ticket worktree suffix and captures the tracked base checkout", async () => {
    world.existing.add("/w/proj");
    world.known.add("/w/proj");
    world.git.set("/w/proj", true);

    assert.equal(await run([{ cwd: "/w/proj-fix-42" }]), 1);
    assert.deepEqual(existsCalls(), ["/w/proj-fix-42", "/w", "", "/w/proj"]);
    assert.deepEqual(mocks.captureRepoIdentity.mock.calls, [
      [GIT, "/w/proj", prisma, NOW],
    ]);
  });

  test("prefers the ticket-suffix base over the last-dash base", async () => {
    for (const base of ["/w/my-app", "/w/my-app-fix"]) {
      world.existing.add(base);
      world.known.add(base);
      world.git.set(base, true);
    }

    assert.equal(await run([{ cwd: "/w/my-app-fix-7" }]), 1);
    assert.deepEqual(mocks.captureRepoIdentity.mock.calls, [
      [GIT, "/w/my-app", prisma, NOW],
    ]);
  });

  test("falls back to stripping the last dash segment", async () => {
    world.existing.add("/w/proj");
    world.known.add("/w/proj");
    world.git.set("/w/proj", true);

    assert.equal(await run([{ cwd: "/w/proj-scratch" }]), 1);
    assert.deepEqual(mocks.captureRepoIdentity.mock.calls, [
      [GIT, "/w/proj", prisma, NOW],
    ]);
  });

  for (const cwd of ["/w/plain", "/w/my-proj/sub"]) {
    test(`probes no sibling for ${cwd} (no dash in the last segment)`, async () => {
      assert.equal(await run([{ cwd }]), 0);
      assert.equal(existsCalls().length, cwd.split("/").length);
      assert.equal(mocks.isKnownRepoPath.mock.calls.length, 0);
    });
  }

  test("returns null when the base checkout does not exist", async () => {
    world.known.add("/w/proj");

    assert.equal(await run([{ cwd: "/w/proj-feature" }]), 0);
    assert.deepEqual(existsCalls(), ["/w/proj-feature", "/w", "", "/w/proj"]);
    assert.equal(mocks.isKnownRepoPath.mock.calls.length, 0);
  });

  test("does not run git against an existing base Desktop does not track", async () => {
    world.existing.add("/w/proj");
    world.git.set("/w/proj", true);

    assert.equal(await run([{ cwd: "/w/proj-feature" }]), 0);
    assert.deepEqual(mocks.isKnownRepoPath.mock.calls, [[prisma, "/w/proj"]]);
    assert.equal(mocks.isInsideWorkTree.mock.calls.length, 0);
  });

  test("returns null when the tracked base is not a work tree", async () => {
    world.existing.add("/w/proj");
    world.known.add("/w/proj");

    assert.equal(await run([{ cwd: "/w/proj-feature" }]), 0);
    assert.deepEqual(mocks.isInsideWorkTree.mock.calls, [[GIT, "/w/proj"]]);
    assert.equal(mocks.captureRepoIdentity.mock.calls.length, 0);
  });

  for (const [thrown, text] of [
    [new Error("git timed out"), "git timed out"],
    [404, "404"],
  ] as const) {
    test(`logs and gives up when git throws ${JSON.stringify(text)} at the tracked base`, async () => {
      world.existing.add("/w/proj");
      world.known.add("/w/proj");
      mocks.isInsideWorkTree.mockRejectedValue(thrown);

      assert.equal(await run([{ cwd: "/w/proj-feature" }]), 0);
      assert.deepEqual(mocks.writePersistentLog.mock.calls, [
        [
          "warn",
          "backfill",
          `trySiblingHeuristic: isInsideWorkTree failed for known repo /w/proj: ${text}`,
        ],
      ]);
      assert.equal(mocks.captureRepoIdentity.mock.calls.length, 0);
    });
  }
});

// ISS-11914: no `git` runs inside a TCC-protected folder, where it would raise a
// macOS permission prompt. `/Volumes` is protected regardless of the home dir.
describe("TCC-protected cwds", () => {
  test("skips capture at an existing protected cwd and attributes from the transcript", async () => {
    world.existing.add("/Volumes/ext/proj");
    world.reposByName.set("acme/widget", repoRow("widget"));

    assert.equal(
      await run([{ cwd: "/Volumes/ext/proj", metadata: "--repo acme/widget" }]),
      1
    );
    assert.equal(mocks.captureRepoIdentity.mock.calls.length, 0);
    assert.deepEqual(mocks.resolveRepoByFullName.mock.calls, [
      [prisma, "acme/widget"],
    ]);
  });

  test("does not walk from a protected cwd into a parent repo", async () => {
    const home = os.homedir();
    world.existing.add(path.join(home, "Documents", "app"));
    world.existing.add(home);
    world.known.add(home);
    world.git.set(home, true);
    world.reposByCwd.set(home, repoRow("dotfiles"));

    assert.equal(
      await run([{ cwd: path.join(home, "Documents", "app", "src") }]),
      0
    );
    assert.equal(mocks.resolveRepoForCwd.mock.calls.length, 0);
    assert.equal(mocks.isInsideWorkTree.mock.calls.length, 0);
    assert.equal(mocks.captureRepoIdentity.mock.calls.length, 0);
  });

  // A cwd spelled with `..` resolves outside the protected folder, so it reaches
  // the walk, which then passes back through the folder lexically.
  test("stops at a tracked protected ancestor instead of running git or falling through", async () => {
    const home = os.homedir();
    const tracked = path.join(home, "Documents", "app");
    world.existing.add(tracked);
    world.existing.add(home);
    world.known.add(tracked);
    world.known.add(home);
    world.git.set(home, true);

    assert.equal(await run([{ cwd: `${tracked}/../../gone/src` }]), 0);
    assert.equal(mocks.isInsideWorkTree.mock.calls.length, 0);
    assert.equal(mocks.captureRepoIdentity.mock.calls.length, 0);
  });

  test("does not run git against a tracked sibling base in a protected folder", async () => {
    world.existing.add("/Volumes/ext/proj");
    world.known.add("/Volumes/ext/proj");
    world.git.set("/Volumes/ext/proj", true);

    assert.equal(await run([{ cwd: "/Volumes/ext/proj-feat-12" }]), 0);
    assert.equal(mocks.isInsideWorkTree.mock.calls.length, 0);
    assert.equal(mocks.captureRepoIdentity.mock.calls.length, 0);
  });

  test("pages past protected sessions so they cannot hold older ones back", async () => {
    const protectedCwds = [
      "/Volumes/ext/a",
      "/Volumes/ext/b",
      "/Volumes/ext/c",
    ];
    const olderCwds = ["/live/old-1", "/live/old-2", "/live/old-3"];
    for (const cwd of [...protectedCwds, ...olderCwds]) {
      world.existing.add(cwd);
    }

    await run(
      [
        ...protectedCwds.map((cwd) => ({
          cwd,
          metadata: "--repo acme/widget",
        })),
        ...olderCwds.map((cwd) => ({ cwd })),
      ],
      2
    );

    // Every protected session was still tried from its transcript, and the
    // batch of 2 went to the first two sessions it can capture.
    assert.equal(mocks.resolveRepoByFullName.mock.calls.length, 3);
    assert.deepEqual(
      mocks.captureRepoIdentity.mock.calls.map(([, cwd]) => cwd),
      ["/live/old-1", "/live/old-2"]
    );
  });
});
