import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "node:test";
import type { Harness, RunOpts, RunResult } from "@repo/crewd";
import { HarnessName } from "@repo/crewd/model";
import type { AuditWorkspace } from "@repo/crewd/passes/audit-workspace";
import type { Finding } from "@repo/crewd/passes/findings";
import { vi } from "vitest";
import { AuditService } from "../src/main/audit/audit-service.js";
import {
  AUDIT_DOCS_DARWIN_TAG,
  AuditFileFailureReason,
  AuditRunFailureReason,
} from "../src/shared/audit-contract.js";
import { stubHarnessBase } from "./helpers/crewd-harness-stub.js";

/**
 * A stub disposable-workspace factory: records the repo it was asked to copy,
 * returns a caller-supplied throwaway dir, and tracks disposal. Keeps the suite
 * hermetic (no real git worktree / fs copy) while proving the service routes
 * the cascade at the workspace copy and always disposes it.
 */
function stubWorkspace(workspaceDir: string) {
  const calls: { repoDir: string }[] = [];
  let disposed = 0;
  const prepareWorkspace = (repoDir: string): Promise<AuditWorkspace> => {
    calls.push({ repoDir });
    return Promise.resolve({
      dir: workspaceDir,
      isGitWorktree: false,
      dispose: () => {
        disposed++;
        return Promise.resolve();
      },
    });
  };
  return {
    prepareWorkspace,
    calls,
    disposedCount: () => disposed,
  };
}

const FINDINGS_JSONL_RE = /write one JSON finding per line to (\S+)/;
const MISSING_PROMPT_RE = /character prompt not found/;
const BOOM_RE = /boom/;
const SIG_STALE_RE = /sig:stale/;

function res(partial: Partial<RunResult>): RunResult {
  return {
    ok: false,
    exitCode: 1,
    signal: null,
    timedOut: false,
    durationMs: 2,
    outputTail: "",
    ...partial,
  };
}

/** A harness that writes findings JSONL where the runtime context points, then succeeds. */
function writingHarness(
  name: HarnessName,
  lines: string[],
  onRun?: (o: RunOpts) => void
): Harness {
  return {
    ...stubHarnessBase(name),
    isAvailable: async () => true,
    run: (o: RunOpts) => {
      onRun?.(o);
      const m = o.prompt.match(FINDINGS_JSONL_RE);
      const path = m?.[1];
      if (!path) {
        throw new Error("prompt did not carry a findings path");
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
      return Promise.resolve(res({ ok: true, exitCode: 0 }));
    },
  };
}

function unavailableHarness(name: HarnessName): Harness {
  return {
    ...stubHarnessBase(name),
    isAvailable: async () => false,
    run: async () => res({}),
  };
}

function registry(codex: Harness) {
  return {
    codex,
    opencode: unavailableHarness("opencode"),
    claude: unavailableHarness("claude"),
  };
}

function promptsDirWith(character: string): string {
  const dir = mkdtempSync(join(tmpdir(), "audit-svc-prompts-"));
  writeFileSync(join(dir, `${character}.md`), "audit docs vs code\n", "utf8");
  return dir;
}

const finding = (title: string) =>
  JSON.stringify({ title, description: "d", signature: title });

describe("AuditService", () => {
  test("runs the cascade against a disposable copy, not the operator repo", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "audit-repo-"));
    const workspaceDir = mkdtempSync(join(tmpdir(), "audit-workspace-"));
    const ws = stubWorkspace(workspaceDir);
    let seenCwd: string | undefined;
    const service = new AuditService({
      promptsDir: promptsDirWith("docs-darwin"),
      getAllowedDirectories: () => [repoDir],
      resolveShellPath: async () => "",
      prepareWorkspace: ws.prepareWorkspace,
      registry: registry(
        writingHarness("codex", [finding("Stale doc")], (o) => {
          seenCwd = o.cwd;
        })
      ),
    });

    const result = await service.run({ character: "docs-darwin", repoDir });

    assert.equal(result.ok, true);
    assert.equal(result.harnessUsed, "codex");
    assert.deepEqual(
      result.findings.map((f) => f.title),
      ["Stale doc"]
    );
    assert.equal(result.reason, null);
    // The harness ran against the throwaway copy — never the operator's repo.
    assert.equal(seenCwd, workspaceDir);
    assert.notEqual(seenCwd, repoDir);
    // The workspace was prepared for the operator repo and disposed exactly once.
    assert.deepEqual(ws.calls, [{ repoDir }]);
    assert.equal(ws.disposedCount(), 1);
  });

  test("reports the operator repo path in progress, not the workspace copy", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "audit-repo-"));
    const workspaceDir = mkdtempSync(join(tmpdir(), "audit-workspace-"));
    const ws = stubWorkspace(workspaceDir);
    let startRepoDir: string | undefined;
    const service = new AuditService({
      promptsDir: promptsDirWith("docs-darwin"),
      getAllowedDirectories: () => [repoDir],
      resolveShellPath: async () => "",
      prepareWorkspace: ws.prepareWorkspace,
      registry: registry(writingHarness("codex", [finding("f")])),
    });

    await service.run({
      character: "docs-darwin",
      repoDir,
      onProgress: (event) => {
        if (event.phase === "start") {
          startRepoDir = event.repoDir;
        }
      },
    });

    assert.equal(startRepoDir, repoDir);
    assert.notEqual(startRepoDir, workspaceDir);
  });

  test("returns a setup failure (never throws) when workspace prepare fails", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "audit-repo-"));
    let cascadeRan = false;
    const service = new AuditService({
      promptsDir: promptsDirWith("docs-darwin"),
      getAllowedDirectories: () => [repoDir],
      resolveShellPath: async () => "",
      prepareWorkspace: () => Promise.reject(new Error("no temp space")),
      registry: registry(
        writingHarness("codex", [finding("f")], () => {
          cascadeRan = true;
        })
      ),
    });

    const result = await service.run({ character: "docs-darwin", repoDir });

    assert.equal(result.ok, false);
    assert.equal(result.reason, AuditRunFailureReason.SetupFailed);
    assert.equal(result.findings.length, 0);
    assert.equal(result.attempts.length, 0);
    // No cascade attempt happens when the disposable copy can't be prepared.
    assert.equal(cascadeRan, false);
  });

  test("disposes the workspace even when the run throws", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "audit-repo-"));
    const workspaceDir = mkdtempSync(join(tmpdir(), "audit-workspace-"));
    const ws = stubWorkspace(workspaceDir);
    const throwingHarness: Harness = {
      ...stubHarnessBase(HarnessName.Codex),
      isAvailable: async () => true,
      run: () => {
        throw new Error("boom");
      },
    };
    const service = new AuditService({
      // A missing prompt would short-circuit before the workspace; use a real
      // one so the throw happens inside the cascade, after prepare.
      promptsDir: promptsDirWith("docs-darwin"),
      getAllowedDirectories: () => [repoDir],
      resolveShellPath: async () => "",
      prepareWorkspace: ws.prepareWorkspace,
      registry: {
        codex: throwingHarness,
        opencode: unavailableHarness("opencode"),
        claude: unavailableHarness("claude"),
      },
    });

    await assert.rejects(
      () => service.run({ character: "docs-darwin", repoDir }),
      BOOM_RE
    );
    assert.equal(ws.disposedCount(), 1);
  });

  test("hands the resolved login-shell PATH to the harness child env", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "audit-repo-"));
    // The service prepends the resolved PATH into `process.env.PATH` (so crewd's
    // ambient `onPath` probe finds the CLI). Snapshot/restore it so this global
    // mutation cannot leak into other tests sharing the runner process.
    const originalPath = process.env.PATH;
    let seenEnv: Record<string, string> | undefined;
    const shellPath = "/opt/audit-fake-bin:/usr/bin";
    const ws = stubWorkspace(mkdtempSync(join(tmpdir(), "audit-workspace-")));
    const service = new AuditService({
      promptsDir: promptsDirWith("docs-darwin"),
      getAllowedDirectories: () => [repoDir],
      resolveShellPath: async () => shellPath,
      prepareWorkspace: ws.prepareWorkspace,
      registry: registry(
        writingHarness("codex", [finding("f")], (o) => {
          seenEnv = o.env;
        })
      ),
    });

    try {
      await service.run({ character: "docs-darwin", repoDir });
      // The child env carries the PATH explicitly (RunOpts.env)…
      assert.equal(seenEnv?.PATH, shellPath);
      // …and the ambient process PATH is augmented for the availability probe.
      assert.ok(process.env.PATH?.includes("/opt/audit-fake-bin"));
    } finally {
      if (originalPath === undefined) {
        Reflect.deleteProperty(process.env, "PATH");
      } else {
        process.env.PATH = originalPath;
      }
    }
  });

  test("bounds each harness with a default per-attempt timeout so a stall cannot hang the audit (FEA-4012)", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "audit-repo-"));
    const ws = stubWorkspace(mkdtempSync(join(tmpdir(), "audit-workspace-")));
    let seenTimeout: number | undefined;
    const service = new AuditService({
      promptsDir: promptsDirWith("docs-darwin"),
      getAllowedDirectories: () => [repoDir],
      resolveShellPath: async () => "",
      prepareWorkspace: ws.prepareWorkspace,
      // No `perAttemptTimeoutMs` dep ⇒ the service must supply its bounded default.
      registry: registry(
        writingHarness("codex", [finding("f")], (o) => {
          seenTimeout = o.timeoutMs;
        })
      ),
    });

    await service.run({ character: "docs-darwin", repoDir });

    assert.ok(
      typeof seenTimeout === "number" && seenTimeout > 0,
      "a bounded (non-zero) per-attempt timeout must reach the harness"
    );
  });

  test("honors an explicit unbounded (0) per-attempt timeout override (FEA-4012)", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "audit-repo-"));
    const ws = stubWorkspace(mkdtempSync(join(tmpdir(), "audit-workspace-")));
    let seenTimeout: number | undefined;
    const service = new AuditService({
      promptsDir: promptsDirWith("docs-darwin"),
      getAllowedDirectories: () => [repoDir],
      resolveShellPath: async () => "",
      prepareWorkspace: ws.prepareWorkspace,
      perAttemptTimeoutMs: 0,
      registry: registry(
        writingHarness("codex", [finding("f")], (o) => {
          seenTimeout = o.timeoutMs;
        })
      ),
    });

    await service.run({ character: "docs-darwin", repoDir });

    assert.equal(seenTimeout, 0, "an explicit 0 opts back into unbounded");
  });

  test("fails closed when the repo is outside the sandbox allow-list", async () => {
    const service = new AuditService({
      promptsDir: promptsDirWith("docs-darwin"),
      // Empty allow-list ⇒ nothing is allowed.
      getAllowedDirectories: () => [],
      resolveShellPath: async () => "",
      registry: registry(writingHarness("codex", [finding("Should not run")])),
    });

    const result = await service.run({
      character: "docs-darwin",
      repoDir: mkdtempSync(join(tmpdir(), "audit-denied-")),
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, AuditRunFailureReason.RepoNotAllowed);
    assert.equal(result.findings.length, 0);
    assert.equal(
      result.attempts.length,
      0,
      "no harness attempt on denied repo"
    );
  });

  test("reports a setup failure for a missing character prompt", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "audit-repo-"));
    const ws = stubWorkspace(mkdtempSync(join(tmpdir(), "audit-workspace-")));
    const service = new AuditService({
      promptsDir: promptsDirWith("docs-darwin"),
      getAllowedDirectories: () => [repoDir],
      resolveShellPath: async () => "",
      prepareWorkspace: ws.prepareWorkspace,
      registry: registry(writingHarness("codex", [])),
    });

    // "nonexistent" is not a valid character type in the contract, but the
    // service accepts any string; the missing prompt surfaces as setup_failed.
    const result = await service.run({
      character: "nonexistent" as "docs-darwin",
      repoDir,
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, AuditRunFailureReason.SetupFailed);
    assert.match(result.error ?? "", MISSING_PROMPT_RE);
  });

  // ── FEA-4009: operator-selected harness / model / cascade order ──

  test("cascades in the operator-specified order and stops on first success", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "audit-repo-"));
    const ws = stubWorkspace(mkdtempSync(join(tmpdir(), "audit-workspace-")));
    const ranModels: Record<string, string | undefined> = {};
    const service = new AuditService({
      promptsDir: promptsDirWith("docs-darwin"),
      getAllowedDirectories: () => [repoDir],
      resolveShellPath: async () => "",
      prepareWorkspace: ws.prepareWorkspace,
      // All three available and writing; the SELECTED order decides who wins.
      registry: {
        codex: writingHarness("codex", [finding("codex-found")], (o) => {
          ranModels.codex = o.model;
        }),
        opencode: writingHarness("opencode", [finding("opencode-found")]),
        claude: writingHarness("claude", [finding("claude-found")], (o) => {
          ranModels.claude = o.model;
        }),
      },
    });

    // Operator puts claude(opus) FIRST — the default order is codex-first, so a
    // claude-first result proves the selection was honored, not the default.
    const result = await service.run({
      character: "docs-darwin",
      repoDir,
      cascade: [{ harness: "claude", model: "opus" }, { harness: "codex" }],
    });

    assert.equal(result.harnessUsed, "claude");
    assert.deepEqual(
      result.findings.map((f) => f.title),
      ["claude-found"]
    );
    // Stopped on first success — codex (second in the selected order) never ran.
    assert.equal(ranModels.claude, "opus", "claude drove the selected model");
    assert.equal(ranModels.codex, undefined, "codex was never reached");
  });

  test("falls back to the default fixed order when no cascade is selected", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "audit-repo-"));
    const ws = stubWorkspace(mkdtempSync(join(tmpdir(), "audit-workspace-")));
    let codexModel: string | undefined;
    const service = new AuditService({
      promptsDir: promptsDirWith("docs-darwin"),
      getAllowedDirectories: () => [repoDir],
      resolveShellPath: async () => "",
      prepareWorkspace: ws.prepareWorkspace,
      registry: {
        codex: writingHarness("codex", [finding("codex-found")], (o) => {
          codexModel = o.model;
        }),
        opencode: writingHarness("opencode", [finding("opencode-found")]),
        claude: writingHarness("claude", [finding("claude-found")]),
      },
    });

    // No `cascade` ⇒ the historical default (codex → opencode → claude).
    const result = await service.run({ character: "docs-darwin", repoDir });

    assert.equal(result.harnessUsed, "codex", "default order is codex-first");
    assert.equal(codexModel, "gpt-5-codex", "codex ran on its default model");
  });

  test("treats an EMPTY selected cascade as the default (never an empty run)", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "audit-repo-"));
    const ws = stubWorkspace(mkdtempSync(join(tmpdir(), "audit-workspace-")));
    const service = new AuditService({
      promptsDir: promptsDirWith("docs-darwin"),
      getAllowedDirectories: () => [repoDir],
      resolveShellPath: async () => "",
      prepareWorkspace: ws.prepareWorkspace,
      registry: registry(writingHarness("codex", [finding("codex-found")])),
    });

    const result = await service.run({
      character: "docs-darwin",
      repoDir,
      cascade: [],
    });

    // An empty cascade must not run zero harnesses — it degrades to the default.
    assert.equal(result.harnessUsed, "codex");
    assert.deepEqual(
      result.findings.map((f) => f.title),
      ["codex-found"]
    );
  });
});

// ── FEA-3849 (M3): file selected findings to ClosedLoop ──

/** One recorded ClosedLoop fetch call (method + path + parsed body). */
type ClCall = { method: string; path: string; body: unknown };

/**
 * Stub `fetch` to model the ClosedLoop REST envelope the typed client drives.
 * `existing` seeds `GET /documents` so the dedup guard can match open issues.
 */
function stubClosedLoopFetch(existing: unknown[] = []) {
  const calls: ClCall[] = [];
  let nextId = 1;
  // Parameters match `fetch`'s, not a convenient subset: `mockImplementation`
  // is checked contravariantly against the method it replaces, so a narrower
  // `init` is rejected. node:test's mock.method checked neither.
  const fn = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname, body });
    let data: unknown = null;
    if (method === "GET" && url.pathname === "/documents") {
      data = existing;
    } else if (method === "GET" && url.pathname === "/tags") {
      data = [{ id: "tag-docs", name: AUDIT_DOCS_DARWIN_TAG }];
    } else if (method === "POST" && url.pathname === "/documents") {
      const id = `doc-${nextId++}`;
      data = { id, slug: id, type: "FEATURE", title: "", status: "TRIAGE" };
    } else if (url.pathname === "/entity-tags") {
      return Promise.resolve(
        new Response(JSON.stringify({ success: true }), { status: 200 })
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ success: true, data }), { status: 200 })
    );
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(fn);
  return { calls };
}

function fileService(overrides: {
  getAccessToken?: () => Promise<string | null>;
}) {
  return new AuditService({
    promptsDir: promptsDirWith("docs-darwin"),
    getAllowedDirectories: () => [],
    resolveShellPath: async () => "",
    getApiOrigin: () => "https://api.test",
    getAccessToken: overrides.getAccessToken ?? (async () => "token-abc"),
  });
}

const sel = (over: Partial<Finding> = {}): Finding => ({
  title: "Stale doc",
  description: "docs.md:3",
  signature: "sig:stale",
  ...over,
});

describe("AuditService.file", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("files selected findings via the typed client with tag + assignee + signature", async () => {
    const { calls } = stubClosedLoopFetch();
    const service = fileService({});

    const result = await service.file({
      character: "docs-darwin",
      findings: [sel(), sel({ title: "Wrong flag", signature: "sig:flag" })],
      projectSlug: "my-project",
      assigneeId: "assignee-9",
    });

    assert.equal(result.ok, true);
    assert.equal(result.created, 2);
    assert.equal(result.skipped, 0);

    const creates = calls.filter(
      (c) => c.method === "POST" && c.path === "/documents"
    );
    assert.equal(creates.length, 2);
    const first = creates[0]?.body as Record<string, unknown>;
    assert.equal(first.status, "TRIAGE");
    assert.equal(first.assigneeId, "assignee-9");
    assert.equal(first.projectId, "my-project");
    // The signature marker is embedded so the next filing can dedup.
    assert.match(String(first.content), SIG_STALE_RE);
    // Every created issue is tagged agent-docs-darwin (entity-tags POST).
    const tagCalls = calls.filter((c) => c.path === "/entity-tags");
    assert.equal(tagCalls.length, 2);
  });

  test("dedup: skips a finding whose signature is already open, never re-files", async () => {
    // Seed an OPEN doc carrying the same signature marker as one selected finding.
    const { calls } = stubClosedLoopFetch([
      {
        id: "FEA-open",
        slug: "FEA-open",
        type: "FEATURE",
        title: "nightly-review: previously filed",
        status: "TRIAGE",
        content: "d\n\n<!-- nightly-signature: sig:stale -->",
      },
    ]);
    const service = fileService({});

    const result = await service.file({
      character: "docs-darwin",
      findings: [sel(), sel({ title: "Fresh", signature: "sig:fresh" })],
      projectSlug: "my-project",
    });

    assert.equal(result.ok, true);
    assert.equal(result.created, 1, "only the non-duplicate is created");
    assert.equal(result.skipped, 1, "the already-open signature is skipped");
    const creates = calls.filter(
      (c) => c.method === "POST" && c.path === "/documents"
    );
    assert.equal(
      creates.length,
      1,
      "the duplicate never reaches createDocument"
    );
  });

  test("refuses with not_authenticated when there is no access token", async () => {
    stubClosedLoopFetch();
    const service = fileService({ getAccessToken: async () => null });

    const result = await service.file({
      character: "docs-darwin",
      findings: [sel()],
      projectSlug: "my-project",
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, AuditFileFailureReason.NotAuthenticated);
    assert.equal(result.created, 0);
  });

  test("refuses an invalid request (no findings) without any network call", async () => {
    const { calls } = stubClosedLoopFetch();
    const service = fileService({});

    const result = await service.file({
      character: "docs-darwin",
      findings: [],
      projectSlug: "my-project",
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, AuditFileFailureReason.InvalidRequest);
    assert.equal(calls.length, 0, "no ClosedLoop call for an empty selection");
  });
});
