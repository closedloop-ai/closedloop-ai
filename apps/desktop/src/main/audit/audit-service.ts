/**
 * @file audit-service.ts
 * @description FEA-3847 (PRD-556 M1) — the desktop main-process host for an
 * on-demand crewd audit run.
 *
 * `AuditService` runs a review character (Docs Darwin first) against a
 * renderer-supplied repo by delegating to the crewd `runAuditPass`
 * (`@repo/crewd/passes/audit`) — the SAME engine the nightly review pass drives,
 * minus the file-to-ClosedLoop step (that is M3). It owns three things the pure
 * crewd pass cannot: (1) resolving the bundled character-prompt directory
 * (asar-safe), (2) fail-closed sandbox validation of the target repo before any
 * subprocess spawns, and (3) handing the login-shell PATH to the cascade so the
 * `claude`/`codex`/`opencode` CLIs resolve in a packaged Electron build (matching
 * how the Engineer gateway spawns local CLIs).
 *
 * SECURITY: local CLI execution stays in the desktop main/gateway trust zone.
 * The repo path is validated against `getAllowedDirectories()` exactly like the
 * gateway operations in `src/server/operations/*` — a denied path never spawns.
 *
 * Because the crewd cascade spawns each harness with its dangerous bypass flags
 * (`--dangerously-bypass-approvals-and-sandbox` / `--dangerously-skip-permissions`),
 * the character's "read-only" instruction is NOT an enforcement boundary. So the
 * cascade never runs against the operator's real checkout: `prepareAuditWorkspace`
 * materializes a throwaway copy (a detached git worktree, else an fs copy) and
 * the audit runs there, so any write a prompt-injected or misbehaving harness
 * makes is discarded with the copy and the operator's working tree is untouched.
 *
 * M3 (FEA-3849) adds {@link AuditService.file}: the ClosedLoop filing of the
 * user's SELECTED findings runs main-side (bearer = the desktop access token),
 * never automatically, reusing crewd's dedup-guarded `fileFindings` path.
 */

import path from "node:path";
import { ClosedLoopClient } from "@repo/crewd/clients/closedloop";
import { defaultRegistry } from "@repo/crewd/harness";
import type { AuditScope, CascadeStep } from "@repo/crewd/model";
import {
  type AuditProgressEvent,
  type AuditRunResult as CrewdAuditRunResult,
  runAuditPass,
} from "@repo/crewd/passes/audit";
import {
  type AuditWorkspace,
  prepareAuditWorkspace,
} from "@repo/crewd/passes/audit-workspace";
import { type Finding, fileFindings } from "@repo/crewd/passes/findings";
import { isPathAllowed } from "../../server/security.js";
import { getShellPath } from "../../server/shell-path.js";
import {
  type AuditCharacterId,
  AuditFileFailureReason,
  type AuditFileResult,
  AuditRunFailureReason,
  type AuditRunResult,
  characterMetaFor,
  DEFAULT_AUDIT_CASCADE,
} from "../../shared/audit-contract.js";
import { expandHomePath } from "../../shared/path-utils.js";

export type AuditServiceDeps = {
  /**
   * Absolute directory holding the bundled `<character>.md` character prompts
   * (asar-safe; resolved from `resourcesPath` in a packaged build).
   */
  promptsDir: string;
  /** The current sandbox allow-list — the repo must resolve inside it. */
  getAllowedDirectories: () => string[];
  /**
   * The desktop cloud access token (bearer) used for the ClosedLoop network
   * call in {@link AuditService.file}. Resolves null when the user is not signed
   * in — filing then returns a typed `not_authenticated` refusal. The token
   * never leaves the main process (network to ClosedLoop is main-side).
   */
  getAccessToken?: () => Promise<string | null>;
  /** The ClosedLoop api origin (base URL) for the filing network call. */
  getApiOrigin?: () => string;
  /**
   * Login-shell PATH resolver, defaulting to the desktop `getShellPath()`. The
   * resolved value is handed to the cascade child env AND merged into
   * `process.env.PATH` so crewd's `onPath` availability probe also finds the CLI.
   */
  resolveShellPath?: () => Promise<string>;
  /** Harness registry override (tests inject mocks). */
  registry?: typeof defaultRegistry;
  /** Per-attempt harness timeout (ms); 0/undefined = unbounded. */
  perAttemptTimeoutMs?: number;
  /**
   * Disposable-workspace factory (tests inject a stub that skips the real git
   * copy). Defaults to {@link prepareAuditWorkspace}; the returned copy is what
   * the cascade actually runs against, never the operator's checkout.
   */
  prepareWorkspace?: (
    repoDir: string,
    env: Record<string, string> | undefined
  ) => Promise<AuditWorkspace>;
  /** Key-free diagnostic log sink. */
  log?: (message: string) => void;
};

export type AuditRunOptions = {
  character: AuditCharacterId;
  repoDir: string;
  /** The scope preset the run reviews (FEA-3850 M4); undefined ⇒ whole-repo. */
  scopePreset?: AuditScope;
  scope?: string | null;
  /**
   * The operator-selected harness cascade (FEA-4009): ordered `(harness,
   * model?)` steps tried first-to-last, stopping on first success. Undefined or
   * empty ⇒ {@link DEFAULT_AUDIT_CASCADE} (the historical fixed order), so an
   * older renderer that never sends it keeps today's behavior.
   */
  cascade?: readonly CascadeStep[];
  /** Progress sink — every crewd phase event is forwarded here as it lands. */
  onProgress?: (event: AuditProgressEvent) => void;
  signal?: AbortSignal;
};

export class AuditService {
  private readonly deps: AuditServiceDeps;
  private readonly log: (message: string) => void;

  constructor(deps: AuditServiceDeps) {
    this.deps = deps;
    this.log = deps.log ?? (() => {});
  }

  /**
   * Run one review character against `repoDir` and return its findings. Never
   * throws for an operational failure — a denied repo, missing prompt, or
   * exhausted cascade is reported in the structured result so the IPC caller
   * surfaces a clean state rather than a raw handler error.
   */
  async run(options: AuditRunOptions): Promise<AuditRunResult> {
    const repoDir = path.resolve(expandHomePath(options.repoDir));
    if (!isPathAllowed(repoDir, this.deps.getAllowedDirectories())) {
      this.log(`audit: repo not allowed — ${repoDir}`);
      return preflightFailure(
        options.character,
        AuditRunFailureReason.RepoNotAllowed,
        `repo not allowed: ${repoDir}`
      );
    }

    // Hand the login-shell PATH to the cascade so the `claude`/`codex`/`opencode`
    // CLIs resolve in a packaged Electron build (whose GUI `process.env.PATH` is
    // truncated), matching how the Engineer gateway spawns local CLIs. It is
    // handed BOTH ways because crewd's cascade needs each: the child spawn reads
    // it from the explicit `env` (RunOpts.env), while the pre-spawn availability
    // probe (`onPath`) reads the ambient `process.env.PATH` — so we also merge it
    // there. `ensureProcessPath` is a dedup-guarded prepend (no unbounded growth).
    const shellPath = await this.resolveShellPath();
    ensureProcessPath(shellPath);
    const childEnv = shellPath ? { PATH: shellPath } : undefined;

    // Run the cascade against a throwaway copy, NOT `repoDir` itself: the
    // harnesses spawn with bypass flags, so a copy is the only real read-only
    // boundary. Disposed unconditionally in `finally`. Preparing the copy can
    // fail (temp space, fs copy error) — surface that as a structured setup
    // failure rather than throwing, so the IPC caller keeps its clean state
    // (the `run()` contract: never throw for an operational failure).
    let workspace: AuditWorkspace;
    try {
      workspace = await this.prepareWorkspace(repoDir, childEnv);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`audit: workspace prepare failed — ${message}`);
      return preflightFailure(
        options.character,
        AuditRunFailureReason.SetupFailed,
        `workspace prepare failed: ${message}`
      );
    }
    try {
      const crewdResult = await runAuditPass({
        character: options.character,
        repoDir: workspace.dir,
        promptsDir: this.deps.promptsDir,
        // The operator-selected cascade (FEA-4009), or the default fixed order
        // when they did not customize one (empty/absent ⇒ historical behavior).
        cascade: resolveCascade(options.cascade),
        // FEA-3850 M4: the scope preset the run reviews (undefined ⇒ whole-repo).
        scopePreset: options.scopePreset,
        scope: options.scope ?? null,
        registry: this.deps.registry ?? defaultRegistry,
        // Bound each harness so a stalled/eliciting attempt cannot hang the
        // audit forever (FEA-4012). The bounded default is applied at the shared
        // `runCascade` entry point, so passing the dep straight through gives
        // `undefined` ⇒ that default and an explicit `0` ⇒ unbounded.
        perAttemptTimeoutMs: this.deps.perAttemptTimeoutMs,
        // Report the operator's real repo path in progress, not the throwaway
        // workspace temp dir the cascade actually runs against.
        onProgress: forwardProgress(options.onProgress, repoDir),
        signal: options.signal,
        env: childEnv,
      });

      return toContractResult(crewdResult);
    } finally {
      await workspace.dispose().catch((error: unknown) => {
        this.log(
          `audit: workspace cleanup failed — ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      });
    }
  }

  private prepareWorkspace(
    repoDir: string,
    env: Record<string, string> | undefined
  ): Promise<AuditWorkspace> {
    return (this.deps.prepareWorkspace ?? prepareAuditWorkspace)(repoDir, env);
  }

  /**
   * File the caller's SELECTED findings to ClosedLoop as dedup-guarded TRIAGE
   * issues, reusing crewd's `fileFindings` path (tag `agent-docs-darwin`,
   * assignee, signature marker). This is NEVER called automatically — the IPC
   * layer only reaches it after the user explicitly selects findings and
   * confirms. The desktop access token + api origin build the typed ClosedLoop
   * client here in the main/gateway trust zone; the token never crosses to the
   * renderer. Never throws for an operational failure — a missing token,
   * malformed request, or network error is reported in the structured result.
   */
  async file(options: AuditFileOptions): Promise<AuditFileResult> {
    if (options.findings.length === 0 || !options.projectSlug) {
      return fileFailure(
        AuditFileFailureReason.InvalidRequest,
        "no findings selected or missing target project"
      );
    }

    const token = await this.resolveAccessToken();
    if (!token) {
      return fileFailure(
        AuditFileFailureReason.NotAuthenticated,
        "not signed in — cannot file to ClosedLoop"
      );
    }

    const client = new ClosedLoopClient({
      apiKey: token,
      projectSlug: options.projectSlug,
      baseUrl: this.deps.getApiOrigin?.(),
    });

    try {
      const filed = await fileFindings(client, options.findings, {
        tagName: tagForCharacter(options.character),
        assigneeId: options.assigneeId ?? undefined,
      });
      return {
        ok: true,
        filed: filed.results.map((r) => ({
          key: r.key,
          title: r.title,
          status: r.status,
          documentId: r.documentId,
        })),
        created: filed.created,
        skipped: filed.skipped,
        failed: filed.failed,
        reason: null,
        error: null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`audit: file failed — ${message}`);
      return fileFailure(AuditFileFailureReason.FilingFailed, message);
    }
  }

  private resolveShellPath(): Promise<string> {
    const resolver = this.deps.resolveShellPath ?? getShellPath;
    return resolver().catch(() => "");
  }

  private resolveAccessToken(): Promise<string | null> {
    const resolver = this.deps.getAccessToken ?? (async () => null);
    return resolver().catch(() => null);
  }
}

export type AuditFileOptions = {
  character: AuditCharacterId;
  /** The findings the user explicitly selected to file. */
  findings: Finding[];
  /** Target ClosedLoop project slug/id. */
  projectSlug: string;
  /** Optional ClosedLoop assignee for the created issues. */
  assigneeId?: string | null;
};

/**
 * Map a review character to its ClosedLoop filing tag. Each character carries its
 * own tag via {@link characterMetaFor} (e.g. Docs Darwin ⇒ agent-docs-darwin,
 * Code Cassandra ⇒ agent-code-cassandra), so a filed issue is attributable to
 * the reviewer that produced it and the M3 dedup guard scopes per character. The
 * character is roster-validated at the IPC boundary before reaching here; an
 * unknown id (defensive) falls back to a stable `agent-<id>` tag rather than
 * throwing so filing never crashes the trust-zone path. The fallback mirrors the
 * generator's `tagForId` scheme (full path, `/`→`-`) so a nested id cannot
 * collide with a top-level tag or another author's same-named character.
 */
function tagForCharacter(character: AuditCharacterId): string {
  return (
    characterMetaFor(character)?.tag ?? `agent-${character.replace(/\//g, "-")}`
  );
}

function fileFailure(
  reason: AuditFileFailureReason,
  error: string
): AuditFileResult {
  return { ok: false, filed: [], created: 0, skipped: 0, reason, error };
}

/** Prepend `shellPath` to `process.env.PATH` if not already present. */
function ensureProcessPath(shellPath: string): void {
  if (!shellPath) {
    return;
  }
  const current = process.env.PATH ?? "";
  const currentEntries = new Set(current.split(path.delimiter).filter(Boolean));
  const missing = shellPath
    .split(path.delimiter)
    .filter((entry) => entry && !currentEntries.has(entry));
  if (missing.length === 0) {
    return;
  }
  process.env.PATH = current
    ? `${missing.join(path.delimiter)}${path.delimiter}${current}`
    : missing.join(path.delimiter);
}

function toContractResult(result: CrewdAuditRunResult): AuditRunResult {
  return {
    ok: result.ok,
    character: result.character,
    harnessUsed: result.harnessUsed,
    attempts: result.attempts,
    findings: result.findings,
    // A non-null crewd error with no findings and no successful run is a setup
    // fault (missing prompt) or an exhausted cascade; surface it as setup_failed
    // only when nothing ran. An exhausted cascade keeps error text but no reason.
    reason:
      result.error && result.attempts.length === 0
        ? AuditRunFailureReason.SetupFailed
        : null,
    error: result.error,
  };
}

/**
 * Wrap the caller's progress sink so the `start` event reports the operator's
 * real repo path instead of the disposable workspace temp dir the cascade runs
 * against. Every other phase passes through untouched.
 */
function forwardProgress(
  onProgress: ((event: AuditProgressEvent) => void) | undefined,
  operatorRepoDir: string
): ((event: AuditProgressEvent) => void) | undefined {
  if (!onProgress) {
    return;
  }
  return (event: AuditProgressEvent) => {
    if (event.phase === "start") {
      onProgress({ ...event, repoDir: operatorRepoDir });
      return;
    }
    onProgress(event);
  };
}

/**
 * Resolve the cascade the run drives (FEA-4009): the operator's selected steps
 * when they customized one, else {@link DEFAULT_AUDIT_CASCADE} (the historical
 * fixed order). An absent OR empty selection falls back to the default so a
 * version-skewed renderer, or one that clears every harness, never runs an empty
 * cascade (which `runCascade` would report as a no-attempt failure).
 */
function resolveCascade(
  cascade: readonly CascadeStep[] | undefined
): readonly CascadeStep[] {
  return cascade && cascade.length > 0 ? cascade : DEFAULT_AUDIT_CASCADE;
}

function preflightFailure(
  character: string,
  reason: AuditRunFailureReason,
  error: string
): AuditRunResult {
  return {
    ok: false,
    character,
    harnessUsed: null,
    attempts: [],
    findings: [],
    reason,
    error,
  };
}
