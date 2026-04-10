/**
 * Single-root contract tests: verify that route handlers read exclusively
 * from .closedloop-ai/work.
 *
 * Each test sets up a temp directory with .closedloop-ai/work/<file>,
 * calls the relevant route handler, and asserts the result reflects that data.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module-level mocks — must be declared before any dynamic imports
// ---------------------------------------------------------------------------

const mockGetWorktreeParentDir = vi.fn<() => string>();
const mockIsRepoAllowed = vi
  .fn<(path: string) => boolean>()
  .mockReturnValue(true);

vi.mock("@/lib/engineer/repos", () => ({
  expandHome: (p: string) => p,
  getWorktreeParentDir: () => mockGetWorktreeParentDir(),
  isRepoAllowed: (p: string) => mockIsRepoAllowed(p),
}));

// Suppress console output and avoid real activity reads inside route handlers
vi.mock("@/lib/engineer/jsonl-activity", () => ({
  readLiveActivity: vi.fn().mockResolvedValue(null),
}));

// process-utils: provide all exports, mocking isProcessRunning so routes don't
// signal real PIDs. readProcessPid uses the real filesystem (temp dirs).
vi.mock("@/lib/engineer/process-utils", () => ({
  readProcessPid: async (worktreeDir: string) => {
    const { existsSync } = await import("node:fs");
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const pidPath = join(worktreeDir, ".closedloop-ai", "work", "process.pid");
    if (!existsSync(pidPath)) {
      return null;
    }
    try {
      const content = await readFile(pidPath, "utf-8");
      const pid = Number.parseInt(content.trim(), 10);
      return Number.isNaN(pid) ? null : pid;
    } catch {
      return null;
    }
  },
  isProcessRunning: vi.fn().mockReturnValue(false),
  readLaunchMetadata: vi.fn().mockReturnValue(null),
  writeLaunchMetadata: vi.fn(),
  acquireLaunchLock: vi.fn().mockReturnValue(null),
  releaseLaunchLock: vi.fn(),
  cleanStaleLock: vi.fn(),
  getReviewPaths: (worktreeDir: string, provider: string) => {
    // Use node:path directly rather than the hoisted `join` import
    const nodePath = require("node:path") as typeof import("node:path");
    const workDir = nodePath.join(worktreeDir, ".closedloop-ai", "work");
    return {
      workDir,
      statePath: nodePath.join(workDir, `codex-review-${provider}.json`),
      logPath: nodePath.join(workDir, `codex-review-${provider}.log`),
      pidPath: nodePath.join(workDir, `codex-review-${provider}.pid`),
      findingsPath: nodePath.join(workDir, `review-findings-${provider}.json`),
    };
  },
}));

// ---------------------------------------------------------------------------
// Lazy-loaded route handlers (imported AFTER mocks are registered)
// ---------------------------------------------------------------------------

// Route files live inside Next.js dynamic segment directories ([ticketId]).
// Bare package specifiers with `[` characters are rejected by Node before Vite
// alias resolution runs. Relative path specifiers resolve correctly via the
// file:// URL scheme, which allows brackets. All `@/` imports inside the route
// files continue to resolve through Vite's module graph.

const { GET: symphonyStatusGET } = await import(
  "../../../app/api/engineer/symphony/status/[ticketId]/route"
);
const { POST: killPOST } = await import(
  "../../../app/api/engineer/symphony/kill/route"
);
const { GET: codexStatusGET } = await import(
  "../../../app/api/engineer/codex/status/[ticketId]/route"
);
const { DELETE: codexStopDELETE } = await import(
  "../../../app/api/engineer/codex/stop/[ticketId]/route"
);
const { GET: deployStatusGET } = await import(
  "../../../app/api/engineer/deploy/status/[ticketId]/route"
);

// ---------------------------------------------------------------------------
// Test lifecycle helpers
// ---------------------------------------------------------------------------

let testDir: string;
let worktreeParentDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "single-root-contract-"));
  worktreeParentDir = join(testDir, "worktrees");
  mkdirSync(worktreeParentDir, { recursive: true });
  mockGetWorktreeParentDir.mockReturnValue(worktreeParentDir);
  mockIsRepoAllowed.mockReturnValue(true);
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorktreeDir(repoName: string, ticketId: string): string {
  const sanitized = ticketId.replaceAll(/[^a-zA-Z0-9-_]/g, "_");
  const dir = join(worktreeParentDir, `${repoName}-${sanitized}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeToCanonical(
  worktreeDir: string,
  relPath: string,
  content: string
): void {
  const fullPath = join(worktreeDir, ".closedloop-ai", "work", relPath);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, content, "utf-8");
}

/**
 * Create a minimal request compatible with both the standard `Request` API
 * and the Next.js `NextRequest` shape (adds `nextUrl` for routes that use it).
 */
function makeRequest(urlPath: string, method = "GET", body?: unknown) {
  const url = new URL(`http://localhost:3000${urlPath}`);
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  const req = new Request(url.toString(), init);
  // Attach nextUrl so routes using request.nextUrl.searchParams work
  Object.defineProperty(req, "nextUrl", { get: () => url, enumerable: true });
  // Cast to any -- test requests don't need full NextRequest fidelity
  return req as any;
}

// ---------------------------------------------------------------------------
// 1. symphony/status/[ticketId] — GET reads state.json from .closedloop-ai/work
// ---------------------------------------------------------------------------

describe("single-root: symphony/status/[ticketId]", () => {
  it("returns state from .closedloop-ai/work/state.json", async () => {
    const repoName = "myrepo";
    const repoPath = join(testDir, repoName);
    mkdirSync(repoPath, { recursive: true });

    const worktreeDir = makeWorktreeDir(repoName, "SR-1");

    writeToCanonical(
      worktreeDir,
      "state.json",
      JSON.stringify({
        status: "COMPLETED",
        phase: "Done",
        timestamp: new Date().toISOString(),
      })
    );

    const request = makeRequest(
      `/api/engineer/symphony/status/SR-1?repo=${encodeURIComponent(repoPath)}`
    );
    const response = await symphonyStatusGET(request, {
      params: Promise.resolve({ ticketId: "SR-1" }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      phase: string;
      stateExists: boolean;
    };
    expect(body.stateExists).toBe(true);
    expect(body.status).toBe("COMPLETED");
    expect(body.phase).toBe("Done");
  });
});

// ---------------------------------------------------------------------------
// 2. symphony/kill — POST writes STOPPED state to .closedloop-ai/work
// ---------------------------------------------------------------------------

describe("single-root: symphony/kill", () => {
  it("marks state as STOPPED in .closedloop-ai/work", async () => {
    const repoName = "myrepo";
    const repoPath = join(testDir, repoName);
    mkdirSync(repoPath, { recursive: true });

    makeWorktreeDir(repoName, "SR-4");

    const request = makeRequest("/api/engineer/symphony/kill", "POST", {
      ticketId: "SR-4",
      repoPath,
    });
    await killPOST(request);

    // The kill route must write STOPPED state into .closedloop-ai/work
    const worktreeDir = join(worktreeParentDir, `${repoName}-SR-4`);
    const canonicalStatePath = join(
      worktreeDir,
      ".closedloop-ai",
      "work",
      "state.json"
    );

    const { existsSync, readFileSync } = await import("node:fs");
    expect(existsSync(canonicalStatePath)).toBe(true);

    const state = JSON.parse(readFileSync(canonicalStatePath, "utf-8")) as {
      status: string;
    };
    expect(state.status).toBe("STOPPED");
  });
});

// ---------------------------------------------------------------------------
// 3. codex/status/[ticketId] — GET reads review state from .closedloop-ai/work
// ---------------------------------------------------------------------------

describe("single-root: codex/status/[ticketId]", () => {
  it("reads review state from .closedloop-ai/work", async () => {
    const repoName = "myrepo";
    const repoPath = join(testDir, repoName);
    mkdirSync(repoPath, { recursive: true });

    const worktreeDir = makeWorktreeDir(repoName, "SR-6");

    writeToCanonical(
      worktreeDir,
      "codex-review-codex.json",
      JSON.stringify({
        status: "completed",
        provider: "codex",
        startedAt: new Date().toISOString(),
        config: {
          model: "o3",
          reasoningEffort: "medium",
          reviewMode: "uncommitted",
          baseBranch: "main",
        },
      })
    );

    const request = makeRequest(
      `/api/engineer/codex/status/SR-6?repo=${encodeURIComponent(repoPath)}&provider=codex`
    );
    const response = await codexStatusGET(request, {
      params: Promise.resolve({ ticketId: "SR-6" }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      hasReview: boolean;
      status: string;
    };
    expect(body.hasReview).toBe(true);
    expect(body.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// 4. codex/stop/[ticketId] — DELETE deletes from .closedloop-ai/work
// ---------------------------------------------------------------------------

describe("single-root: codex/stop/[ticketId] DELETE (deleteReviewFiles)", () => {
  it("deletes files from .closedloop-ai/work", async () => {
    const repoName = "myrepo";
    const repoPath = join(testDir, repoName);
    mkdirSync(repoPath, { recursive: true });

    const worktreeDir = makeWorktreeDir(repoName, "SR-7");

    const canonicalFile = "codex-review-claude.json";

    writeToCanonical(
      worktreeDir,
      canonicalFile,
      JSON.stringify({
        status: "completed",
        startedAt: new Date().toISOString(),
        config: {
          model: "claude",
          reasoningEffort: "medium",
          reviewMode: "uncommitted",
          baseBranch: "main",
        },
      })
    );

    const request = makeRequest(
      `/api/engineer/codex/stop/SR-7?repo=${encodeURIComponent(repoPath)}&provider=claude`
    );
    const response = await codexStopDELETE(request, {
      params: Promise.resolve({ ticketId: "SR-7" }),
    });

    expect(response.status).toBe(200);

    const { existsSync } = await import("node:fs");
    // Canonical file must be deleted
    const canonicalPath = join(
      worktreeDir,
      ".closedloop-ai",
      "work",
      canonicalFile
    );
    expect(existsSync(canonicalPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. deploy/status/[ticketId] — GET reads deploy artifacts from .closedloop-ai/work
// ---------------------------------------------------------------------------

describe("single-root: deploy/status/[ticketId]", () => {
  it("reads deploy.log from .closedloop-ai/work", async () => {
    const repoName = "myrepo";
    const repoPath = join(testDir, repoName);
    mkdirSync(repoPath, { recursive: true });

    const worktreeDir = makeWorktreeDir(repoName, "SR-8");

    writeToCanonical(
      worktreeDir,
      "deploy.log",
      "canonical deploy log line 1\n"
    );

    const request = makeRequest(
      `/api/engineer/deploy/status/SR-8?repo=${encodeURIComponent(repoPath)}`
    );
    const response = await deployStatusGET(request, {
      params: Promise.resolve({ ticketId: "SR-8" }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { logs: string; status: string };

    expect(body.logs).toContain("canonical deploy log");
  });

  it("reads deploy-result.json from .closedloop-ai/work", async () => {
    const repoName = "myrepo";
    const repoPath = join(testDir, repoName);
    mkdirSync(repoPath, { recursive: true });

    const worktreeDir = makeWorktreeDir(repoName, "SR-10");

    writeToCanonical(
      worktreeDir,
      "deploy-result.json",
      JSON.stringify({
        url: "https://canonical.example.com",
        serviceId: "svc-canonical",
      })
    );

    const request = makeRequest(
      `/api/engineer/deploy/status/SR-10?repo=${encodeURIComponent(repoPath)}`
    );
    const response = await deployStatusGET(request, {
      params: Promise.resolve({ ticketId: "SR-10" }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      deployedUrl: string;
      serviceId: string;
    };
    expect(body.deployedUrl).toBe("https://canonical.example.com");
    expect(body.serviceId).toBe("svc-canonical");
  });
});
