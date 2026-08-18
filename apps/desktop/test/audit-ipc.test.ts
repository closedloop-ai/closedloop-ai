import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AuditScope, type CascadeStep, HarnessName } from "@repo/crewd/model";
import type { AuditService } from "../src/main/audit/audit-service.js";
import {
  type AuditIpcDeps,
  registerAuditIpcHandlers,
} from "../src/main/ipc/audit-ipc.js";
import {
  AuditCharacter,
  AuditFileFailureReason,
  type AuditFileResult,
  AuditIpcChannel,
  type AuditProgressPayload,
  AuditRunFailureReason,
  type AuditRunResult,
} from "../src/shared/audit-contract.js";

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

const UNTRUSTED_SENDER_ERROR = /untrusted sender/;

type FileCall = {
  character: string;
  projectSlug: string;
  findingCount: number;
  assigneeId?: string | null;
};

type RunCall = {
  character: string;
  repoDir: string;
  scopePreset?: string;
  scope?: string | null;
  cascade?: readonly CascadeStep[];
};

/** A findings-returning fake service that also emits progress via `run`. */
function fakeAuditService(
  result: Partial<AuditRunResult> = {}
): AuditService & {
  calls: RunCall[];
  fileCalls: FileCall[];
} {
  const calls: RunCall[] = [];
  const fileCalls: FileCall[] = [];
  const service = {
    calls,
    fileCalls,
    run: (options: {
      character: string;
      repoDir: string;
      scopePreset?: string;
      scope?: string | null;
      cascade?: readonly CascadeStep[];
      onProgress?: (event: { phase: string; [k: string]: unknown }) => void;
    }): Promise<AuditRunResult> => {
      calls.push({
        character: options.character,
        repoDir: options.repoDir,
        scopePreset: options.scopePreset,
        scope: options.scope,
        cascade: options.cascade,
      });
      options.onProgress?.({
        phase: "start",
        character: options.character,
        repoDir: options.repoDir,
        cascade: ["codex"],
      });
      options.onProgress?.({
        phase: "done",
        ok: true,
        harnessUsed: "codex",
        findingsCount: 1,
      });
      return Promise.resolve({
        ok: true,
        character: options.character,
        harnessUsed: "codex",
        attempts: [],
        findings: [{ title: "Stale README", description: "d" }],
        reason: null,
        error: null,
        ...result,
      });
    },
    file: (options: {
      character: string;
      findings: Array<{ title: string }>;
      projectSlug: string;
      assigneeId?: string | null;
    }): Promise<AuditFileResult> => {
      fileCalls.push({
        character: options.character,
        projectSlug: options.projectSlug,
        findingCount: options.findings.length,
        assigneeId: options.assigneeId,
      });
      return Promise.resolve({
        ok: true,
        filed: options.findings.map((f) => ({
          key: f.title.toLowerCase(),
          title: f.title,
          status: "created",
        })),
        created: options.findings.length,
        skipped: 0,
        reason: null,
        error: null,
      });
    },
  };
  return service as unknown as AuditService & {
    calls: typeof calls;
    fileCalls: FileCall[];
  };
}

type Registered = {
  handlers: Map<string, IpcHandler>;
  progress: AuditProgressPayload[];
  service: ReturnType<typeof fakeAuditService>;
};

function register(overrides: Partial<AuditIpcDeps> = {}): Registered {
  const handlers = new Map<string, IpcHandler>();
  const progress: AuditProgressPayload[] = [];
  const service = fakeAuditService();
  registerAuditIpcHandlers(
    {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
    },
    {
      isTrustedSender: () => true,
      isAuditBotEnabled: () => true,
      auditService: service,
      sendProgress: (payload) => progress.push(payload),
      ...overrides,
    }
  );
  return { handlers, progress, service };
}

const trustedEvent = { sender: { id: 1 } };
const runRequest = { character: "docs-darwin", repoDir: "/tmp/repo" };

describe("registerAuditIpcHandlers", () => {
  test("runs the pass, streams progress, and returns findings", async () => {
    const { handlers, progress, service } = register();
    const handler = handlers.get(AuditIpcChannel.Run);
    assert.ok(handler, "run handler registered");

    const result = (await handler(trustedEvent, runRequest)) as AuditRunResult;

    assert.equal(result.ok, true);
    assert.equal(result.harnessUsed, "codex");
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]?.title, "Stale README");
    assert.equal(service.calls.length, 1);
    assert.equal(service.calls[0]?.character, "docs-darwin");
    assert.equal(service.calls[0]?.repoDir, "/tmp/repo");

    // Progress is streamed to the renderer, tagged with a shared runId.
    assert.equal(progress.length, 2);
    assert.equal(progress[0]?.phase, "start");
    assert.equal(progress.at(-1)?.phase, "done");
    const runId = progress[0]?.runId;
    assert.ok(runId, "progress carries a runId");
    assert.ok(progress.every((p) => p.runId === runId));
  });

  test("rejects an untrusted sender before running the pass", async () => {
    const { handlers, service } = register({ isTrustedSender: () => false });
    const handler = handlers.get(AuditIpcChannel.Run);
    assert.ok(handler);

    await assert.rejects(
      () => Promise.resolve(handler(trustedEvent, runRequest)),
      UNTRUSTED_SENDER_ERROR
    );
    assert.equal(service.calls.length, 0, "no spawn on untrusted sender");
  });

  test("refuses the run with a typed reason when the flag is off", async () => {
    const { handlers, progress, service } = register({
      isAuditBotEnabled: () => false,
    });
    const handler = handlers.get(AuditIpcChannel.Run);
    assert.ok(handler);

    const result = (await handler(trustedEvent, runRequest)) as AuditRunResult;

    assert.equal(result.ok, false);
    assert.equal(result.reason, AuditRunFailureReason.Disabled);
    assert.equal(result.findings.length, 0);
    assert.equal(service.calls.length, 0, "flag-off spawns nothing");
    assert.equal(progress.length, 0, "flag-off streams no progress");
  });

  test("rejects a malformed request without running", async () => {
    const { handlers, service } = register();
    const handler = handlers.get(AuditIpcChannel.Run);
    assert.ok(handler);

    const badCharacter = (await handler(trustedEvent, {
      character: "not-a-character",
      repoDir: "/tmp/repo",
    })) as AuditRunResult;
    assert.equal(badCharacter.reason, AuditRunFailureReason.SetupFailed);

    const missingRepo = (await handler(trustedEvent, {
      character: "docs-darwin",
    })) as AuditRunResult;
    assert.equal(missingRepo.reason, AuditRunFailureReason.SetupFailed);

    assert.equal(service.calls.length, 0);
  });

  // ── FEA-3850 (M4): broadened roster + scope presets ──

  test("runs a broadened-roster character (e.g. code-cassandra)", async () => {
    const { handlers, service } = register();
    const handler = handlers.get(AuditIpcChannel.Run);
    assert.ok(handler);

    await handler(trustedEvent, {
      character: AuditCharacter.CodeCassandra,
      repoDir: "/tmp/repo",
    });

    assert.equal(service.calls[0]?.character, AuditCharacter.CodeCassandra);
  });

  test("maps a valid scope preset through to the run", async () => {
    const { handlers, service } = register();
    const handler = handlers.get(AuditIpcChannel.Run);
    assert.ok(handler);

    await handler(trustedEvent, {
      character: AuditCharacter.SecuritySentinel,
      repoDir: "/tmp/repo",
      scopePreset: AuditScope.ChangedSinceMain,
    });

    assert.equal(service.calls[0]?.scopePreset, AuditScope.ChangedSinceMain);
  });

  test("rejects a PRESENT but invalid scope preset instead of widening to whole-repo", async () => {
    const { handlers, service } = register();
    const handler = handlers.get(AuditIpcChannel.Run);
    assert.ok(handler);

    const result = (await handler(trustedEvent, {
      character: AuditCharacter.DocsDarwin,
      repoDir: "/tmp/repo",
      scopePreset: "not-a-scope",
    })) as AuditRunResult;

    // A garbage preset must NOT silently default to the broadest whole-repo
    // audit — the request is rejected and the service is never invoked.
    assert.equal(service.calls.length, 0);
    assert.equal(result.ok, false);
    assert.equal(result.reason, AuditRunFailureReason.SetupFailed);
  });

  test("defaults to whole-repo only when scopePreset is ABSENT (forwards undefined)", async () => {
    const { handlers, service } = register();
    const handler = handlers.get(AuditIpcChannel.Run);
    assert.ok(handler);

    await handler(trustedEvent, {
      character: AuditCharacter.DocsDarwin,
      repoDir: "/tmp/repo",
    });

    assert.equal(service.calls.length, 1);
    assert.equal(
      service.calls[0]?.scopePreset,
      undefined,
      "an absent scope is forwarded as undefined; the service defaults to whole-repo"
    );
  });

  // ── FEA-4009: operator-selected harness / model / cascade order ──

  test("threads the selected harness/model/order cascade through to the run", async () => {
    const { handlers, service } = register();
    const handler = handlers.get(AuditIpcChannel.Run);
    assert.ok(handler);

    await handler(trustedEvent, {
      character: AuditCharacter.DocsDarwin,
      repoDir: "/tmp/repo",
      // A reordered, model-picked cascade: claude(opus) first, then codex default.
      cascade: [
        { harness: HarnessName.Claude, model: "opus" },
        { harness: HarnessName.Codex },
      ],
    });

    assert.equal(service.calls.length, 1);
    assert.deepEqual(service.calls[0]?.cascade, [
      { harness: HarnessName.Claude, model: "opus" },
      { harness: HarnessName.Codex },
    ]);
  });

  test("normalizes the backward-compatible bare-name / harness:model shorthands", async () => {
    const { handlers, service } = register();
    const handler = handlers.get(AuditIpcChannel.Run);
    assert.ok(handler);

    await handler(trustedEvent, {
      character: AuditCharacter.DocsDarwin,
      repoDir: "/tmp/repo",
      // Legacy wire shapes an older renderer might send.
      cascade: ["codex", "claude:opus"],
    });

    assert.deepEqual(service.calls[0]?.cascade, [
      { harness: HarnessName.Codex },
      { harness: HarnessName.Claude, model: "opus" },
    ]);
  });

  test("forwards an ABSENT cascade as undefined (service defaults to the fixed order)", async () => {
    const { handlers, service } = register();
    const handler = handlers.get(AuditIpcChannel.Run);
    assert.ok(handler);

    await handler(trustedEvent, {
      character: AuditCharacter.DocsDarwin,
      repoDir: "/tmp/repo",
    });

    assert.equal(service.calls.length, 1);
    assert.equal(
      service.calls[0]?.cascade,
      undefined,
      "an absent cascade is forwarded as undefined; the service falls back to the default"
    );
  });

  test("rejects a PRESENT but invalid cascade (unknown harness) without running", async () => {
    const { handlers, service } = register();
    const handler = handlers.get(AuditIpcChannel.Run);
    assert.ok(handler);

    const result = (await handler(trustedEvent, {
      character: AuditCharacter.DocsDarwin,
      repoDir: "/tmp/repo",
      cascade: [{ harness: "gemini" }],
    })) as AuditRunResult;

    assert.equal(service.calls.length, 0, "unknown harness never spawns");
    assert.equal(result.ok, false);
    assert.equal(result.reason, AuditRunFailureReason.SetupFailed);
  });

  test("forwards an EMPTY cascade array as undefined (leave-all-off ⇒ the default order)", async () => {
    const { handlers, service } = register();
    const handler = handlers.get(AuditIpcChannel.Run);
    assert.ok(handler);

    // The cascade picker documents "leave all off to use the default order";
    // clearing every harness sends `cascade: []`, which must reach the service
    // as undefined so `resolveCascade()` applies DEFAULT_AUDIT_CASCADE — not be
    // rejected as a setup failure.
    const result = (await handler(trustedEvent, {
      character: AuditCharacter.DocsDarwin,
      repoDir: "/tmp/repo",
      cascade: [],
    })) as AuditRunResult;

    assert.equal(service.calls.length, 1, "an empty cascade still runs");
    assert.equal(
      service.calls[0]?.cascade,
      undefined,
      "an empty cascade is forwarded as undefined; the service falls back to the default"
    );
    assert.notEqual(result.reason, AuditRunFailureReason.SetupFailed);
  });

  test("rejects an over-length cascade (more steps than harnesses) without running", async () => {
    const { handlers, service } = register();
    const handler = handlers.get(AuditIpcChannel.Run);
    assert.ok(handler);

    // A malformed client packs thousands of (individually valid) steps — the
    // boundary caps the array at one step per known harness so `runCascade`
    // cannot be driven to spawn+retry each one.
    const overLength = Array.from({ length: 5000 }, () => ({
      harness: HarnessName.Codex,
    }));
    const result = (await handler(trustedEvent, {
      character: AuditCharacter.DocsDarwin,
      repoDir: "/tmp/repo",
      cascade: overLength,
    })) as AuditRunResult;

    assert.equal(
      service.calls.length,
      0,
      "an over-length cascade never spawns"
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, AuditRunFailureReason.SetupFailed);
  });

  test("rejects a cascade with a duplicate harness without running", async () => {
    const { handlers, service } = register();
    const handler = handlers.get(AuditIpcChannel.Run);
    assert.ok(handler);

    // A cascade is an ordered fallback across DISTINCT harnesses; the same
    // harness twice (even with a different model) is malformed and rejected —
    // it must not spawn a repeated harness.
    const result = (await handler(trustedEvent, {
      character: AuditCharacter.DocsDarwin,
      repoDir: "/tmp/repo",
      cascade: [
        { harness: HarnessName.Claude, model: "opus" },
        { harness: HarnessName.Claude },
      ],
    })) as AuditRunResult;

    assert.equal(
      service.calls.length,
      0,
      "a duplicate-harness cascade never spawns"
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, AuditRunFailureReason.SetupFailed);
  });
});

// ── FEA-3849 (M3): the `audit:file` IPC boundary ──

const fileRequest = {
  character: "docs-darwin",
  findings: [{ title: "Stale README", description: "docs.md:3" }],
  projectSlug: "my-project",
  assigneeId: "assignee-9",
};

describe("registerAuditIpcHandlers — audit:file", () => {
  test("files the SELECTED findings and returns per-finding outcomes", async () => {
    const { handlers, service } = register();
    const handler = handlers.get(AuditIpcChannel.File);
    assert.ok(handler, "file handler registered");

    const result = (await handler(
      trustedEvent,
      fileRequest
    )) as AuditFileResult;

    assert.equal(result.ok, true);
    assert.equal(result.created, 1);
    assert.equal(result.filed[0]?.status, "created");
    // The exact user selection is forwarded to the service — nothing implicit.
    assert.deepEqual(service.fileCalls, [
      {
        character: "docs-darwin",
        projectSlug: "my-project",
        findingCount: 1,
        assigneeId: "assignee-9",
      },
    ]);
  });

  test("rejects an untrusted sender before filing anything", async () => {
    const { handlers, service } = register({ isTrustedSender: () => false });
    const handler = handlers.get(AuditIpcChannel.File);
    assert.ok(handler);

    await assert.rejects(
      () => Promise.resolve(handler(trustedEvent, fileRequest)),
      UNTRUSTED_SENDER_ERROR
    );
    assert.equal(
      service.fileCalls.length,
      0,
      "no ClosedLoop filing on untrusted sender"
    );
  });

  test("refuses filing with a typed reason when the flag is off", async () => {
    const { handlers, service } = register({ isAuditBotEnabled: () => false });
    const handler = handlers.get(AuditIpcChannel.File);
    assert.ok(handler);

    const result = (await handler(
      trustedEvent,
      fileRequest
    )) as AuditFileResult;

    assert.equal(result.ok, false);
    assert.equal(result.reason, AuditFileFailureReason.Disabled);
    assert.equal(result.created, 0);
    assert.equal(service.fileCalls.length, 0, "flag-off files nothing");
  });

  test("refuses a malformed file request (empty selection) without filing", async () => {
    const { handlers, service } = register();
    const handler = handlers.get(AuditIpcChannel.File);
    assert.ok(handler);

    const emptySelection = (await handler(trustedEvent, {
      character: "docs-darwin",
      findings: [],
      projectSlug: "my-project",
    })) as AuditFileResult;
    assert.equal(emptySelection.reason, AuditFileFailureReason.InvalidRequest);

    const missingProject = (await handler(trustedEvent, {
      character: "docs-darwin",
      findings: [{ title: "X", description: "d" }],
    })) as AuditFileResult;
    assert.equal(missingProject.reason, AuditFileFailureReason.InvalidRequest);

    const badFinding = (await handler(trustedEvent, {
      character: "docs-darwin",
      findings: [{ description: "no title" }],
      projectSlug: "my-project",
    })) as AuditFileResult;
    assert.equal(badFinding.reason, AuditFileFailureReason.InvalidRequest);

    assert.equal(
      service.fileCalls.length,
      0,
      "no filing for any malformed request"
    );
  });
});
