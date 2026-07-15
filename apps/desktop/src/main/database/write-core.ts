/**
 * @file write-core.ts
 * @description The desktop SQLite WRITE subsystem, extracted from the sqlite.ts
 * orchestrator — everything that mutates the local store: the live-hook lifecycle
 * (createSqliteLifecycle / handleHook), the historical importer
 * (createSqliteImporter + the import phases + the isolated-tx runner), the
 * per-transaction hook primitives (session/agent/event upserts, subagent
 * spawn/match), artifact-link + pull-request persistence, token-cost / token-event
 * writes, and the session-analytics rollup writes (+ boot backfill).
 * `openSqliteAgentDatabase` in `sqlite.ts` wires these into the
 * `SqliteAgentDatabase`. Depends only on leaf modules and the generated Prisma
 * client, never on `sqlite.ts`, so there is no import cycle.
 */
import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import {
  HEADLESS_ENTRYPOINTS,
  HEADLESS_PERMISSION_MODES,
} from "@repo/api/src/session-trace/headless";
import {
  type EstimateTokenCostResult,
  estimateTokenCost,
} from "../../shared/token-cost.js";
import { asRecord } from "../../shared/type-guards.js";
import type {
  HookData,
  HookHarness,
  Importer,
  ImportResult,
  TokenUsageCounts,
} from "../agent-dashboard-db-types.js";
import {
  resolveSessionAttribution,
  type SessionAttributionResolverCache,
} from "../agent-session-sync-service.js";
import { getProjectsDir as getClaudeProjectsDir } from "../collectors/claude/claude-home.js";
import { DATA_REVISION } from "../collectors/engine/data-revision.js";
import { isImportableSourcePath } from "../collectors/engine/source-admission.js";
import {
  type ActivitySegmentRecord,
  activitySegmentId,
  classifyActivitySegments,
} from "../collectors/parsing/activity-segment-classifier.js";
import {
  type ArtifactRefRecord,
  artifactLinkId,
  canonicalKeyForRef,
  extractArtifactRefs,
  extractLaunchMetadataRefs,
} from "../collectors/parsing/artifact-ref-extractor.js";
import { coldReadGate } from "../collectors/parsing/cold-read-gate.js";
import { scanSubagentTranscriptStream } from "../collectors/parsing/subagent-scanner.js";
import type {
  Harness,
  NormalizedSession,
  NormalizedSubagent,
  NormalizedToolUse,
} from "../collectors/types.js";
import {
  defaultBranchSqlList,
  isDefaultBranchName,
} from "../enrichment/default-branch-names.js";
import {
  type ArtifactKind,
  artifactIdFromIdentityKey,
  computeIdentityKey,
} from "../enrichment/identity-key.js";
import {
  ModelPricingCurrency,
  ModelPricingSource,
} from "../model-pricing/model-pricing-fixture.js";
import { CodexOtelTokenUsageSource } from "../otel/codex-otel-contract.js";
import { upsertPullRequest } from "../pull-requests/pr-store.js";
import { reportTokenCostPricingMiss } from "../token-cost-pricing-miss.js";
import { InvalidTokenCountError } from "../token-counts.js";
import {
  BRANCH_PUSH_METHOD_VALUES,
  CLAUDE_NATIVE_SUBAGENT_STEM_PATTERN,
  COMPACTION_RE,
  DESKTOP_AGENT_STATUS,
  DESKTOP_SESSION_STATUS,
  MAX_EVENT_DATA_BYTES,
  RECENT_ACTIVITY_MS,
  TERMINAL_STATUS_SET,
  WAITING_INPUT_RE,
} from "./db-constants.js";
import {
  normalizeRepoFullName,
  normalizeTokenUsageCounts,
  numberFromUnknown,
  parseGitHubPrUrl,
  safe,
  safeJsonParse,
  strOf,
  tokenCountValue,
  truncate,
} from "./db-helpers.js";
import type { TokenUsagePricingRow } from "./db-row-types.js";
import {
  buildEventDedupKey,
  deterministicEventId,
} from "./deterministic-event-id.js";
import type { Prisma } from "./generated/client.js";
import type { DesktopPrisma } from "./prisma-client.js";
import type { createSqliteTokenUsageStore } from "./read-stores.js";
import { createTranscriptCache, type TranscriptExtract } from "./transcript.js";

const defaultTranscriptExtract = createTranscriptCache();

// Push-evidence methods — stamps first_pushed_at on the canonical artifact.
const BRANCH_PUSH_METHODS: ReadonlySet<string> = new Set(
  BRANCH_PUSH_METHOD_VALUES
);

export function createSqliteLifecycle(
  prisma: DesktopPrisma,
  tokenUsage: ReturnType<typeof createSqliteTokenUsageStore>,
  deps: {
    detectBillingMode: (harness: string) => string;
    emit?: (sessionId: string) => void;
    /**
     * Best-effort notice fired once, after the write transaction commits, when a
     * live SessionEnd hook transitions a previously non-terminal session to a
     * terminal status. Used by the main process to surface a desktop completion
     * Notification; never fires for backfill/import (those bypass this lifecycle).
     */
    onSessionTerminal?: (notice: { sessionId: string; status: string }) => void;
    extractTranscript?: (path: string) => TranscriptExtract | null;
    getUserIdentity?: () => {
      userId: string | null;
      organizationId: string | null;
    } | null;
    log: (message: string) => void;
    now: () => string;
    staleMinutes?: number;
  }
) {
  const staleMinutes = deps.staleMinutes ?? 180;
  const extract = deps.extractTranscript ?? defaultTranscriptExtract;

  return {
    async processEvent(
      hookType: string,
      data: HookData,
      // Claude-only: the hook path never sees another harness (Codex hooks were
      // removed, PRD-431). Kept narrow so no non-Claude value can reach handleHook.
      harness: HookHarness
    ): Promise<boolean> {
      const sessionId = data.session_id;
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        return false;
      }
      let transcript: TranscriptExtract | null = null;
      if (data.transcript_path) {
        const transcriptPath = data.transcript_path;
        try {
          // FEA-3132 (B1): the cold transcript extraction buffers the whole file
          // (readFileSync + split). The size-admission gate inside the extractor
          // bounds any single file; routing through the shared coldReadGate also
          // caps how many cold reads run at once so concurrent extractions can't
          // stack their peak buffers in the one db-host heap.
          transcript = await coldReadGate.run(() => extract(transcriptPath));
        } catch (error) {
          if (error instanceof InvalidTokenCountError) {
            deps.log(
              `sqlite lifecycle: failed to process ${hookType}: ${error.message}`
            );
            return false;
          }
          transcript = null;
        }
      }
      const now = deps.now();
      let processed = false;
      let terminalNotice: { sessionId: string; status: string } | null = null;
      // prisma.write serializes through the shared write queue and owns the
      // $transaction; no outer queue.run — nesting a queued op inside another
      // would deadlock the single-slot queue.
      try {
        await prisma.write((client) =>
          client.$transaction(async (tx) => {
            terminalNotice = await handleHook(tx, {
              data,
              hookType,
              harness,
              now,
              sessionId,
              staleMinutes,
              tokenUsage,
              transcript,
              detectBillingMode: deps.detectBillingMode,
              getUserIdentity: deps.getUserIdentity,
            });
          })
        );
        processed = true;
      } catch (error) {
        deps.log(
          `sqlite lifecycle: failed to process ${hookType}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      if (processed) {
        try {
          deps.emit?.(sessionId);
        } catch {
          /* live-update push is best-effort */
        }
        // Fire AFTER the tx commits (never inside it — a rolled-back/retried
        // write must not notify) and only for a genuine live terminal
        // transition, which handleHook signals via a non-null notice.
        if (terminalNotice) {
          try {
            deps.onSessionTerminal?.(terminalNotice);
          } catch {
            /* completion notification is best-effort */
          }
        }
      }
      return processed;
    },
  };
}

async function handleHook(
  tx: Prisma.TransactionClient,
  options: {
    data: HookData;
    hookType: string;
    harness: HookHarness;
    now: string;
    sessionId: string;
    staleMinutes: number;
    tokenUsage: ReturnType<typeof createSqliteTokenUsageStore>;
    transcript: TranscriptExtract | null;
    detectBillingMode: (harness: string) => string;
    getUserIdentity?: () => {
      userId: string | null;
      organizationId: string | null;
    } | null;
  }
): Promise<{ sessionId: string; status: string } | null> {
  const { data, hookType, harness, now, sessionId } = options;
  const main = mainAgentId(sessionId);
  // Set when this hook drives a non-terminal session to a terminal status, so
  // the lifecycle can fire a one-shot completion notification post-commit.
  let terminalNotice: { sessionId: string; status: string } | null = null;
  await ensureSession(
    tx,
    sessionId,
    data,
    harness,
    now,
    options.detectBillingMode,
    options.getUserIdentity
  );
  const session = await getSession(tx, sessionId);
  if (!session) {
    return null;
  }
  await maybeReactivate(tx, session, hookType, now);
  await tx.$executeRawUnsafe(
    "UPDATE sessions SET updated_at = $1 WHERE id = $2",
    now,
    sessionId
  );

  switch (hookType) {
    case "SessionStart":
      await setMainWaiting(tx, sessionId, now);
      await sweepStaleSessions(tx, sessionId, now, options.staleMinutes);
      await insertEvent(
        tx,
        sessionId,
        main,
        "SessionStart",
        data,
        now,
        data.source === "resume" ? "Resumed session" : "Started session"
      );
      break;
    case "UserPromptSubmit":
      await clearAwaitingInput(tx, sessionId, now);
      await promoteMain(tx, main, now);
      await insertEvent(tx, sessionId, main, "UserPromptSubmit", data, now);
      break;
    case "PreToolUse":
      await clearAwaitingInput(tx, sessionId, now);
      if (data.tool_name === "Agent" || data.tool_name === "Task") {
        const agentId = await spawnSubagent(tx, sessionId, data, now);
        await insertEvent(
          tx,
          sessionId,
          agentId,
          "PreToolUse",
          data,
          now,
          "Spawned subagent"
        );
      } else {
        await setAgentTool(tx, main, data.tool_name ?? null, now);
        await insertEvent(tx, sessionId, main, "PreToolUse", data, now);
      }
      break;
    case "PostToolUse": {
      await clearAwaitingInput(tx, sessionId, now);
      const mainAgent = await getAgent(tx, main);
      if (mainAgent && mainAgent.status === DESKTOP_AGENT_STATUS.WORKING) {
        await setAgentTool(tx, main, null, now);
      }
      await insertEvent(tx, sessionId, main, "PostToolUse", data, now);
      break;
    }
    case "Stop":
      if (data.stop_reason === "error") {
        // Stop(error) is the authoritative point where a session first reaches
        // the terminal ERROR status — it lands before SessionEnd, so by the time
        // SessionEnd runs the session is already terminal and cannot detect the
        // error transition. Capture the pre-transition status here and notify on
        // the non-terminal -> error flip (replayed Stop events never re-notify).
        const wasTerminal = TERMINAL_STATUS_SET.has(session.status);
        await setAgentStatus(tx, main, DESKTOP_AGENT_STATUS.ERROR, now);
        await setSessionStatus(
          tx,
          sessionId,
          DESKTOP_SESSION_STATUS.ERROR,
          now
        );
        await clearAwaitingInput(tx, sessionId, now);
        if (!wasTerminal) {
          terminalNotice = { sessionId, status: DESKTOP_SESSION_STATUS.ERROR };
        }
      } else {
        await setMainWaiting(tx, sessionId, now);
      }
      await insertEvent(tx, sessionId, main, "Stop", data, now);
      break;
    case "SubagentStop": {
      const agentId = await matchSubagent(tx, sessionId, data);
      if (agentId) {
        await setAgentStatus(tx, agentId, DESKTOP_AGENT_STATUS.COMPLETED, now);
      }
      await insertEvent(tx, sessionId, agentId, "SubagentStop", data, now);
      if (agentId && data.transcript_path) {
        const subPath = await resolveNativeSubagentTranscriptPath(
          tx,
          agentId,
          sessionId,
          data.transcript_path
        );
        if (subPath) {
          try {
            const subagentResult = await scanSubagentTranscriptStream(
              subPath,
              sessionId,
              agentId
            );
            for (const tu of subagentResult.toolUses) {
              if (tu.toolName && tu.timestamp) {
                let input: unknown | undefined;
                if (tu.input) {
                  try {
                    input = JSON.parse(tu.input);
                  } catch {
                    input = undefined;
                  }
                }
                await insertEvent(
                  tx,
                  sessionId,
                  agentId,
                  "PostToolUse",
                  {
                    tool_name: tu.toolName,
                    tool_use_id: tu.toolUseId ?? undefined,
                    input,
                  } as HookData,
                  tu.timestamp,
                  tu.toolName
                );
              }
            }
          } catch {
            // Non-fatal — subagent transcript may not exist or may be partial.
          }
        }
      }
      break;
    }
    case "Notification": {
      const message = strOf(data.message) ?? "";
      if (COMPACTION_RE.test(message)) {
        await insertEvent(
          tx,
          sessionId,
          main,
          "Compaction",
          data,
          now,
          "Context compaction"
        );
      } else if (WAITING_INPUT_RE.test(message)) {
        await setMainWaiting(tx, sessionId, now);
        await insertEvent(
          tx,
          sessionId,
          main,
          "Notification",
          data,
          now,
          message.slice(0, 200)
        );
      } else {
        await insertEvent(
          tx,
          sessionId,
          main,
          "Notification",
          data,
          now,
          message.slice(0, 200) || undefined
        );
      }
      break;
    }
    case "SessionEnd": {
      await clearAwaitingInput(tx, sessionId, now);
      // Capture the pre-transition status so a replayed SessionEnd on an
      // already-terminal session does not re-notify.
      const wasTerminal = TERMINAL_STATUS_SET.has(session.status);
      const finalStatus =
        session.status === DESKTOP_SESSION_STATUS.ERROR
          ? DESKTOP_SESSION_STATUS.ERROR
          : DESKTOP_SESSION_STATUS.COMPLETED;
      if (!wasTerminal) {
        terminalNotice = { sessionId, status: finalStatus };
      }
      await tx.$executeRawUnsafe(
        `UPDATE agents SET status = $1, ended_at = $2, updated_at = $2 WHERE session_id = $3 AND status NOT IN ('${DESKTOP_AGENT_STATUS.COMPLETED}', '${DESKTOP_AGENT_STATUS.ERROR}')`,
        finalStatus === DESKTOP_SESSION_STATUS.ERROR
          ? DESKTOP_AGENT_STATUS.ERROR
          : DESKTOP_AGENT_STATUS.COMPLETED,
        now,
        sessionId
      );
      await setSessionStatus(tx, sessionId, finalStatus, now);
      await insertEvent(tx, sessionId, main, "SessionEnd", data, now);
      break;
    }
    default:
      await insertEvent(tx, sessionId, main, hookType, data, now);
      break;
  }

  if (options.transcript) {
    if (options.transcript.latestModel) {
      await tx.$executeRawUnsafe(
        "UPDATE sessions SET model = $1, updated_at = $2 WHERE id = $3 AND COALESCE(model, '') != $1",
        options.transcript.latestModel,
        now,
        sessionId
      );
    }
    for (const [model, counts] of options.transcript.tokensByModel) {
      await options.tokenUsage.replace(sessionId, model, counts, now, tx);
    }
    // FEA-1459 (PR #1511 review): the hook transcript only appends — subagent
    // merge (the one source of earlier-timestamped records) happens on the
    // boot path only — so append records past the session's high-water mark
    // instead of delete+reinserting the full set on every hook event. A
    // 1000-turn session would otherwise pay 1000+ inserts per PostToolUse on
    // the serialized write queue. An empty extract inserts nothing and never
    // wipes rows the boot importer derived.
    let appendedTokenEvents: TokenEventRecord[] = [];
    if (options.transcript.records.length > 0) {
      appendedTokenEvents = await appendTokenEvents(
        tx,
        sessionId,
        options.transcript.records
      );
    }
    if (appendedTokenEvents.length > 0) {
      const appendedTokenUsageModels = [
        ...new Set(appendedTokenEvents.map((event) => event.model)),
      ];
      await persistImportedTokenCosts(tx, {
        sessionId,
        harness,
        tokenUsageObservedAt: now,
        tokenUsageModels: appendedTokenUsageModels,
        tokenEvents: appendedTokenEvents,
        tokenEventObservedAtFallback: now,
      });
    }
  }

  // Perf: every hook path above inserts at least one event (created_at = `now`,
  // the new MAX) or sets a session floor; refresh the denormalized cursor sort
  // key once, after all event writes, so the Sessions list orders by the indexed
  // `last_activity_at` column without recomputing MAX(events.created_at) per page.
  await recomputeSessionLastActivityAt(tx, sessionId);
  return terminalNotice;
}

export function createSqliteImporter(
  prisma: DesktopPrisma,
  tokenUsage: ReturnType<typeof createSqliteTokenUsageStore>,
  deps: {
    detectBillingMode: (harness: string) => string;
    now: () => string;
    log: (message: string) => void;
    onPostImport?: (cwd: string | null) => void;
  }
): Importer {
  const attributionCache: SessionAttributionResolverCache = {
    attributionByCwd: new Map(),
    launchMetadataRootByCwd: new Map(),
    repoFullNameByPath: new Map(),
  };
  return {
    async importSession(
      session: NormalizedSession,
      harness: Harness
    ): Promise<ImportResult> {
      if (
        typeof session.sessionId !== "string" ||
        session.sessionId.length === 0 ||
        !session.startedAt
      ) {
        return { skipped: true, reactivated: false };
      }
      const now = deps.now();
      // Each record group commits in its own isolated transaction (see
      // importSessionIsolated) — there is no single import-wide transaction.
      // Per-group failures are handled and tolerated inside; this outer try/catch
      // is a backstop for the pre-transaction context build (filesystem reads for
      // launch metadata).
      try {
        const result = await importSessionIsolated(
          prisma,
          tokenUsage,
          deps,
          session,
          harness,
          now,
          attributionCache
        );
        if (!result.skipped && deps.onPostImport) {
          deps.onPostImport(session.cwd ?? null);
        }
        return result;
      } catch (error) {
        deps.log(
          `sqlite importSession failed for ${session.sessionId}: ${error instanceof Error ? error.message : String(error)}`
        );
        return { skipped: true, reactivated: false, failed: true };
      }
    },
  };
}

/**
 * FEA-1899: upsert the canonical artifact (by identity_key) then insert the
 * pure-join session↔artifact link. The artifact upsert NEVER touches enrichment
 * columns (lines_*, enrichment_state, …) so re-imports don't wipe LOC; it only
 * COALESCE-fills identity fields and bumps last_seen_at. The link is rebuilt on
 * every reparse (delete-then-reinsert upstream) and re-points to the surviving
 * artifact row.
 */
export async function persistArtifactLinks(
  tx: Prisma.TransactionClient,
  sessionId: string,
  refs: ArtifactRefRecord[],
  now: string,
  // Row-level upsert failures (schema drift, constraint violations, a bad ref)
  // are swallowed so the remaining refs still persist — but silently dropping a
  // link leaves the Branches surface with a missing link and zero telemetry.
  // Callers thread their ingest logger through so each swallowed ref emits a
  // warning, matching the file's other best-effort catch sites. Required (not
  // defaulted) so a future caller can't reintroduce the silent-drop by omitting
  // it; callers with no real logger pass an explicit no-op.
  log: (message: string) => void,
  // FEA-2777: callers that persist links for many sessions in one sweep (the
  // boot-time artifact-link backfill) can build the resolver ONCE and pass it
  // in, avoiding a full `SELECT … FROM repos` per session. Omitted on the live
  // import path, which builds it per-session from `tx` below.
  repoResolver?: RepoResolver
): Promise<{ captured: number; droppedUnresolvedBareRepo: boolean }> {
  // Resolve bare repo names (directory basenames like "symphony-alpha") to
  // canonical owner/repo ("closedloop-ai/symphony-alpha") via the repos
  // registry. Without this, identity keys split by naming convention and
  // git_dir stays NULL (blocking all git/gh enrichment).
  const resolver = repoResolver ?? (await buildRepoResolver(tx));

  // FEA-2545: the per-ref writes below used to be a sequential N+1 — two serial
  // awaits per ref (an `artifacts` upsert then a `session_artifact_links`
  // upsert), so a session referencing R artifacts cost ~2R serial DB
  // round-trips on the main ingest path. Every derived value (identity keys,
  // ids, link ids) is a pure function of the ref, so we precompute them in
  // memory and collapse the writes into two multi-row
  // `INSERT … ON CONFLICT DO UPDATE` statements. Both run on this single
  // transaction client, so parallelizing with Promise.all would give no
  // benefit — batching does. On any batch failure we fall back to the original
  // per-ref path, which warn-and-continues on row-level errors, so the ingest
  // stays best-effort.
  const prepared = refs.map((ref) =>
    prepareArtifactRefRow(ref, resolver, sessionId, now)
  );

  // FEA-2875: surface whether any ref's non-null bare repo name was just
  // null-dropped by the (exact) resolver used for this write. The artifact still
  // persists with a NULL repo_full_name, so the backfill's
  // `captured === refs.length` invariant can't detect the drop — it reads this
  // flag to leave the session unseen and retry on a later sweep once the repo
  // lands in `repos`. Computed here (not re-derived by the caller) so the drop
  // decision always matches the resolver that actually persisted the row.
  const droppedUnresolvedBareRepo = prepared.some((p) => p.droppedBareRepo);

  let captured: number;
  try {
    captured = await persistArtifactRefsBatched(tx, prepared, sessionId);
  } catch (error) {
    // The fast path is normally silent-on-failure because the per-ref fallback
    // re-attempts every ref and warns on each true row-level drop. But a
    // systematic cause (schema drift, a malformed statement) surfaces FIRST as
    // this batch throw, so record it too — otherwise a batch-only failure the
    // fallback then recovers from leaves no signal that the fast path broke.
    log(
      `sqlite persistArtifactLinks: batched upsert failed for session ${sessionId}, falling back to per-ref: ${error instanceof Error ? error.message : String(error)}`
    );
    captured = await persistArtifactRefsRowByRow(tx, prepared, sessionId, log);
  }

  // Link propagation: if this session is linked to a branch that has a known
  // PR artifact, auto-link the session to the PR. Pure DB lookup — no gh calls.
  await propagateBranchPrLinks(tx, sessionId, now);

  return { captured, droppedUnresolvedBareRepo };
}

// FEA-2545: shared column lists and ON CONFLICT clauses so the batched fast
// path and the per-ref fallback issue byte-identical upserts (only the VALUES
// tuple count differs).
const ARTIFACT_UPSERT_COLUMNS =
  "(id, identity_key, kind, repo_full_name, git_dir, sha, branch_name, pr_number, slug, url, title, committed_at, created_at, last_seen_at)";
const ARTIFACT_UPSERT_CONFLICT = `ON CONFLICT(id) DO UPDATE SET
     last_seen_at = EXCLUDED.last_seen_at,
     repo_full_name = COALESCE(artifacts.repo_full_name, EXCLUDED.repo_full_name),
     git_dir = COALESCE(artifacts.git_dir, EXCLUDED.git_dir),
     url = COALESCE(artifacts.url, EXCLUDED.url),
     branch_name = COALESCE(artifacts.branch_name, EXCLUDED.branch_name),
     sha = COALESCE(artifacts.sha, EXCLUDED.sha),
     -- PRD-486: first non-null wins; the per-commit LOC enrichment may later
     -- overwrite committed_at with the exact git committer date directly.
     title = COALESCE(artifacts.title, EXCLUDED.title),
     committed_at = COALESCE(artifacts.committed_at, EXCLUDED.committed_at)
   WHERE artifacts.identity_key = EXCLUDED.identity_key`;
const LINK_UPSERT_COLUMNS =
  "(id, session_id, artifact_id, relation, method, evidence, is_primary, status, extractor_version, observed_at, created_at)";
const LINK_UPSERT_CONFLICT = `ON CONFLICT(session_id, artifact_id, relation) DO UPDATE SET
     method = EXCLUDED.method,
     evidence = EXCLUDED.evidence,
     status = EXCLUDED.status,
     observed_at = EXCLUDED.observed_at,
     extractor_version = EXCLUDED.extractor_version`;

// A ref reduced to its two upsert rows. Identity keys, ids and link ids are
// pure functions of the ref, so preparing them up front lets the batched path
// build both multi-row statements without any interleaved awaits.
type PreparedArtifactRef = {
  identityKey: string;
  artifactId: string;
  linkId: string;
  artifactValues: unknown[];
  linkValues: unknown[];
  // Retained so the batched fast path and the row-by-row fallback can apply the
  // per-ref set-once side effects (branch push state, FEA-2531 PR head branch)
  // that the sequential loop used to run inline after each successful upsert.
  ref: ArtifactRefRecord;
  // FEA-2875: this ref carried a non-null BARE repo name that the write path
  // null-dropped (below). The artifact still persists (with a NULL
  // repo_full_name), so the backfill's `captured === refs.length` check stays
  // satisfied — the boot backfill reads this to avoid stamping the session seen
  // while its repo is unresolved. See `persistArtifactLinks`' return value.
  droppedBareRepo: boolean;
};

// FEA-2866: the parser derives session.artifacts.repo from the cwd's last path
// component (extractRepoFromCwd), so worktree dirs (`agent-<hash>`), temp dirs
// (`nrev-*`), and plain repo folders all arrive here as BARE names with no
// owner. Persisting those made them surface as bogus "repositories" in the repo
// breakdowns. Prefer the git-validated repos-table resolution; otherwise keep
// the value ONLY when it is already a valid `owner/repo` slug (e.g. parsed from
// a PR/issue URL) and drop any unvalidated bare basename to null, so it groups
// under "Unknown" instead of a fake repository. Reuse the file's own
// `normalizeRepoFullName` validator (returns null on anything but a valid
// owner/repo) rather than a loose `includes("/")` check. gitDir already follows
// the resolver, so it stays null for dropped values.
function resolveRefRepo(
  ref: Pick<ArtifactRefRecord, "repoFullName">,
  repoResolver: RepoResolver
): { repoFullName: string | null; gitDir: string | null } {
  const resolved = repoResolver(ref.repoFullName ?? null);
  return {
    repoFullName:
      resolved?.repoFullName ?? normalizeRepoFullName(ref.repoFullName),
    gitDir: resolved?.gitDir ?? null,
  };
}

function prepareArtifactRefRow(
  ref: ArtifactRefRecord,
  repoResolver: RepoResolver,
  sessionId: string,
  now: string
): PreparedArtifactRef {
  const { repoFullName: resolvedRepoFullName, gitDir: resolvedGitDir } =
    resolveRefRepo(ref, repoResolver);
  // FEA-2875: a non-null bare name that neither the repos-table resolver nor the
  // `owner/repo` validator recovered was just dropped to null. A ref that never
  // carried a repo (null repoFullName) is NOT a drop — only a real bare name
  // that failed to resolve is.
  const droppedBareRepo =
    ref.repoFullName != null && resolvedRepoFullName === null;

  const identityKey = computeIdentityKey({
    kind: ref.targetKind as ArtifactKind,
    repoFullName: resolvedRepoFullName,
    gitDir: resolvedGitDir,
    sha: ref.sha ?? null,
    branchName: ref.branchName ?? null,
    prNumber: ref.prNumber ?? null,
    slug: ref.slug ?? null,
  });
  // The upsert's ON CONFLICT target is `id`, so the RETURNING id is always this
  // candidate id — we can use it directly as the link's artifact_id.
  const artifactId = artifactIdFromIdentityKey(identityKey);
  const linkId = artifactLinkId(
    sessionId,
    ref.targetKind,
    canonicalKeyForRef(ref),
    ref.relation
  );

  return {
    identityKey,
    artifactId,
    linkId,
    artifactValues: [
      artifactId,
      identityKey,
      ref.targetKind,
      resolvedRepoFullName,
      resolvedGitDir,
      ref.sha ?? null,
      ref.branchName ?? null,
      ref.prNumber ?? null,
      ref.slug ?? null,
      ref.prUrl ?? null,
      ref.message ?? null,
      ref.committedAt ?? null,
      now, // created_at
      now, // last_seen_at
    ],
    linkValues: [
      linkId,
      sessionId,
      artifactId,
      ref.relation,
      ref.method,
      ref.evidence,
      ref.isPrimary,
      "candidate",
      ref.extractorVersion,
      ref.observedAt,
      now,
    ],
    ref,
    droppedBareRepo,
  };
}

// Per-ref set-once side effects that the sequential loop ran inline after each
// successful artifact+link upsert. Preserved here so the batched fast path and
// the row-by-row fallback both apply them for every ref whose artifact
// persisted. Only branch-push refs and created-PR refs issue a write; all
// others short-circuit, so this adds no round-trips for the common case.
async function applyPersistedRefSideEffects(
  tx: Prisma.TransactionClient,
  ref: ArtifactRefRecord,
  artifactId: string,
  sessionId: string
): Promise<void> {
  // Set-once, earliest-wins push state on artifacts (not the link row, which is
  // wiped per reparse) so it survives the reparse cycle. MIN() keeps the
  // earliest push; COALESCE on push_source is set-once.
  if (
    ref.targetKind === "branch" &&
    BRANCH_PUSH_METHODS.has(ref.method) &&
    ref.observedAt
  ) {
    await tx.$executeRawUnsafe(
      `UPDATE artifacts
         SET first_pushed_at = MIN(COALESCE(first_pushed_at, $2), $2),
             push_source = COALESCE(push_source, 'session')
       WHERE id = $1`,
      artifactId,
      ref.observedAt
    );
  }
  // FEA-2531: a created-PR ref's re-derived head branch must reach the
  // pull_requests lifecycle row too. The IMPORT path writes it via
  // persistNormalizedPullRequests, but historical re-derivation flows only
  // through here, and the Branches page joins branch↔PR on
  // pull_requests.branch_name — without this, a worktree PR's head ref is
  // resolved by the extractor and then dropped for every already-imported
  // session. FILL-ONLY: an existing value may be import-authoritative or
  // GitHub-enriched (headRefName) and must not be clobbered or cleared.
  if (
    ref.targetKind === "pull_request" &&
    ref.relation === "created" &&
    ref.prUrl &&
    ref.branchName &&
    !isDefaultBranchName(ref.branchName)
  ) {
    await tx.$executeRawUnsafe(
      `UPDATE pull_requests
          SET branch_name = $3
        WHERE session_id = $1 AND pr_url = $2 AND branch_name IS NULL`,
      sessionId,
      ref.prUrl,
      ref.branchName
    );
  }
}

// Build a `($n, $n+1, …)` VALUES tuple for `count` params starting after the
// `base` params already accumulated.
function sqlValuesTuple(base: number, count: number): string {
  const cells: string[] = [];
  for (let i = 1; i <= count; i++) {
    cells.push(`$${base + i}`);
  }
  return `(${cells.join(", ")})`;
}

// Column counts for the two upserts, mirroring ARTIFACT_UPSERT_COLUMNS (14) and
// LINK_UPSERT_COLUMNS (11). Used to cap rows per multi-row statement so the
// bound-parameter count stays under the SQLite/libSQL variable limit — same
// discipline as the chunked event inserts (EVENT_INSERT_PARAM_CAP).
const ARTIFACT_UPSERT_COLUMN_COUNT = 14;
const LINK_UPSERT_COLUMN_COUNT = 11;
// Indices into `artifactValues` of every column ARTIFACT_UPSERT_CONFLICT
// COALESCE-fills: repo_full_name(3), git_dir(4), sha(5), branch_name(6), url(9),
// title(10), committed_at(11). Two refs sharing an identity key can carry a
// non-null value for one of these (e.g. a PR ref supplies branch_name that a
// transcript ref left null), so the batched dedup must merge all of them to
// match the sequential per-ref COALESCE — merging identity-equal columns is a
// harmless no-op. (id/identity_key/kind/pr_number/slug are not COALESCE targets.)
const ARTIFACT_COALESCE_VALUE_INDICES = [3, 4, 5, 6, 9, 10, 11];

// Split rows into chunks whose total bound-parameter count stays under the
// per-statement variable cap.
function chunkRowsByParamCap(
  rows: unknown[][],
  columnCount: number
): unknown[][][] {
  const rowsPerChunk = Math.max(
    1,
    Math.floor(EVENT_INSERT_PARAM_CAP / columnCount)
  );
  const chunks: unknown[][][] = [];
  for (let i = 0; i < rows.length; i += rowsPerChunk) {
    chunks.push(rows.slice(i, i + rowsPerChunk));
  }
  return chunks;
}

// Build the `VALUES (...), (...)` tuple list and flat param array for one chunk.
function buildValuesTuples(rows: unknown[][]): {
  tuples: string[];
  params: unknown[];
} {
  const tuples: string[] = [];
  const params: unknown[] = [];
  for (const row of rows) {
    tuples.push(sqlValuesTuple(params.length, row.length));
    params.push(...row);
  }
  return { tuples, params };
}

// FEA-2545 fast path: collapse all refs into two multi-row upserts, chunked to
// respect the variable cap. Returns the number of refs whose artifact persisted
// (matching the per-ref path's `captured`, which the backfill relies on via
// `captured === refs.length`).
async function persistArtifactRefsBatched(
  tx: Prisma.TransactionClient,
  prepared: PreparedArtifactRef[],
  sessionId: string
): Promise<number> {
  if (prepared.length === 0) {
    return 0;
  }

  // Dedupe artifacts by id so no multi-row VALUES lists the same ON CONFLICT
  // target twice (which the engine rejects). Refs sharing an identity key have
  // identical identity-derived columns; the remaining COALESCE-filled columns
  // are merged first-non-null-wins, matching the sequential per-ref COALESCE
  // the original loop performed.
  const artifactRowsById = new Map<string, unknown[]>();
  for (const row of prepared) {
    const existing = artifactRowsById.get(row.artifactId);
    if (existing) {
      for (const i of ARTIFACT_COALESCE_VALUE_INDICES) {
        if (existing[i] === null && row.artifactValues[i] !== null) {
          existing[i] = row.artifactValues[i];
        }
      }
    } else {
      artifactRowsById.set(row.artifactId, [...row.artifactValues]);
    }
  }

  const persistedArtifactIds = new Set<string>();
  for (const chunk of chunkRowsByParamCap(
    [...artifactRowsById.values()],
    ARTIFACT_UPSERT_COLUMN_COUNT
  )) {
    const { tuples, params } = buildValuesTuples(chunk);
    const artifactRows = await tx.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO artifacts
         ${ARTIFACT_UPSERT_COLUMNS}
       VALUES ${tuples.join(", ")}
       ${ARTIFACT_UPSERT_CONFLICT}
       RETURNING id`,
      ...params
    );
    for (const artifact of artifactRows) {
      persistedArtifactIds.add(artifact.id);
    }
  }

  // Only refs whose artifact actually persisted get a link. A missing id means
  // the candidate id collided with a row under a different identity key (the
  // WHERE guard rejected the update) — the per-ref path surfaced this via
  // requireArtifactUpsertId and skipped the ref; we skip it here the same way.
  const linkable = prepared.filter((row) =>
    persistedArtifactIds.has(row.artifactId)
  );
  if (linkable.length === 0) {
    return 0;
  }

  // Dedupe the link batch by link id so no multi-row VALUES repeats an ON
  // CONFLICT target. `captured` still counts every persisted ref, so duplicate
  // refs collapse in the write but not in the returned count. Keep the LAST ref
  // per link id (unconditional set): LINK_UPSERT_CONFLICT overwrites unconditionally
  // (method/evidence/status/... = EXCLUDED.*), so the sequential per-ref path let
  // the last ref win — e.g. an appended launch_metadata ref must supersede an
  // earlier slug_in_message ref for the same session/artifact/relation.
  const linkRowsById = new Map<string, unknown[]>();
  for (const row of linkable) {
    linkRowsById.set(row.linkId, row.linkValues);
  }
  for (const chunk of chunkRowsByParamCap(
    [...linkRowsById.values()],
    LINK_UPSERT_COLUMN_COUNT
  )) {
    const { tuples, params } = buildValuesTuples(chunk);
    await tx.$executeRawUnsafe(
      `INSERT INTO session_artifact_links
         ${LINK_UPSERT_COLUMNS}
       VALUES ${tuples.join(", ")}
       ${LINK_UPSERT_CONFLICT}`,
      ...params
    );
  }

  // Per-ref set-once side effects, applied for every ref whose artifact
  // persisted — matching the sequential loop, which ran them inline after each
  // successful upsert.
  for (const row of linkable) {
    await applyPersistedRefSideEffects(tx, row.ref, row.artifactId, sessionId);
  }

  return linkable.length;
}

// FEA-2545 fallback: the original one-upsert-pair-per-ref path, used only when
// the batch statement fails. Preserves warn-and-continue: a row-level failure
// is swallowed and the remaining refs still persist.
async function persistArtifactRefsRowByRow(
  tx: Prisma.TransactionClient,
  prepared: PreparedArtifactRef[],
  sessionId: string,
  log: (message: string) => void
): Promise<number> {
  let captured = 0;
  for (const row of prepared) {
    try {
      const artifactRows = await tx.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO artifacts
           ${ARTIFACT_UPSERT_COLUMNS}
         VALUES ${sqlValuesTuple(0, row.artifactValues.length)}
         ${ARTIFACT_UPSERT_CONFLICT}
         RETURNING id`,
        ...row.artifactValues
      );
      // Throws (caught below) on an identity-key collision, matching the
      // original guard; the returned id equals row.artifactId used in the link.
      requireArtifactUpsertId(
        artifactRows[0]?.id,
        row.artifactId,
        row.identityKey
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO session_artifact_links
           ${LINK_UPSERT_COLUMNS}
         VALUES ${sqlValuesTuple(0, row.linkValues.length)}
         ${LINK_UPSERT_CONFLICT}`,
        ...row.linkValues
      );
      await applyPersistedRefSideEffects(
        tx,
        row.ref,
        row.artifactId,
        sessionId
      );
      captured++;
    } catch (error) {
      // Row-level failure: log warning, continue processing other refs. A
      // systematic cause (schema drift, constraint violation, bad ref) would
      // otherwise drop artifact links silently, leaving the Branches surface
      // with missing links and no telemetry to trace them back.
      log(
        `sqlite persistArtifactLinks: dropped artifact ref for session ${sessionId} (artifact ${row.artifactId}, kind ${row.ref.targetKind}): ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return captured;
}

// PRD-486: an artifact upsert must return the row id; a missing id means the
// ON CONFLICT path raced or the identity key collided, which we surface rather
// than silently linking to a candidate id that was never persisted.
function requireArtifactUpsertId(
  returnedId: string | undefined,
  candidateId: string,
  identityKey: string
): string {
  if (returnedId) {
    return returnedId;
  }
  throw new Error(`artifact id collision for ${candidateId} (${identityKey})`);
}

async function propagateBranchPrLinks(
  tx: Prisma.TransactionClient,
  sessionId: string,
  now: string
): Promise<void> {
  // Find open PR artifacts whose head branch matches a branch this session is
  // linked to, joining through pull_requests for the correct branch↔PR mapping.
  const prArtifacts = await tx.$queryRawUnsafe<
    { pr_id: string; identity_key: string }[]
  >(
    `SELECT DISTINCT pr_art.id AS pr_id, pr_art.identity_key
     FROM session_artifact_links sal
     JOIN artifacts branch ON sal.artifact_id = branch.id
       AND branch.kind = 'branch'
       AND branch.repo_full_name IS NOT NULL
     JOIN pull_requests pr ON pr.repo_full_name = branch.repo_full_name
       AND pr.branch_name = branch.branch_name
       AND pr.pr_number IS NOT NULL
       AND pr.branch_name NOT IN (${defaultBranchSqlList()})
     JOIN artifacts pr_art ON pr_art.kind = 'pull_request'
       AND pr_art.repo_full_name = pr.repo_full_name
       AND pr_art.pr_number = pr.pr_number
       AND COALESCE(pr_art.pr_state, 'open') NOT IN ('merged', 'closed')
     WHERE sal.session_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM session_artifact_links ex
         WHERE ex.session_id = $1 AND ex.artifact_id = pr_art.id
           AND ex.relation = 'workspace'
       )`,
    sessionId
  );

  for (const row of prArtifacts) {
    try {
      const linkId = artifactLinkId(
        sessionId,
        "pull_request",
        row.identity_key,
        "workspace"
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO session_artifact_links
           (id, session_id, artifact_id, relation, method, evidence, is_primary,
            status, extractor_version, observed_at, created_at)
         VALUES ($1,$2,$3,'workspace','branch_pr_association','{}',0,
                 'candidate',1,$4,$4)
         ON CONFLICT(session_id, artifact_id, relation) DO NOTHING`,
        linkId,
        sessionId,
        row.pr_id,
        now
      );
    } catch {
      // Non-critical — link will be retried on next import
    }
  }
}

type ResolvedRepo = { repoFullName: string; gitDir: string };

/** Resolves a bare or full repo name to its canonical owner/repo + git_dir. */
export type RepoResolver = (bareOrFull: string | null) => ResolvedRepo | null;

// The only DB capability buildRepoResolver needs. Kept structural (rather than a
// full `Prisma.TransactionClient`) so it can also be built from the read-only
// desktop client — letting a caller build the resolver ONCE outside the write
// transaction and reuse it (FEA-2777).
type RepoResolverSource = Pick<Prisma.TransactionClient, "$queryRawUnsafe">;

export async function buildRepoResolver(
  source: RepoResolverSource
): Promise<RepoResolver> {
  const rows = await source.$queryRawUnsafe<
    {
      repo_full_name: string;
      git_dir: string;
    }[]
  >(
    "SELECT repo_full_name, git_dir FROM repos WHERE repo_full_name IS NOT NULL AND git_dir != ''"
  );

  // Index by exact full name and by bare trailing component (the repo dir name).
  // Bare-name collisions are theoretically possible (two orgs, same repo name);
  // the first match wins — good enough for desktop-local resolution.
  const byFull = new Map<string, ResolvedRepo>();
  const byBare = new Map<string, ResolvedRepo>();
  for (const row of rows) {
    const entry: ResolvedRepo = {
      repoFullName: row.repo_full_name,
      gitDir: row.git_dir,
    };
    byFull.set(row.repo_full_name, entry);
    // git_dir is like "/home/user/Workspace/symphony-alpha/.git"
    const dirName = row.git_dir
      .replace(/\/\.git\/?$/, "")
      .split("/")
      .at(-1);
    if (dirName) {
      byBare.set(dirName, entry);
    }
  }

  return (bareOrFull: string | null): ResolvedRepo | null => {
    if (!bareOrFull) {
      return null;
    }
    if (bareOrFull.includes("/")) {
      return byFull.get(bareOrFull) ?? null;
    }
    if (byBare.has(bareOrFull)) {
      return byBare.get(bareOrFull)!;
    }
    // Worktree suffix heuristic: strip -<type>-<identifier> patterns
    const suffixMatch = bareOrFull.match(
      /^(.+)[-_](?:fea|feat|fix|pr|pln|prd|wg-review|AI)[-_].+$/i
    );
    if (suffixMatch?.[1] && byBare.has(suffixMatch[1])) {
      return byBare.get(suffixMatch[1])!;
    }
    return null;
  };
}

/**
 * perf: conservative cap on bound parameters per chunked multi-row INSERT in the
 * import path. SQLite/libSQL default `SQLITE_MAX_VARIABLE_NUMBER` is 999 (older)
 * / 32766 (newer); staying near ~900 keeps each statement safe on every build
 * while still collapsing thousands of per-row round-trips into a handful.
 */
const EVENT_INSERT_PARAM_CAP = 900;

/**
 * Pure, transaction-independent state derived once per import and shared across
 * the per-record phases below. None of these values touch the database (they
 * read the parsed session and, for artifact refs, the filesystem), so deriving
 * them up front lets each phase run in its own isolated transaction (normal
 * ingest, {@link importSessionIsolated}) — or all on one shared transaction
 * (rebuild, {@link importSessionWithTx}) — without recomputing or holding a write
 * connection open while deriving.
 */
type ImportSessionContext = {
  session: NormalizedSession;
  harness: Harness;
  now: string;
  recentlyActive: boolean;
  mainId: string;
  tokenSeries: NormalizedSession["tokenSeries"];
  earliestTokenTs: string | null;
  tokenEventsRecords: TokenEventRecord[];
  activitySegments: ActivitySegmentRecord[];
  artifactRefs: ArtifactRefRecord[];
  createdPrHeadBranches: Map<string, string | null>;
  tokenUsage: ReturnType<typeof createSqliteTokenUsageStore>;
  detectBillingMode: (harness: string) => string;
  // Threaded to persistArtifactLinks so a swallowed row-level upsert failure
  // emits a warning instead of dropping the link silently (see that function).
  log: (message: string) => void;
};

function buildImportSessionContext(
  tokenUsage: ReturnType<typeof createSqliteTokenUsageStore>,
  deps: {
    detectBillingMode: (harness: string) => string;
    log: (message: string) => void;
  },
  session: NormalizedSession,
  harness: Harness,
  now: string,
  attributionCache: SessionAttributionResolverCache
): ImportSessionContext {
  const nowMs = Date.parse(now);
  const recentlyActive =
    session.fileModifiedAt != null &&
    Number.isFinite(session.fileModifiedAt) &&
    (Number.isNaN(nowMs) ? Date.now() : nowMs) - session.fileModifiedAt <
      RECENT_ACTIVITY_MS;
  const mainId = mainAgentId(session.sessionId);
  // FEA-1459 Fix 5: earliest token timestamp drives created_at for token rows.
  const tokenSeries = session.tokenSeries ?? [];
  const earliestTokenTs =
    tokenSeries.length > 0
      ? tokenSeries.reduce(
          (min, r) => (r.timestamp < min ? r.timestamp : min),
          tokenSeries[0].timestamp
        )
      : session.startedAt;
  // FEA-1459 Fix C: if tokenSeries is empty but tokensByModel is not, synthesize
  // one fallback record per model (all four parsers populate tokenSeries today;
  // guard for safety). Mirrors the legacy in-transaction derivation exactly.
  const tokenEventsRecords: TokenEventRecord[] =
    tokenSeries.length > 0
      ? tokenSeries
      : Object.entries(session.tokensByModel ?? {}).map(([model, counts]) => ({
          timestamp: session.startedAt ?? now,
          model,
          input: counts.input,
          output: counts.output,
          cacheRead: counts.cacheRead,
          cacheWrite: counts.cacheWrite,
        }));
  // FEA-1684: artifact refs come from the transcript plus launch metadata
  // (.closedloop-ai/work/launch-metadata.json), which lives outside the
  // transcript. Both are filesystem/in-memory derivations — resolve them here,
  // before any transaction, so no write connection is held open while reading.
  const launchAttribution = resolveSessionAttribution(
    session.cwd,
    attributionCache
  );
  const launchRefs = extractLaunchMetadataRefs(
    launchAttribution?.sourceArtifactId
      ? { sourceArtifactId: launchAttribution.sourceArtifactId }
      : null,
    now
  );
  const artifactRefs = [...extractArtifactRefs(session, now), ...launchRefs];
  // FEA-2267/FEA-2269: the activity-phase tiling is a pure, deterministic
  // derivation of the parsed session (no DB, no clock), so it is computed up
  // front alongside the other pre-transaction context and persisted by
  // importPhaseActivitySegments. `harness` selects the FEA-2268 evidence adapter.
  const activitySegments = classifyActivitySegments(session, harness);
  // A PR's head branch is only trustworthy for PRs this session CREATED (the
  // extractor stamps the branch active at `gh pr create` time). Map those to
  // their head branch; never let a later null clobber a known branch.
  const createdPrHeadBranches = new Map<string, string | null>();
  for (const ref of artifactRefs) {
    if (
      ref.targetKind !== "pull_request" ||
      ref.relation !== "created" ||
      !ref.repoFullName ||
      ref.prNumber == null
    ) {
      continue;
    }
    const key = `${ref.repoFullName}#${ref.prNumber}`;
    const branch = ref.branchName ?? null;
    if (
      !createdPrHeadBranches.has(key) ||
      (branch && !createdPrHeadBranches.get(key))
    ) {
      createdPrHeadBranches.set(key, branch);
    }
  }
  return {
    session,
    harness,
    now,
    recentlyActive,
    mainId,
    tokenSeries,
    earliestTokenTs,
    tokenEventsRecords,
    activitySegments,
    artifactRefs,
    createdPrHeadBranches,
    tokenUsage,
    detectBillingMode: deps.detectBillingMode,
    log: deps.log,
  };
}

/**
 * Record group 1 (GATING): the session row and its main agent. Every other row
 * is an FK child of these, so the isolated orchestrator aborts the import if
 * this phase fails. Idempotent: existing sessions are COALESCE-updated and the
 * main agent is ON CONFLICT DO NOTHING, so a re-import never clobbers live state.
 */
async function importPhaseSessionAndMainAgent(
  tx: Prisma.TransactionClient,
  ctx: ImportSessionContext
): Promise<{ existed: boolean; reactivated: boolean }> {
  const { session, harness, now, recentlyActive, mainId, detectBillingMode } =
    ctx;
  const existing = await getImportSession(tx, session.sessionId);
  let reactivated = false;

  if (existing) {
    const billingMode = safe(() => detectBillingMode(harness)) ?? "unknown";
    await tx.$executeRawUnsafe(
      `UPDATE sessions SET
        name = COALESCE(name, $1),
        model = COALESCE(model, $2),
        cwd = COALESCE(cwd, $3),
        harness = CASE WHEN COALESCE(harness, '') = '' THEN $4 ELSE harness END,
        billing_mode = CASE WHEN COALESCE(billing_mode, '') IN ('', 'unknown') THEN $5 ELSE billing_mode END,
        metadata = $6,
        data_revision = $7,
        updated_at = $8
       WHERE id = $9`,
      session.name ?? null,
      session.model ?? null,
      session.cwd ?? null,
      harness,
      billingMode,
      buildImportMetadata(session, harness),
      DATA_REVISION,
      now,
      session.sessionId
    );
    const isLive =
      existing.status === DESKTOP_SESSION_STATUS.ACTIVE &&
      existing.endedAt == null;
    if (recentlyActive && !isLive) {
      await tx.$executeRawUnsafe(
        "UPDATE sessions SET status = 'active', ended_at = NULL, updated_at = $1 WHERE id = $2",
        now,
        session.sessionId
      );
      // Gap 7: Stamp awaiting_input_since so the dashboard Kanban board
      // places the session in the Waiting column (matches SessionStart
      // behavior in the live-hook path).
      await tx.$executeRawUnsafe(
        "UPDATE agents SET status = 'waiting', ended_at = NULL, current_tool = NULL, awaiting_input_since = $1, updated_at = $1 WHERE id = $2",
        now,
        mainId
      );
      reactivated = true;
    }
    // FEA-1785: Ensure the main agent row exists unconditionally. The rebuild
    // pass deletes all agents rows before re-importing, so a previously-imported
    // session may lack its main agent. ON CONFLICT DO NOTHING is safe when the
    // agent already exists (normal non-rebuild import path).
    // Status must reflect the session's POST-reactivation state: a rebuilt
    // terminal session inside the recent-activity window was just flipped to
    // 'active' above (and the agent UPDATE no-oped on the missing row), so the
    // recreated main agent must be 'waiting', not 'completed'.
    const sessionActiveNow = isLive || reactivated;
    const mainAgentTerminal =
      !sessionActiveNow && TERMINAL_STATUS_SET.has(existing.status);
    const agentStatus = mainAgentTerminal
      ? DESKTOP_AGENT_STATUS.COMPLETED
      : DESKTOP_AGENT_STATUS.WAITING;
    const agentEndedAt = mainAgentTerminal ? (existing.endedAt ?? now) : null;
    await tx.$executeRawUnsafe(
      `INSERT INTO agents (id, session_id, name, type, subagent_type, status, task, current_tool, started_at, updated_at, ended_at, parent_agent_id, metadata)
       VALUES ($1, $2, 'main', 'main', NULL, $3, NULL, NULL, $4, $5, $6, NULL, NULL)
       ON CONFLICT (id) DO NOTHING`,
      mainId,
      session.sessionId,
      agentStatus,
      session.startedAt,
      now,
      agentEndedAt
    );
  } else {
    const status = recentlyActive
      ? DESKTOP_SESSION_STATUS.ACTIVE
      : DESKTOP_SESSION_STATUS.COMPLETED;
    const billingMode = safe(() => detectBillingMode(harness)) ?? "unknown";
    await tx.$executeRawUnsafe(
      `INSERT INTO sessions (id, name, status, cwd, model, started_at, updated_at, ended_at, harness, billing_mode, metadata, data_revision)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      session.sessionId,
      session.name ?? null,
      status,
      session.cwd ?? null,
      session.model ?? null,
      session.startedAt,
      session.endedAt ?? session.startedAt,
      status === DESKTOP_SESSION_STATUS.COMPLETED
        ? (session.endedAt ?? null)
        : null,
      harness,
      billingMode,
      buildImportMetadata(session, harness),
      DATA_REVISION
    );
    // Gap 7: For recently-active sessions, stamp awaiting_input_since so the
    // dashboard Kanban board places the session in the Waiting column.
    const awaitingSince =
      recentlyActive && status !== DESKTOP_SESSION_STATUS.COMPLETED
        ? now
        : null;
    await tx.$executeRawUnsafe(
      `INSERT INTO agents (id, session_id, name, type, subagent_type, status, task, current_tool, awaiting_input_since, started_at, updated_at, ended_at, parent_agent_id, metadata)
       VALUES ($1, $2, 'main', 'main', NULL, $3, NULL, NULL, $4, $5, $6, $7, NULL, NULL)`,
      mainId,
      session.sessionId,
      status === DESKTOP_SESSION_STATUS.COMPLETED
        ? DESKTOP_AGENT_STATUS.COMPLETED
        : DESKTOP_AGENT_STATUS.WAITING,
      awaitingSince,
      session.startedAt,
      now,
      status === DESKTOP_SESSION_STATUS.COMPLETED
        ? (session.endedAt ?? now)
        : null
    );
  }

  return { existed: existing != null, reactivated };
}

/**
 * Record group 2: events (and the subagent agent rows interleaved with them).
 * A single atomic delete-then-reinsert: the FEA-1459 purge of import-derived
 * rows, the post-purge high-water-mark read, and the buffered chunked re-insert
 * all commit together so the events table is never observed mid-rewrite. This
 * is the perf-tuned phase — events are buffered and flushed in chunked multi-row
 * INSERTs rather than one round-trip per row.
 */
async function importPhaseEvents(
  tx: Prisma.TransactionClient,
  ctx: ImportSessionContext
): Promise<{ inserted: number }> {
  const { session, now, mainId } = ctx;
  // FEA-1459 (PR #1511 review): purge import-derived rows before re-deriving,
  // so a forced reimport (PERSIST_VERSION bump, subagent-mtime change) cannot
  // stack new rows next to stale residue from the v1 pipeline (idx-keyed
  // subagent ids doubling agentCount, per-content-block Stop events inflating
  // heatmaps, 14k+ duplicate tool events).
  // - agents: the `-sub-` id infix is the subagent namespace shared by this
  //   importer and the live-hook spawner. Only terminal rows are purged:
  //   a status='working' hook row must survive so matchSubagent can resolve
  //   the upcoming SubagentStop. Any transient double (working hook row +
  //   completed import row for the same logical subagent) converges on the
  //   next reimport, which the finished subagent's transcript append
  //   guarantees.
  // - events: exactly the types this importer re-derives below. Hook-only
  //   types (Notification, SessionStart/End, UserPromptSubmit, ...) are
  //   untouched. The high-water-mark query below runs AFTER the purge, so the
  //   re-derived events insert with an empty HWM for these types.
  await tx.$executeRawUnsafe(
    `DELETE FROM agents WHERE session_id = $1 AND type = 'subagent'
       AND (id LIKE '%-sub-%' OR id LIKE '%-parser-sub-%') AND status IN ('completed', 'error')`,
    session.sessionId
  );
  await tx.$executeRawUnsafe(
    `DELETE FROM events WHERE session_id = $1 AND event_type IN
       ('Stop', 'PreToolUse', 'PostToolUse', 'TurnDuration', 'APIError', 'ToolError', 'Compaction')`,
    session.sessionId
  );

  const highWater = new Map<string, string>();
  const hwm = await tx.event.groupBy({
    by: ["eventType"],
    where: { sessionId: session.sessionId },
    _max: { createdAt: true },
  });
  for (const row of hwm) {
    if (row._max.createdAt) {
      highWater.set(row.eventType, row._max.createdAt);
    }
  }

  let inserted = 0;
  // FEA-1459 Fix 7: Per-import dedup set to prevent exact (type, ts, toolName)
  // duplicates within a single import run (14,520 were duplicates before fix).
  const importEventSeen = new Set<string>();
  // perf: buffer per-event rows here and flush them in chunked multi-row
  // INSERTs (see flushEventBuffer) instead of one round-trip per event. A
  // large session can carry thousands of events; one INSERT per row inside the
  // transaction was the dominant import cost. Buffering preserves ordering,
  // columns, and the ON CONFLICT (id) DO NOTHING semantics exactly — the same
  // rows are written, just in fewer statements.
  const eventRowBuffer: [
    string, // id
    string, // session_id
    string, // agent_id
    string, // event_type
    string | null, // tool_name
    string | null, // summary
    string | null, // data
    string, // created_at
    string | null, // git_branch (FEA-2990)
  ][] = [];
  const addEvent = (
    eventType: string,
    agentId: string,
    ts: string | null,
    toolName: string | null,
    summary: string | null,
    data: string | null,
    /** FEA-1459 Fix D: Optional discriminator for tool-use dedup (e.g. toolu_* id). */
    discriminator?: string,
    /**
     * FEA-2990: the working git branch this tool ran on, carried straight from
     * NormalizedToolUse.gitBranch. Null for non-tool events, Codex, and any
     * harness that doesn't record per-line branch.
     *
     * SCOPE — best-effort, CWD-derived; NOT authoritative branch attribution.
     * Per the FEA-2531 rule (see artifact-ref-extractor.ts), raw `tu.gitBranch`
     * reports the session CWD's checkout, which is wrong for worktree sessions
     * (a session whose CWD is `main` while it edits a `feat/x` worktree reports
     * `main`). Evidence-first branch resolution lives in `session_artifact_links`;
     * this per-event value is intentionally the coarse fallback, used only to
     * split component-usage rollups by observed working branch. The cloud fold
     * (`getDetailForOrg.branchesTab`) treats the `''` (no-branch) bucket as
     * unattributed and defers to the session-level `SessionBranch` link, so
     * worktree imprecision here never overrides evidence-based attribution.
     */
    gitBranch?: string | null
  ): void => {
    if (!ts) {
      return;
    }
    const prev = highWater.get(eventType);
    if (prev != null && ts <= prev) {
      return;
    }
    // FEA-1459 Fix 7+D: Skip within-import duplicates. Tool-use events include
    // a discriminator (tool_use id or array index) so two same-tool calls in
    // the same ms don't collapse.
    const dedupKey = buildEventDedupKey(eventType, ts, toolName, discriminator);
    if (importEventSeen.has(dedupKey)) {
      return;
    }
    importEventSeen.add(dedupKey);
    eventRowBuffer.push([
      deterministicEventId(
        session.sessionId,
        eventType,
        ts,
        toolName,
        discriminator
      ),
      session.sessionId,
      agentId,
      eventType,
      toolName,
      summary,
      data,
      ts,
      gitBranch ?? null,
    ]);
    inserted++;
  };
  // perf: write the buffered event rows in chunked multi-row INSERTs. Each row
  // binds 8 params; cap rows per statement so the bound-parameter count stays
  // well under the SQLite/libSQL variable limit. ON CONFLICT (id) DO NOTHING is
  // preserved, so a re-import that hits existing ids is still a no-op.
  const flushEventBuffer = async (): Promise<void> => {
    if (eventRowBuffer.length === 0) {
      return;
    }
    // 9 columns per row; chunk so the bound-param count stays under the cap.
    for (const chunk of chunkRowsByParamCap(eventRowBuffer, 9)) {
      const { tuples, params } = buildValuesTuples(chunk);
      await tx.$executeRawUnsafe(
        `INSERT INTO events (id, session_id, agent_id, event_type, tool_name, summary, data, created_at, git_branch) VALUES ${tuples.join(", ")} ON CONFLICT (id) DO NOTHING`,
        ...params
      );
    }
    eventRowBuffer.length = 0;
  };

  const subagentIdByNormalizedId = new Map<string, string>();
  const parserSubagents = session.subagents ?? [];
  for (const subagent of parserSubagents) {
    const normalizedId = sanitizeSubagentIdSegment(subagent.id);
    if (!normalizedId) {
      continue;
    }
    const agentId = `${session.sessionId}-parser-sub-${normalizedId}`;
    subagentIdByNormalizedId.set(subagent.id, agentId);
  }
  for (const subagent of parserSubagents) {
    const agentId = subagentIdByNormalizedId.get(subagent.id);
    if (!agentId) {
      continue;
    }
    const parentAgentId =
      subagent.parentId && subagentIdByNormalizedId.has(subagent.parentId)
        ? subagentIdByNormalizedId.get(subagent.parentId)!
        : mainId;
    const metadata = buildSubagentMetadata(subagent);
    await tx.$executeRawUnsafe(
      `INSERT INTO agents (id, session_id, name, type, subagent_type, status, task, started_at, updated_at, ended_at, parent_agent_id, metadata)
       VALUES ($1, $2, $3, 'subagent', $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO NOTHING`,
      agentId,
      session.sessionId,
      truncate(subagent.name || "Subagent", 200),
      subagent.type ?? null,
      subagent.status === DESKTOP_AGENT_STATUS.ERROR
        ? DESKTOP_AGENT_STATUS.ERROR
        : DESKTOP_AGENT_STATUS.COMPLETED,
      subagent.task ? subagent.task.slice(0, 500) : null,
      subagent.startedAt ?? session.startedAt,
      now,
      subagent.endedAt ?? session.endedAt ?? now,
      parentAgentId,
      metadata
    );
    for (const [idx, tu] of (subagent.toolUses ?? []).entries()) {
      addEvent(
        "PostToolUse",
        agentId,
        tu.timestamp,
        tu.name,
        null,
        importToolEventData(tu),
        tu.id ?? `${subagent.id}:${idx}`,
        tu.gitBranch ?? null
      );
    }
  }

  for (const ts of session.messageTimestamps ?? []) {
    addEvent("Stop", mainId, ts, null, null, null);
  }
  for (const [idx, tu] of (session.toolUses ?? []).entries()) {
    const linkedAgentId =
      tu.subagentId == null
        ? null
        : subagentIdByNormalizedId.get(tu.subagentId);
    if (linkedAgentId) {
      continue;
    }
    if (tu.name === "Agent" || tu.name === "Task") {
      // FEA-1459 Fix 8: Use tool_use id (toolu_*) for stable subagent identity;
      // fall back to array index for parsers that don't populate it.
      const subId = `${session.sessionId}-sub-${tu.id ?? idx}`;
      const input = (tu.input ?? {}) as Record<string, unknown>;
      const prompt = strOf(input.prompt);
      // FEA-1459 Fix 8: Use tool_result timestamp for ended_at (real duration).
      const endedAt =
        tu.resultTimestamp ?? tu.timestamp ?? session.endedAt ?? now;
      await tx.$executeRawUnsafe(
        `INSERT INTO agents (id, session_id, name, type, subagent_type, status, task, started_at, updated_at, ended_at, parent_agent_id)
         VALUES ($1, $2, $3, 'subagent', $4, 'completed', $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO NOTHING`,
        subId,
        session.sessionId,
        subagentName(tu),
        strOf(input.subagent_type) ?? null,
        prompt ? prompt.slice(0, 500) : null,
        tu.timestamp ?? session.startedAt,
        now,
        endedAt,
        mainId
      );
      // FEA-1459 Fix D: Include tool_use id in dedup key so two same-tool
      // calls in the same ms don't collapse.
      addEvent(
        "PreToolUse",
        subId,
        tu.timestamp,
        tu.name,
        "Spawned subagent",
        importToolEventData(tu),
        tu.id ?? String(idx),
        tu.gitBranch ?? null
      );
    } else {
      addEvent(
        "PostToolUse",
        linkedAgentId ?? mainId,
        tu.timestamp,
        tu.name,
        null,
        importToolEventData(tu),
        tu.id ?? String(idx),
        tu.gitBranch ?? null
      );
    }
  }
  for (const td of session.turnDurations ?? []) {
    addEvent(
      "TurnDuration",
      mainId,
      td.timestamp,
      null,
      String(td.durationMs),
      null
    );
  }
  for (const err of session.apiErrors ?? []) {
    addEvent(
      "APIError",
      mainId,
      err.timestamp,
      null,
      err.message ?? err.type ?? null,
      null
    );
  }
  for (const err of session.toolResultErrors ?? []) {
    addEvent(
      "ToolError",
      mainId,
      err.timestamp,
      null,
      truncate(err.content, 200),
      null
    );
  }
  // Gap 4: Create Compaction events from session.compactions. Each compaction
  // entry from the Claude parser carries a uuid and transcript timestamp.
  // Use the compaction timestamp (not wall clock) for event ordering.
  if (session.compactions?.length) {
    const compactions = session.compactions as Array<{
      uuid: string | null;
      timestamp: string | null;
    }>;
    for (const c of compactions) {
      if (c.timestamp) {
        addEvent(
          "Compaction",
          mainId,
          c.timestamp,
          null,
          "Context compaction",
          null
        );
      }
    }
  }
  // perf: flush all buffered event rows in chunked multi-row INSERTs before any
  // downstream read of the events table (e.g. upsertSessionAnalyticsRollup).
  await flushEventBuffer();
  return { inserted };
}

/**
 * Record group 3: token usage. Delete-then-reinsert the JSONL-parser-sourced
 * token_usage rows, then backfill session.model from tokensByModel when null.
 */
async function importPhaseTokenUsage(
  tx: Prisma.TransactionClient,
  ctx: ImportSessionContext
): Promise<void> {
  const { session, now, tokenUsage, earliestTokenTs, tokenSeries } = ctx;
  // FEA-1459 (PR #1511 review): delete+reinsert. The boot importer derives full
  // totals from the entire transcript every run, so the new derivation is
  // authoritative — and overwrite-by-model alone would leave stale rows behind
  // when a model key disappears under the new parser.
  await tx.$executeRawUnsafe(
    "DELETE FROM token_usage WHERE session_id = $1 AND usage_source = $2",
    session.sessionId,
    CodexOtelTokenUsageSource.JsonlParser
  );
  for (const [model, counts] of Object.entries(session.tokensByModel ?? {})) {
    // FEA-1459 Fix 5: Pass activity timestamp instead of now() for created_at.
    await tokenUsage.replace(
      session.sessionId,
      model,
      counts,
      now,
      tx,
      earliestTokenTs ?? undefined
    );
  }
  // FEA-1459 Fix 9: Backfill session.model from tokensByModel when null.
  const modelKeys = Object.keys(session.tokensByModel ?? {});
  if (!session.model && modelKeys.length > 0) {
    const backfilledModel =
      modelKeys.length === 1
        ? modelKeys[0]
        : (tokenSeries.at(-1)?.model ?? modelKeys[0]);
    await tx.$executeRawUnsafe(
      "UPDATE sessions SET model = $1, updated_at = $2 WHERE id = $3 AND model IS NULL",
      backfilledModel,
      now,
      session.sessionId
    );
  }
}

/**
 * Record group 4: token_events AND their derived cost estimates, in ONE
 * transaction. `persistImportedTokenCosts` annotates the just-inserted
 * token_events rows in place (`updateTokenEventCost` issues
 * `UPDATE token_events SET cost_*`), so the insert and the cost UPDATE are
 * write-coupled and MUST commit together: if they were separate isolated
 * transactions and the insert failed, the UPDATE would silently match zero rows
 * and commit "successfully", leaving cost columns permanently unpopulated.
 * Delete+reinsert is idempotent — the boot importer derives the full record set
 * every call.
 */
async function importPhaseTokenEventsAndCosts(
  tx: Prisma.TransactionClient,
  ctx: ImportSessionContext
): Promise<void> {
  const { session, harness, now, earliestTokenTs, tokenEventsRecords } = ctx;
  await replaceTokenEvents(tx, session.sessionId, tokenEventsRecords);
  await persistImportedTokenCosts(tx, {
    sessionId: session.sessionId,
    harness,
    tokenUsageObservedAt: earliestTokenTs ?? session.startedAt ?? now,
    tokenEvents: tokenEventsRecords,
    tokenEventObservedAtFallback: session.startedAt ?? now,
  });
}

/**
 * FEA-2267: replace a session's activity-segment tiling via delete-then-reinsert.
 * Idempotent — the classifier derives the FULL ordered set from the parsed
 * session every call (like replaceTokenEvents), so a re-import or backfill
 * re-derive overwrites cleanly. Uses the typed `sessionActivitySegment`
 * delegate (deleteMany + createMany); BigInt timing bounds are coerced from the
 * record's JS numbers. Returns the number of segment rows written. Exported so
 * the backfill (activity-segment-backfill.ts) persists through the SAME writer.
 */
export async function persistActivitySegments(
  tx: Prisma.TransactionClient,
  sessionId: string,
  segments: ActivitySegmentRecord[],
  now: string
): Promise<number> {
  await tx.sessionActivitySegment.deleteMany({ where: { sessionId } });
  if (segments.length === 0) {
    return 0;
  }
  await tx.sessionActivitySegment.createMany({
    data: segments.map((seg) => ({
      id: activitySegmentId(sessionId, seg.startMs, seg.version),
      sessionId,
      phase: seg.phase,
      startMs: BigInt(seg.startMs),
      endMs: BigInt(seg.endMs),
      confidence: seg.confidence,
      evidenceLayers: seg.evidenceLayers,
      version: seg.version,
      workItemRef: seg.workItemRef ?? null,
      observedAt: now,
    })),
  });
  return segments.length;
}

/**
 * Record group: activity segments (FEA-2267). Persist the session's complete
 * activity-phase tiling. ORDERING IS LOAD-BEARING: this MUST run after
 * importPhaseTokenEventsAndCosts so token_events exist for the per-segment spend
 * join (Σ reconciliation). Recompute-from-source ⇒ idempotent.
 */
async function importPhaseActivitySegments(
  tx: Prisma.TransactionClient,
  ctx: ImportSessionContext
): Promise<void> {
  const { session, now, activitySegments } = ctx;
  await persistActivitySegments(tx, session.sessionId, activitySegments, now);
}

/**
 * Record group 6: artifact links. Delete-then-reinsert the session↔artifact
 * join rows for consistency with the backfill path.
 */
async function importPhaseArtifactLinks(
  tx: Prisma.TransactionClient,
  ctx: ImportSessionContext
): Promise<{ capturedArtifactLinks: number }> {
  const { session, now, artifactRefs, log } = ctx;
  await tx.$executeRawUnsafe(
    "DELETE FROM session_artifact_links WHERE session_id = $1",
    session.sessionId
  );
  // The live import re-runs on every real import, so the seen-guard's
  // unresolved-bare-repo deferral (FEA-2875) is a backfill-only concern; here we
  // only need the captured count.
  const { captured: capturedArtifactLinks } = await persistArtifactLinks(
    tx,
    session.sessionId,
    artifactRefs,
    now,
    log
  );
  return { capturedArtifactLinks };
}

/**
 * Record group 7: pull requests. MUST run after the artifact-links phase — PR
 * artifacts create their own session_artifact_links rows, which that phase's
 * DELETE would otherwise wipe. Referenced (non-created) PRs get a null branch.
 */
async function importPhasePullRequests(
  tx: Prisma.TransactionClient,
  ctx: ImportSessionContext
): Promise<{ capturedPullRequests: number }> {
  const { session, harness, now, createdPrHeadBranches } = ctx;
  const capturedPullRequests = await persistNormalizedPullRequests(
    tx,
    session,
    harness,
    now,
    createdPrHeadBranches
  );
  return { capturedPullRequests };
}

/**
 * Record group 8: derived rollups. Recompute this session's analytics rollup
 * (FEA-2038) and refresh the denormalized last_activity_at cursor key. Both read
 * the events/token rows written by the phases above, so this runs last; both are
 * recompute-from-source and therefore idempotent.
 */
async function importPhaseDerivedRollups(
  tx: Prisma.TransactionClient,
  ctx: ImportSessionContext
): Promise<void> {
  const { session, now } = ctx;
  await upsertSessionAnalyticsRollup(tx, session.sessionId, now);
  await recomputeSessionLastActivityAt(tx, session.sessionId);
}

/**
 * Run every import phase on a SINGLE caller-supplied transaction. Used by the
 * data-revision rebuild ({@link rebuildSessionFromParse}), which first tears the
 * session's derived rows down and must replace them atomically: a mid-rebuild
 * failure has to roll the whole teardown back rather than leave the session with
 * deleted-but-not-rebuilt data. The normal ingest path uses
 * {@link importSessionIsolated} instead, committing each phase independently.
 */
export async function importSessionWithTx(
  tx: Prisma.TransactionClient,
  tokenUsage: ReturnType<typeof createSqliteTokenUsageStore>,
  deps: {
    detectBillingMode: (harness: string) => string;
    log: (message: string) => void;
  },
  session: NormalizedSession,
  harness: Harness,
  now: string,
  attributionCache: SessionAttributionResolverCache
): Promise<ImportResult> {
  const ctx = buildImportSessionContext(
    tokenUsage,
    deps,
    session,
    harness,
    now,
    attributionCache
  );
  const { existed, reactivated } = await importPhaseSessionAndMainAgent(
    tx,
    ctx
  );
  const { inserted } = await importPhaseEvents(tx, ctx);
  await importPhaseTokenUsage(tx, ctx);
  await importPhaseTokenEventsAndCosts(tx, ctx);
  await importPhaseActivitySegments(tx, ctx);
  const { capturedArtifactLinks } = await importPhaseArtifactLinks(tx, ctx);
  const { capturedPullRequests } = await importPhasePullRequests(tx, ctx);
  await importPhaseDerivedRollups(tx, ctx);
  return {
    skipped:
      existed &&
      inserted === 0 &&
      capturedPullRequests === 0 &&
      capturedArtifactLinks === 0 &&
      !reactivated,
    reactivated,
  };
}

/**
 * FEA-2027: validate every token counter the import would persist BEFORE any
 * record group commits, reusing the exact write-path normalizers so the check
 * can never drift from what the token groups enforce. Returns the first
 * {@link InvalidTokenCountError} found, or null when all counts are safe.
 *
 * Each record group commits in its own isolated transaction, so an unsafe counter
 * (negative, fractional, JS-unsafe) that threw mid-import would leave the session
 * and its events committed while a corrupt count still reached token_events. So
 * the isolated path detects the unsafe count up front and skips the whole session
 * (writing nothing), while the rest of the source still imports.
 */
function findUnsafeImportTokenCount(
  ctx: ImportSessionContext
): InvalidTokenCountError | null {
  try {
    for (const counts of Object.values(ctx.session.tokensByModel ?? {})) {
      normalizeTokenUsageCounts(counts, "token_usage");
    }
    for (const rec of ctx.tokenEventsRecords) {
      normalizeTokenEventRecord(rec, "token_events");
    }
    return null;
  } catch (error) {
    if (error instanceof InvalidTokenCountError) {
      return error;
    }
    throw error;
  }
}

/**
 * Run each import record group in its OWN isolated transaction (through the
 * shared write queue) instead of wrapping the whole import in one transaction.
 * This means: the import never holds a single write
 * connection open for its full duration; each group's rows become visible to the
 * dashboard as soon as that group commits; and one group failing (e.g. a
 * malformed PR) no longer discards the entire import.
 *
 * The session+main-agent group GATES the import — it is the FK parent for every
 * other row, so if it fails there is nothing to attach to and the import is
 * reported failed. Every later group is tolerant: its failure is logged and
 * skipped, and re-import converges because each group is an idempotent
 * delete-then-reinsert (or ON CONFLICT) unit.
 *
 * NOTE: each `prisma.write` below is a separate write-queue task, so this must
 * never be called from inside an outer `prisma.write`/`$transaction` (that would
 * deadlock the queue). The atomic, single-transaction rebuild path uses
 * {@link importSessionWithTx} instead.
 */
async function importSessionIsolated(
  prisma: DesktopPrisma,
  tokenUsage: ReturnType<typeof createSqliteTokenUsageStore>,
  deps: {
    detectBillingMode: (harness: string) => string;
    log: (message: string) => void;
  },
  session: NormalizedSession,
  harness: Harness,
  now: string,
  attributionCache: SessionAttributionResolverCache
): Promise<ImportResult> {
  const ctx = buildImportSessionContext(
    tokenUsage,
    deps,
    session,
    harness,
    now,
    attributionCache
  );

  // FEA-2027: a session carrying a token counter that cannot be represented
  // exactly is skipped WHOLE — before any group commits — so no corrupt row
  // lands in token_usage OR token_events. Not a failure: the rest of the source
  // keeps importing (the old single-transaction import marked this failed,
  // which halted the source).
  const unsafeTokenCount = findUnsafeImportTokenCount(ctx);
  if (unsafeTokenCount) {
    deps.log(
      `sqlite import: skipping ${session.sessionId} — unsafe token count (${unsafeTokenCount.message}); nothing written`
    );
    return { skipped: true, reactivated: false };
  }

  // Gating group: the FK parent. If it fails, abort — there is nothing the later
  // groups could attach rows to.
  let gate: { existed: boolean; reactivated: boolean };
  try {
    gate = await prisma.write((client) =>
      client.$transaction((tx) => importPhaseSessionAndMainAgent(tx, ctx))
    );
  } catch (error) {
    deps.log(
      `sqlite import session/main-agent failed for ${session.sessionId}: ${error instanceof Error ? error.message : String(error)}`
    );
    return { skipped: true, reactivated: false, failed: true };
  }

  // Tolerant groups: each commits independently; a failure is logged and the
  // import continues. Returns the group's result, or null when it failed. A
  // failure flips `incomplete` so the caller re-imports the source next pass
  // (see the ImportResult.incomplete contract) rather than marking it seen and
  // permanently losing the failed group's rows.
  let incomplete = false;
  const runGroup = async <T>(
    label: string,
    group: (
      tx: Prisma.TransactionClient,
      ctx: ImportSessionContext
    ) => Promise<T>
  ): Promise<T | null> => {
    try {
      return await prisma.write((client) =>
        client.$transaction((tx) => group(tx, ctx))
      );
    } catch (error) {
      deps.log(
        `sqlite import ${label} failed for ${session.sessionId}: ${error instanceof Error ? error.message : String(error)}`
      );
      incomplete = true;
      return null;
    }
  };

  const events = await runGroup("events", importPhaseEvents);
  await runGroup("token_usage", importPhaseTokenUsage);
  // token_events + their cost annotations commit together (the cost UPDATE
  // mutates the just-inserted rows — see importPhaseTokenEventsAndCosts).
  await runGroup("token_events", importPhaseTokenEventsAndCosts);
  // FEA-2267: tile activity segments after token_events (the spend join needs
  // them). Tolerant group — a failure flips `incomplete` so the source
  // re-imports next pass; the delete-then-reinsert is idempotent.
  await runGroup("activity_segments", importPhaseActivitySegments);
  // SYNC INVARIANT (FEA-2729 / PLN-1296): artifact-link rows (branch/PR/slug
  // refs) are written here, in the same importSession pass that
  // importPhaseSessionAndMainAgent bumps `sessions.updated_at`. The cloud sync
  // driver selects sessions by that `updated_at` watermark (the FEA-1962
  // durable cursor), so a link change propagates to the cloud *because* its
  // session's updated_at advanced in this transaction. Do NOT write
  // session_artifact_links outside importSession (e.g. a targeted SQL backfill)
  // without also bumping the parent session's updated_at, or add a per-kind
  // artifact-link cursor — otherwise the new/re-derived refs will never sync.
  const links = await runGroup("artifact_links", importPhaseArtifactLinks);
  const prs = await runGroup("pull_requests", importPhasePullRequests);
  await runGroup("analytics_rollup", importPhaseDerivedRollups);

  const inserted = events?.inserted ?? 0;
  const capturedArtifactLinks = links?.capturedArtifactLinks ?? 0;
  const capturedPullRequests = prs?.capturedPullRequests ?? 0;
  return {
    skipped:
      gate.existed &&
      inserted === 0 &&
      capturedPullRequests === 0 &&
      capturedArtifactLinks === 0 &&
      !gate.reactivated,
    reactivated: gate.reactivated,
    // A tolerated group failure leaves the import partial: signal the collector
    // to re-import next pass (idempotent — committed groups converge) instead of
    // marking the source seen.
    incomplete: incomplete || undefined,
  };
}

/** Human-turn threshold for the session human/agent classification (mirrors
 * local-insights `HUMAN_TURN_THRESHOLD`). A session is "human" when it has >= this
 * many genuine human turns — counted transcript-first from `role:"human"`
 * messages in metadata `$.messages`, falling back to hook-captured user/prompt
 * events only when no parsed transcript exists (FEA-2641). Kept in sync with
 * local-insights by a guard test. */
const SESSION_ANALYTICS_HUMAN_TURN_THRESHOLD = 2;

/**
 * FEA-2870: SQL predicate that matches a headless/autonomous session by the
 * calling params persisted in its `metadata` JSON blob. Uses `json_extract` to
 * read the TOP-LEVEL `entrypoint`/`permissionMode` fields exactly — a substring
 * LIKE over the whole blob would also match a nested occurrence (e.g. a
 * `"permissionMode":"bypassPermissions"` string buried in `usageExtras`,
 * `compactions`, or `messages`) and misclassify a human session as headless.
 * Built from the shared SSOT sets (values are code constants, not user input) so
 * the write-time classification and `isHeadlessSession` never drift. `col` is the
 * metadata column expression (e.g. `s.metadata`).
 */
function headlessMetadataSql(col: string): string {
  // Escape single-quoted string literals for SQLite: replace ' with ''.
  const sqlLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const inList = (values: readonly string[]) =>
    values.map(sqlLiteral).join(", ");
  const conditions = [
    `json_extract(${col}, '$.entrypoint') IN (${inList(HEADLESS_ENTRYPOINTS)})`,
    `json_extract(${col}, '$.permissionMode') IN (${inList(HEADLESS_PERMISSION_MODES)})`,
  ];
  return `(${conditions.join(" OR ")})`;
}

/**
 * FEA-2038: (re)compute the per-session analytics rollup for one session from its
 * events / token_usage rows and upsert it into `session_analytics` +
 * `session_tool_analytics`. All classification (human/agent turns, is_human,
 * error events) happens HERE, once, at ingest — mirroring the predicates the
 * dashboard insights used to run on every read. SQLite dialect.
 */
export async function upsertSessionAnalyticsRollup(
  tx: Prisma.TransactionClient,
  sessionId: string,
  now: string
): Promise<void> {
  // The single-session rollup is the one-element case of the set-based batch.
  // Delegate so the (large) aggregate/classification SQL lives in ONE place and
  // the import-time path and the boot backfill can never drift apart.
  await upsertSessionAnalyticsRollupBatch(tx, [sessionId], now);
}

/** Max session ids per rollup transaction. Bounds the placeholder/parameter
 * count of the set-based upsert and keeps each commit (one fsync) modest while
 * still collapsing N per-session transactions into ⌈N/CHUNK⌉.
 *
 * FEA-3056: this ALSO bounds peak memory. `upsertSessionAnalyticsRollupBatch`
 * runs a `json_each` scan over EVERY message of EVERY session in the batch
 * (metadata `$.messages`) to count human/agent turns. At 500, a batch of
 * sessions with large transcripts materialized a multi-GB intermediate in the
 * db-host worker and blew its `--max-old-space-size` ceiling (exit code 5 →
 * crash-loop → no data anywhere). Keep it small so the per-batch scan stays
 * bounded; the extra commits are cheap next to a worker OOM. */
export const SESSION_ANALYTICS_BACKFILL_CHUNK = 25;

// FEA-3132 (D6): summed-metadata byte budget per rollup chunk. The CHUNK count
// above bounds the number of SESSIONS per rollup transaction, but
// upsertSessionAnalyticsRollupBatch runs a json_each scan over EVERY message of
// EVERY session in the chunk — so the intermediate materialization scales with
// TOTAL messages, not session count. One ~12 MB transcript blob can balloon a
// 25-session chunk past the db-host heap (exit code 5). Budgeting each chunk by
// summed length(metadata) makes a single oversized session its own chunk and
// caps every chunk's json_each scan regardless of transcript size. 8 MiB is a
// generous per-chunk metadata budget that still packs many small sessions.
export const SESSION_ANALYTICS_ROLLUP_METADATA_BUDGET_BYTES = 8 * 1024 * 1024;

/**
 * FEA-3132 (D6): pure greedy packer — group `idBytes` (order-preserving) into
 * chunks whose summed `bytes` ≤ `maxBytes` AND length ≤ `maxCount`. A single id
 * whose `bytes` already exceeds `maxBytes` forms its own chunk. Every id appears
 * in exactly one chunk (no drop, no duplication) — the invariant the rollup
 * depends on. Separated from the DB lookup so it is exhaustively unit-testable.
 */
export function packIdsByMetadataBudget(
  idBytes: readonly { id: string; bytes: number }[],
  maxBytes: number,
  maxCount: number
): string[][] {
  const byteCap = Math.max(1, maxBytes);
  const countCap = Math.max(1, maxCount);
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentBytes = 0;
  for (const { id, bytes } of idBytes) {
    const wouldExceedBytes =
      current.length > 0 && currentBytes + bytes > byteCap;
    const wouldExceedCount = current.length >= countCap;
    if (wouldExceedBytes || wouldExceedCount) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(id);
    currentBytes += bytes;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

/**
 * FEA-3132 (D6): look up each session's metadata byte length (in bounded
 * sub-batches so the IN-list never grows unbounded) and pack the ids into
 * metadata-budgeted chunks via {@link packIdsByMetadataBudget}. Missing rows
 * default to 0 bytes. Order-preserving.
 */
export async function chunkSessionIdsByMetadataBudget(
  prisma: DesktopPrisma,
  ids: string[],
  maxBytes: number = SESSION_ANALYTICS_ROLLUP_METADATA_BUDGET_BYTES,
  maxCount: number = SESSION_ANALYTICS_BACKFILL_CHUNK
): Promise<string[][]> {
  const LOOKUP_BATCH = 500;
  const sizeById = new Map<string, number>();
  for (let i = 0; i < ids.length; i += LOOKUP_BATCH) {
    const batch = ids.slice(i, i + LOOKUP_BATCH);
    const placeholders = batch.map((_, j) => `$${j + 1}`).join(", ");
    const rows = await prisma.client.$queryRawUnsafe<
      { id: string; n: number | bigint }[]
    >(
      // `length(metadata)` on a TEXT column counts CHARACTERS, not bytes, so
      // multi-byte (non-ASCII) metadata would under-report and let the packer
      // exceed SESSION_ANALYTICS_ROLLUP_METADATA_BUDGET_BYTES. Cast to BLOB so
      // `length` returns the true UTF-8 byte count the packer budgets against.
      `SELECT id, COALESCE(length(CAST(metadata AS BLOB)), 0) AS n FROM sessions WHERE id IN (${placeholders})`,
      ...batch
    );
    for (const row of rows) {
      sizeById.set(row.id, Number(row.n));
    }
  }
  const idBytes = ids.map((id) => ({ id, bytes: sizeById.get(id) ?? 0 }));
  return packIdsByMetadataBudget(idBytes, maxBytes, maxCount);
}

/**
 * FEA-2038: set-based (re)compute of the analytics rollups for an explicit set
 * of session ids, in ONE transaction. Mirrors `upsertSessionAnalyticsRollup`
 * exactly — same SELECT/aggregate/classification SQL — but scopes the outer
 * `sessions` scan and the inner aggregate sub-selects to `s.id IN (…)` (the
 * inner sub-selects already `GROUP BY session_id`, so restricting them to the
 * chunk just bounds the scan; the `JOIN`/`GROUP BY` then yield one rollup row
 * per session). Behavior-preserving: identical rollup rows/values, far fewer
 * commits.
 */
export async function upsertSessionAnalyticsRollupBatch(
  tx: Prisma.TransactionClient,
  sessionIds: string[],
  now: string
): Promise<void> {
  if (sessionIds.length === 0) {
    return;
  }
  // FEA-2430: `started_day` (session_analytics + session_tool_analytics) is a
  // stored UTC-day derivation — storage-only, zero readers. It must stay UTC:
  // a stored LOCAL day would go stale when the user changes timezone or DST
  // shifts, forcing full-table rebuilds. Any future DISPLAY read must re-bucket
  // from the raw timestamp with strftime(..., 'localtime') (see
  // local-insights.ts's timezone contract), never read this column.
  const dayExpr = (col: string) =>
    `CASE WHEN ${col} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' THEN substr(${col}, 1, 10) ELSE NULL END`;
  const t = SESSION_ANALYTICS_HUMAN_TURN_THRESHOLD;
  // session_analytics upsert: $1 = now; the session ids occupy $2..$(N+1). The
  // IN list is repeated for the outer scan and each inner aggregate sub-select
  // so SQLite bounds every scan to the chunk; reusing the same numbered params
  // keeps a single bound array.
  const analyticsIdPlaceholders = sessionIds
    .map((_, i) => `$${i + 2}`)
    .join(", ");
  const analyticsParams: unknown[] = [now, ...sessionIds];
  // The tool-analytics DELETE + INSERT bind `sessionIds` alone, so their IN list
  // starts at $1 (no `now` param).
  const toolIdPlaceholders = sessionIds.map((_, i) => `$${i + 1}`).join(", ");
  await tx.$executeRawUnsafe(
    `INSERT OR REPLACE INTO session_analytics (
       session_id, started_at, started_day, status, harness,
       human_turns, agent_turns, is_human, event_count, tool_invocations, error_events,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, est_cost,
       runtime_ms, updated_at
     )
     SELECT
       s.id,
       s.started_at,
       ${dayExpr("s.started_at")},
       s.status,
       s.harness,
       COALESCE(s.transcript_human_turns, ht.human_turns, 0),
       COALESCE(ev.agent_turns, 0),
       CASE
         WHEN ${headlessMetadataSql("s.metadata")} THEN 0
         WHEN COALESCE(s.transcript_human_turns, ht.human_turns, 0) >= ${t} THEN 1
         ELSE 0
       END,
       COALESCE(ev.event_count, 0),
       COALESCE(ev.tool_invocations, 0),
       COALESCE(ev.error_events, 0),
       COALESCE(tok.input_tokens, 0),
       COALESCE(tok.output_tokens, 0),
       COALESCE(tok.cache_read_tokens, 0),
       COALESCE(tok.cache_write_tokens, 0),
       COALESCE(tok.est_cost, 0),
       CASE
         WHEN s.started_at IS NOT NULL AND s.ended_at IS NOT NULL AND s.ended_at > s.started_at
           THEN CAST((unixepoch(s.ended_at, 'subsec') - unixepoch(s.started_at, 'subsec')) * 1000 AS INTEGER)
         ELSE NULL
       END,
       $1
     FROM (
       -- FEA-2641: genuine human turns are counted transcript-first — a
       -- role:"human" message count over metadata $.messages (NULL when no
       -- parsed transcript exists, e.g. hook-only live sessions). Computed
       -- once here so the human_turns column and the is_human CASE share it.
       -- Nested CASE so json_type never runs on invalid JSON; the inner CASE
       -- gates json_extract on m.type = 'object' (json_each's own type
       -- column) so a primitive array element (string/number/null) can never
       -- raise "malformed JSON" and abort the whole rollup chunk.
       SELECT s.*,
         CASE WHEN json_valid(s.metadata)
              THEN CASE WHEN json_type(s.metadata, '$.messages') = 'array'
                        THEN (SELECT COUNT(*)
                              FROM json_each(s.metadata, '$.messages') AS m
                              WHERE CASE WHEN m.type = 'object'
                                         THEN json_extract(m.value, '$.role') = 'human'
                                         ELSE 0 END)
                        ELSE NULL END
              ELSE NULL END AS transcript_human_turns
       FROM sessions s
       WHERE s.id IN (${analyticsIdPlaceholders})
     ) s
     LEFT JOIN (
       SELECT session_id,
         COUNT(*) AS event_count,
         SUM(CASE WHEN tool_name IS NOT NULL THEN 1 ELSE 0 END) AS tool_invocations,
         SUM(CASE WHEN lower(event_type) LIKE '%assistant%' THEN 1 ELSE 0 END) AS agent_turns,
         SUM(CASE WHEN (lower(event_type) LIKE '%error%' OR lower(event_type) LIKE '%fail%') THEN 1 ELSE 0 END) AS error_events
       FROM events WHERE session_id IN (${analyticsIdPlaceholders}) GROUP BY session_id
     ) ev ON ev.session_id = s.id
     LEFT JOIN (
       SELECT session_id, COUNT(*) AS human_turns
       FROM events
       WHERE session_id IN (${analyticsIdPlaceholders})
         AND (lower(event_type) LIKE '%user%' OR lower(event_type) LIKE '%prompt%')
       GROUP BY session_id
     ) ht ON ht.session_id = s.id
     LEFT JOIN (
       SELECT session_id,
         -- FEA-2879: sum the EFFECTIVE totals (current + pre-compaction
         -- baseline_*) so the materialized session_analytics token counts don't
         -- drop to the post-compaction subset. est_cost sums the per-row
         -- cost_usd_estimated, which is already priced on the effective total.
         SUM(COALESCE(input_tokens, 0) + COALESCE(baseline_input, 0)) AS input_tokens,
         SUM(COALESCE(output_tokens, 0) + COALESCE(baseline_output, 0)) AS output_tokens,
         SUM(COALESCE(cache_read_tokens, 0) + COALESCE(baseline_cache_read, 0)) AS cache_read_tokens,
         SUM(COALESCE(cache_write_tokens, 0) + COALESCE(baseline_cache_write, 0)) AS cache_write_tokens,
         SUM(COALESCE(cost_usd_estimated, 0)) AS est_cost
       FROM token_usage WHERE session_id IN (${analyticsIdPlaceholders}) GROUP BY session_id
     ) tok ON tok.session_id = s.id`,
    ...analyticsParams
  );
  await tx.$executeRawUnsafe(
    `DELETE FROM session_tool_analytics WHERE session_id IN (${toolIdPlaceholders})`,
    ...sessionIds
  );
  await tx.$executeRawUnsafe(
    `INSERT INTO session_tool_analytics (session_id, tool_name, invocations, started_day)
     SELECT e.session_id, e.tool_name, COUNT(*),
       (SELECT ${dayExpr("s.started_at")} FROM sessions s WHERE s.id = e.session_id)
     FROM events e
     WHERE e.session_id IN (${toolIdPlaceholders}) AND e.tool_name IS NOT NULL
     GROUP BY e.session_id, e.tool_name`,
    ...sessionIds
  );
  // FEA-2923 (T-8.4 + T-8.5): materialize component usage rows (USAGE) and
  // upsert existence rows (EXISTENCE) — two independent write paths in the same
  // transaction. rebuildComponentSessionUsage also calls upsertEventDrivenComponents
  // so existence is always updated after usage is written.
  await rebuildComponentSessionUsage(tx, sessionIds, now, dayExpr);
  // FEA-3132: materialize per-turn buckets so the Insights autonomy trend +
  // activity heatmap never json_each-expand `$.messages` on the read path.
  await rebuildSessionTurnBuckets(tx, sessionIds);
}

export type TurnKind = "human" | "agent";

export type SessionTurnBucketRow = {
  sessionId: string;
  ts: string;
  turnKind: TurnKind;
  turnCount: number;
};

/**
 * FEA-3132: PURE per-turn bucket derivation for ONE session, parsed in JS — the
 * json_each-free replacement for the old `INSERT ... SELECT ... json_each`. It is
 * a drop-in equal of that SQL (asserted byte-for-byte against the json_each
 * oracle in session-turn-bucket-equivalence.test.ts), but never runs json_each,
 * which is both slow at corpus scale AND natively SIGTRAPs the @libsql layer
 * (db-host exit code 5) on large sessions. Parsing the already-persisted metadata
 * string in JS is a normal scalar operation with no such failure mode.
 *
 * Reproduces the read path exactly (local-insights.ts heatmap + autonomy):
 *  - include a message iff it is a JSON object (not array/primitive) whose role
 *    is 'human' or 'assistant' AND whose `timestamp` is a non-null string/number;
 *  - `headless` is the READ path's classifier — entrypoint case-insensitively
 *    starts with 'sdk' OR contains 'exec' (mirrors SQL `LIKE 'sdk%' OR '%exec%'`,
 *    which is case-insensitive) — NOT the rollup's `headlessMetadataSql`;
 *  - `turnKind` = human when (role='human' AND !headless), else agent
 *    (role='assistant' OR (role='human' AND headless));
 *  - `ts` is the raw `$.timestamp` VERBATIM (read re-buckets with
 *    strftime(ts,'localtime'), so timezone/DST changes need no rebuild);
 *  - multiple messages sharing (ts, turnKind) collapse into one row with
 *    turnCount = the count (so SUM(turnCount) == the old COUNT(*)).
 * Malformed/absent metadata, a non-array `messages`, or zero qualifying turns
 * all yield an empty array — never a throw.
 */
export function deriveSessionTurnBuckets(
  sessionId: string,
  metadataText: string | null
): SessionTurnBucketRow[] {
  if (!metadataText) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadataText);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) {
    return [];
  }
  const meta = parsed as { entrypoint?: unknown; messages?: unknown };
  if (!Array.isArray(meta.messages)) {
    return [];
  }
  const entrypoint =
    typeof meta.entrypoint === "string" ? meta.entrypoint.toLowerCase() : "";
  const headless = entrypoint.startsWith("sdk") || entrypoint.includes("exec");
  // Aggregate (ts, turnKind) -> count, preserving raw ts verbatim.
  const counts = new Map<string, SessionTurnBucketRow>();
  for (const el of meta.messages) {
    if (typeof el !== "object" || el === null || Array.isArray(el)) {
      continue;
    }
    const { role, timestamp } = el as { role?: unknown; timestamp?: unknown };
    if (role !== "human" && role !== "assistant") {
      continue;
    }
    if (typeof timestamp !== "string" && typeof timestamp !== "number") {
      continue;
    }
    const ts = String(timestamp);
    const turnKind: TurnKind =
      role === "human" && !headless ? "human" : "agent";
    const key = `${ts} ${turnKind}`;
    const existing = counts.get(key);
    if (existing) {
      existing.turnCount += 1;
    } else {
      counts.set(key, { sessionId, ts, turnKind, turnCount: 1 });
    }
  }
  return [...counts.values()];
}

/**
 * FEA-3132: (re)materialize `session_turn_bucket` for a batch of sessions so the
 * Insights autonomy trend + activity heatmap read a small indexed GROUP BY.
 * Idempotent DELETE-then-INSERT in the SAME transaction as
 * `upsertSessionAnalyticsRollupBatch`, so buckets never drift from metadata.
 *
 * This write is the SINGLE SOURCE OF TRUTH for the turn-classification
 * predicate: the Insights autonomy trend (`computeAgents`) + activity heatmap
 * (`computeUtilization`) in `local-insights.ts` read `turn_kind` straight from
 * `session_turn_bucket` via a GROUP BY, so the old json_each read helpers
 * (`turnsByRoleForIds` / `HUMAN_TURN_PREDICATE` / `AGENT_TURN_PREDICATE`) are
 * deleted. The predicate itself lives in the pure `deriveSessionTurnBuckets`
 * above (object element + role in human/assistant + non-null ts; headless =
 * entrypoint startsWith 'sdk' or includes 'exec'; verbatim ts; (ts,kind)
 * aggregation) and is asserted byte-for-byte against that removed read.
 *
 * json_each-FREE: metadata is read as a normal scalar TEXT column (the same read
 * session-detail performs) and parsed per session in JS via
 * `deriveSessionTurnBuckets`. This removes the json_each virtual-table expansion
 * that was both the corpus-scale perf sink and the @libsql native SIGTRAP
 * trigger (db-host exit code 5) on large sessions.
 */
export async function rebuildSessionTurnBuckets(
  tx: Prisma.TransactionClient,
  sessionIds: string[]
): Promise<void> {
  if (sessionIds.length === 0) {
    return;
  }
  const placeholders = sessionIds.map((_, i) => `$${i + 1}`).join(", ");
  await tx.$executeRawUnsafe(
    `DELETE FROM session_turn_bucket WHERE session_id IN (${placeholders})`,
    ...sessionIds
  );
  const rows = await tx.$queryRawUnsafe<
    { id: string; metadata: string | null }[]
  >(
    `SELECT id, metadata FROM sessions WHERE id IN (${placeholders})`,
    ...sessionIds
  );
  const bucketRows = rows.flatMap((row) =>
    deriveSessionTurnBuckets(row.id, row.metadata)
  );
  if (bucketRows.length === 0) {
    return;
  }
  // Chunk INSERTs to stay well under SQLite's bound-parameter limit (4 params
  // per row). A single session can produce thousands of buckets, so this is
  // bounded by rows, not by the caller's session batch.
  const INSERT_ROW_CHUNK = 200;
  for (let i = 0; i < bucketRows.length; i += INSERT_ROW_CHUNK) {
    const slice = bucketRows.slice(i, i + INSERT_ROW_CHUNK);
    const valuesSql = slice
      .map((_, j) => {
        const p = j * 4;
        return `($${p + 1}, $${p + 2}, $${p + 3}, $${p + 4})`;
      })
      .join(", ");
    const params = slice.flatMap((r) => [
      r.sessionId,
      r.ts,
      r.turnKind,
      r.turnCount,
    ]);
    await tx.$executeRawUnsafe(
      `INSERT INTO session_turn_bucket (session_id, ts, turn_kind, turn_count) VALUES ${valuesSql}`,
      ...params
    );
  }
}

/**
 * FEA-3132: one-time backfill of `session_turn_bucket` for an existing install
 * upgrading to migration 0018. New/reprocessed sessions get their buckets at
 * ingest (rebuildSessionTurnBuckets, in the rollup tx); this populates the
 * PRE-existing corpus so the Insights autonomy trend + activity heatmap aren't
 * empty until each old session is next reprocessed. Chunked by the same
 * metadata-byte budget as the analytics backfill so the one-time json_each scan
 * stays bounded.
 *
 * Targets only sessions NOT yet represented in the bucket table (NOT EXISTS),
 * NOT a whole-table COUNT>0 gate. This pass runs at the tail of the background
 * boot-maintenance chain, but live ingest (processEvent -> rollup ->
 * rebuildSessionTurnBuckets) is NOT gated behind that chain and populates
 * buckets concurrently. A COUNT>0 gate would lose that race: a single live
 * ingest before this pass would flip the gate and strand the entire historical
 * corpus un-backfilled forever (once-per-install). Selecting only un-bucketed
 * sessions is both race-free and idempotent across boots. Sessions with metadata
 * but zero qualifying turns (no timestamped human/assistant message) legitimately
 * yield no rows and are re-checked on each boot — a bounded cost over that
 * minority, never a re-scan of the full corpus.
 */
export async function backfillSessionTurnBuckets(
  prisma: DesktopPrisma,
  log: (message: string) => void,
  chunkSize: number = SESSION_ANALYTICS_BACKFILL_CHUNK
): Promise<void> {
  const rows = await prisma.client.$queryRawUnsafe<{ id: string }[]>(
    `SELECT s.id FROM sessions s
     WHERE s.metadata IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM session_turn_bucket b WHERE b.session_id = s.id
       )`
  );
  if (rows.length === 0) {
    return;
  }
  const ids = rows.map((r) => r.id);
  const chunks = await chunkSessionIdsByMetadataBudget(
    prisma,
    ids,
    SESSION_ANALYTICS_ROLLUP_METADATA_BUDGET_BYTES,
    Math.max(1, Math.floor(chunkSize))
  );
  let done = 0;
  for (const chunk of chunks) {
    try {
      await prisma.write((client) =>
        client.$transaction((tx) => rebuildSessionTurnBuckets(tx, chunk))
      );
      done += chunk.length;
    } catch (error) {
      log(
        `session-turn-bucket backfill failed for ${chunk.length} session(s): ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  log(`session-turn-bucket backfill complete: ${done}/${ids.length}`);
}

// ---------------------------------------------------------------------------
// FEA-2923 (T-8.4 + T-8.5): Component usage + existence materialization
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic `agent_components.id` from (kind, externalId).
 * Mirrors `deterministicSkillId` in pack-scanner.ts — 32-char hex prefix of
 * sha256 so it is stable across re-imports and never collides across kinds.
 */
function deterministicComponentId(kind: string, externalId: string): string {
  return createHash("sha256")
    .update(`${kind}|${externalId}`)
    .digest("hex")
    .slice(0, 32);
}

/** In-clause placeholder list: $1, $2, … (0-indexed offset). */
function inPlaceholders(count: number, offset = 0): string {
  return Array.from({ length: count }, (_, i) => `$${offset + i + 1}`).join(
    ", "
  );
}

/**
 * FEA-2923 (T-8.4): (re)materialize `agent_component_session_usage` rows for
 * a batch of sessions. Idempotent: DELETE-then-INSERT, sharing the same
 * transaction as `upsertSessionAnalyticsRollupBatch` so both rollups are
 * always in sync. Reads ONLY already-written `events`/`agents` rows and
 * session `metadata` — NO transcript re-parse.
 *
 * Kinds covered: tool, mcp, skill, command, subagent.
 * Kinds explicitly excluded: hook, config — no invocation signal.
 */
async function rebuildComponentSessionUsage(
  tx: Prisma.TransactionClient,
  sessionIds: string[],
  now: string,
  dayExpr: (col: string) => string
): Promise<void> {
  if (sessionIds.length === 0) {
    return;
  }
  const ids = sessionIds;
  const ph = inPlaceholders(ids.length); // $1..$N — no leading `now` param
  // Step 1: clear stale rows for this batch (idempotent).
  await tx.$executeRawUnsafe(
    `DELETE FROM agent_component_session_usage WHERE session_id IN (${ph})`,
    ...ids
  );
  // Step 2: tool (built-ins) + mcp.
  // Group events by (session_id, kind, component_key). MCP tools carry
  // data.mcpServer from importToolEventData; fall back to the raw tool_name so
  // no signal is lost even if the parser did not fold in the server field.
  // The `Skill` tool call is EXCLUDED here (see insertToolAndMcpUsage) and
  // routed to the skill bucket instead (FEA-3048).
  await insertToolAndMcpUsage(tx, ids, ph, now, dayExpr);
  // Step 3: command — from session.slashCommands JSON stored in metadata.
  await insertCommandUsage(tx, ids, ph, now, dayExpr);
  // Step 4: skill — from the first-class `Skill` tool call
  // (`tool_name='Skill'`, `data.skillName`). FEA-3048: this replaces the former
  // fragile `UserPromptSubmit AND prompt LIKE '/_%'` heuristic, which was
  // live-hook-only (absent on imported JSONL), double-counted `/cmd` prompts
  // against the command bucket, and used an unescaped `_` SQL wildcard. Keying
  // off `data.skillName` works for BOTH live and imported data and can never
  // collide with a `/foo` slash-command (a command fires no `Skill` tool call).
  await insertSkillUsage(tx, ids, ph, now, dayExpr);
  // Step 5: subagent — from agents rows where type='subagent'.
  await insertSubagentUsage(tx, ids, ph, now, dayExpr);
  // T-8.5: existence upsert — for every (kind, key) in the just-written usage
  // rows, ensure an agent_components inventory row exists.
  await upsertEventDrivenComponents(tx, ids, ph, now);
}

/** Step 2 helper — INSERT tool + mcp usage rows. */
async function insertToolAndMcpUsage(
  tx: Prisma.TransactionClient,
  ids: string[],
  ph: string,
  _now: string,
  dayExpr: (col: string) => string
): Promise<void> {
  // component_key for mcp is the server name (data.mcpServer when present,
  // otherwise the raw tool_name so no event is silently dropped).
  // harness from the parent session row.
  //
  // DEFERRED (FEA-3048 follow-up — MCP per-method identity): mcp usage is keyed
  // by SERVER only (data.mcpServer), collapsing every `mcp__server__method`
  // call into one identity. Keying by (server, method) so distinct MCP methods
  // surface as distinct components is intentionally out of scope for this PR
  // (Tool + Skill classification) and tracked as a separate follow-up.
  // FEA-2990: also key by e.git_branch so a session that switches branches
  // mid-run splits its component usage per branch (the '' sentinel groups all
  // branch-less events — Codex, legacy pre-column rows — into one row, matching
  // the session-level attribution the cloud still falls back to for them).
  await tx.$executeRawUnsafe(
    `INSERT INTO agent_component_session_usage
       (session_id, component_kind, component_key, git_branch, agent_component_id,
        harness, invocations, error_count, first_invoked_at, last_invoked_at, started_day)
     SELECT
       e.session_id,
       CASE WHEN e.tool_name LIKE 'mcp__%' THEN 'mcp' ELSE 'tool' END AS component_kind,
       CASE
         WHEN e.tool_name LIKE 'mcp__%'
           THEN COALESCE(json_extract(e.data, '$.mcpServer'), e.tool_name)
         ELSE e.tool_name
       END AS component_key,
       COALESCE(e.git_branch, '') AS git_branch,
       (SELECT ac.id FROM agent_components ac
        WHERE ac.component_kind = CASE WHEN e.tool_name LIKE 'mcp__%' THEN 'mcp' ELSE 'tool' END
          AND ac.component_key  = CASE
                WHEN e.tool_name LIKE 'mcp__%'
                  THEN COALESCE(json_extract(e.data, '$.mcpServer'), e.tool_name)
                ELSE e.tool_name
              END
        LIMIT 1) AS agent_component_id,
       COALESCE(NULLIF(s.harness, ''), 'claude') AS harness,
       COUNT(*) AS invocations,
       SUM(CASE WHEN lower(e.event_type) LIKE '%error%'
                  OR json_extract(e.data, '$.isError') = 1
                THEN 1 ELSE 0 END) AS error_count,
       MIN(e.created_at) AS first_invoked_at,
       MAX(e.created_at) AS last_invoked_at,
       (SELECT ${dayExpr("s2.started_at")} FROM sessions s2 WHERE s2.id = e.session_id)
         AS started_day
     FROM events e
     JOIN sessions s ON s.id = e.session_id
     WHERE e.session_id IN (${ph})
       AND e.tool_name IS NOT NULL
       -- FEA-3048: the Skill tool call is the first-class skill signal; it is
       -- classified into the skill bucket by insertSkillUsage (keyed on
       -- data.skillName), NOT counted here as a generic built-in tool.
       AND e.tool_name != 'Skill'
     GROUP BY
       e.session_id,
       CASE WHEN e.tool_name LIKE 'mcp__%' THEN 'mcp' ELSE 'tool' END,
       CASE
         WHEN e.tool_name LIKE 'mcp__%'
           THEN COALESCE(json_extract(e.data, '$.mcpServer'), e.tool_name)
         ELSE e.tool_name
       END,
       COALESCE(e.git_branch, '')`,
    ...ids
  );
}

/** Step 3 helper — INSERT skill usage rows from `Skill` tool-call events. */
async function insertSkillUsage(
  tx: Prisma.TransactionClient,
  ids: string[],
  ph: string,
  _now: string,
  dayExpr: (col: string) => string
): Promise<void> {
  // FEA-3048: Claude fires a skill as a first-class tool call
  // `{"type":"tool_use","name":"Skill","input":{"skill":"<name>"}}`. Two write
  // paths land it under different keys, so we COALESCE across both:
  //   • JSONL import — the parser lifts it to `NormalizedToolUse.skillName` and
  //     `importToolEventData` persists `data.skillName='<name>'`.
  //   • live Claude hook — `agent-monitor-listener` POSTs the raw hook payload
  //     and `insertEvent` stores it unchanged, so the name stays under the hook
  //     shape `data.tool_input.skill` (there is no `data.skillName` here).
  // The `$.skill` leg is a defensive fallback for any payload that already
  // flattened the input. Keying off this signal — present on BOTH paths — is
  // what replaced the former `UserPromptSubmit AND prompt LIKE '/_%'` heuristic,
  // which fired only for the live hook, double-counted `/cmd` prompts against the
  // command bucket, and used an unescaped `_` SQL wildcard. A `/foo`
  // slash-command emits NO `Skill` tool call, so it can never be counted here —
  // the double-count is impossible by construction (no cross-bucket
  // disambiguation needed).
  const skillName = `COALESCE(json_extract(e.data, '$.skillName'), json_extract(e.data, '$.tool_input.skill'), json_extract(e.data, '$.skill'))`;
  await tx.$executeRawUnsafe(
    `INSERT INTO agent_component_session_usage
       (session_id, component_kind, component_key, git_branch, agent_component_id,
        harness, invocations, error_count, first_invoked_at, last_invoked_at, started_day)
     SELECT
       e.session_id,
       'skill' AS component_kind,
       ${skillName} AS component_key,
       -- FEA-2990: skills have no reliable per-event branch signal; the '' sentinel
       -- keeps them under session-level attribution on the cloud fallback.
       '' AS git_branch,
       (SELECT ac.id FROM agent_components ac
        WHERE ac.component_kind = 'skill'
          AND ac.component_key  = ${skillName}
        LIMIT 1) AS agent_component_id,
       COALESCE(NULLIF(s.harness, ''), 'claude') AS harness,
       COUNT(*) AS invocations,
       SUM(CASE WHEN lower(e.event_type) LIKE '%error%'
                  OR json_extract(e.data, '$.isError') = 1
                THEN 1 ELSE 0 END) AS error_count,
       MIN(e.created_at) AS first_invoked_at,
       MAX(e.created_at) AS last_invoked_at,
       (SELECT ${dayExpr("s2.started_at")} FROM sessions s2 WHERE s2.id = e.session_id)
         AS started_day
     FROM events e
     JOIN sessions s ON s.id = e.session_id
     WHERE e.session_id IN (${ph})
       AND e.tool_name = 'Skill'
       AND ${skillName} IS NOT NULL
       AND ${skillName} != ''
     GROUP BY e.session_id, ${skillName}`,
    ...ids
  );
}

/** Step 4 helper — INSERT command usage rows from session.slashCommands metadata. */
async function insertCommandUsage(
  tx: Prisma.TransactionClient,
  ids: string[],
  ph: string,
  _now: string,
  dayExpr: (col: string) => string
): Promise<void> {
  // session.slashCommands is stored as JSON array [{name, timestamp}, …] in the
  // sessions.metadata string blob. json_each expands it; the name does NOT
  // carry a leading '/'; we prepend one to match the '/<name>' component_key
  // convention. Each entry is one invocation (no COUNT needed: it's a distinct
  // slash-command call record).
  await tx.$executeRawUnsafe(
    `INSERT OR IGNORE INTO agent_component_session_usage
       (session_id, component_kind, component_key, git_branch, agent_component_id,
        harness, invocations, error_count, first_invoked_at, last_invoked_at, started_day)
     SELECT
       s.id AS session_id,
       'command' AS component_kind,
       '/' || json_extract(sc.value, '$.name') AS component_key,
       -- FEA-2990: slash commands come from session metadata, not per-event; ''
       -- sentinel keeps them under session-level attribution.
       '' AS git_branch,
       (SELECT ac.id FROM agent_components ac
        WHERE ac.component_kind = 'command'
          AND ac.component_key  = '/' || json_extract(sc.value, '$.name')
        LIMIT 1) AS agent_component_id,
       COALESCE(NULLIF(s.harness, ''), 'claude') AS harness,
       COUNT(*) AS invocations,
       0 AS error_count,
       MIN(json_extract(sc.value, '$.timestamp')) AS first_invoked_at,
       MAX(json_extract(sc.value, '$.timestamp')) AS last_invoked_at,
       ${dayExpr("s.started_at")} AS started_day
     FROM sessions s,
          json_each(json_extract(s.metadata, '$.slashCommands')) AS sc
     WHERE s.id IN (${ph})
       AND json_valid(s.metadata)
       AND json_type(s.metadata, '$.slashCommands') = 'array'
       AND json_extract(sc.value, '$.name') IS NOT NULL
     GROUP BY s.id, json_extract(sc.value, '$.name')`,
    ...ids
  );
}

/** Step 5 helper — INSERT subagent usage rows from agents table. */
async function insertSubagentUsage(
  tx: Prisma.TransactionClient,
  ids: string[],
  ph: string,
  _now: string,
  dayExpr: (col: string) => string
): Promise<void> {
  // One usage row per (session, subagent_type). invocations = spawn count.
  // subagent_type may be NULL for agents whose type column was not populated
  // (the Claude parser never sets it — it only assigns an instance-unique
  // `name` like "Claude subagent a00eeb0c"). Keying off that `name` exploded
  // one component per spawn, so instead roll every typeless subagent up into a
  // single 'general-purpose' component (the Task tool's default subagent_type):
  // genuinely-typed subagents keep their type, untyped ones collapse into one.
  // Never key off the per-instance `name`.
  await tx.$executeRawUnsafe(
    `INSERT INTO agent_component_session_usage
       (session_id, component_kind, component_key, git_branch, agent_component_id,
        harness, invocations, error_count, first_invoked_at, last_invoked_at, started_day)
     SELECT
       a.session_id,
       'subagent' AS component_kind,
       COALESCE(a.subagent_type, 'general-purpose') AS component_key,
       -- FEA-2990: subagent spawns are counted from the agents table, not per
       -- tool event; '' sentinel keeps them under session-level attribution.
       '' AS git_branch,
       (SELECT ac.id FROM agent_components ac
        WHERE ac.component_kind = 'subagent'
          AND ac.component_key  = COALESCE(a.subagent_type, 'general-purpose')
        LIMIT 1) AS agent_component_id,
       COALESCE(NULLIF(s.harness, ''), 'claude') AS harness,
       COUNT(*) AS invocations,
       SUM(CASE WHEN lower(a.status) LIKE '%error%'
                  OR lower(a.status) LIKE '%fail%'
                THEN 1 ELSE 0 END) AS error_count,
       MIN(a.started_at) AS first_invoked_at,
       MAX(COALESCE(a.ended_at, a.updated_at)) AS last_invoked_at,
       (SELECT ${dayExpr("s2.started_at")} FROM sessions s2 WHERE s2.id = a.session_id)
         AS started_day
     FROM agents a
     JOIN sessions s ON s.id = a.session_id
     WHERE a.session_id IN (${ph})
       AND a.type = 'subagent'
     GROUP BY a.session_id, COALESCE(a.subagent_type, 'general-purpose')`,
    ...ids
  );
}

/**
 * FEA-2923 (T-8.5): For every distinct (componentKind, componentKey) written
 * to `agent_component_session_usage` by `rebuildComponentSessionUsage`, ensure
 * an `agent_components` inventory row exists. First-seen/last-seen semantics:
 * INSERT on new discovery, UPDATE last_seen_at on revisit. Independent from
 * the usage write path (different table, different purpose).
 *
 * id = sha256(kind|componentKey) — deterministic + stable so a re-import
 * never creates a duplicate row.
 * Kinds with NO usage signal (hook, config) are skipped here — their existence
 * is discovered only by the filesystem scanner (future work).
 */
async function upsertEventDrivenComponents(
  tx: Prisma.TransactionClient,
  ids: string[],
  ph: string,
  now: string
): Promise<void> {
  // Collect the distinct (componentKind, componentKey) pairs that were just
  // written so we can compute deterministic ids in TypeScript (SQLite has no
  // built-in sha256 function).
  const rows = await tx.$queryRawUnsafe<
    { component_kind: string; component_key: string }[]
  >(
    `SELECT DISTINCT component_kind, component_key
     FROM agent_component_session_usage
     WHERE session_id IN (${ph})`,
    ...ids
  );
  if (rows.length === 0) {
    return;
  }
  for (const row of rows) {
    const kind = row.component_kind;
    const key = row.component_key;
    const compId = deterministicComponentId(kind, key);
    await tx.$executeRawUnsafe(
      `INSERT INTO agent_components
         (id, component_kind, external_id, component_key, first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (component_kind, external_id) DO UPDATE SET
         last_seen_at = excluded.last_seen_at`,
      compId,
      kind,
      key, // externalId = componentKey for event-driven discovery
      key, // componentKey
      now, // first_seen_at (ignored on conflict)
      now // last_seen_at (always updated)
    );
  }
}

/**
 * FEA-2038: one-time/idempotent backfill of the analytics rollups for every
 * session that lacks a `session_analytics` row (e.g. existing stores upgrading to
 * 0004, or any session imported before this code). Runs after migrations at db
 * open. Set-based: collapses the former N per-session transactions into
 * ⌈missing/CHUNK⌉ chunked transactions via `upsertSessionAnalyticsRollupBatch`,
 * which mirrors the per-session rollup SQL exactly. A failed chunk is logged and
 * skipped; remaining chunks still run.
 */
export async function backfillSessionAnalytics(
  prisma: DesktopPrisma,
  log: (message: string) => void,
  chunkSize: number = SESSION_ANALYTICS_BACKFILL_CHUNK
): Promise<void> {
  // Anti-join (sessions without a session_analytics row) — raw read on the one
  // client.
  const missing = await prisma.client.$queryRawUnsafe<{ id: string }[]>(
    `SELECT s.id FROM sessions s
     LEFT JOIN session_analytics sa ON sa.session_id = s.id
     WHERE sa.session_id IS NULL`
  );
  if (missing.length === 0) {
    return;
  }
  const ids = missing.map((row) => row.id);
  const now = new Date().toISOString();
  // FEA-3132 (D6): budget chunks by summed metadata bytes (secondary count bound
  // = chunkSize) so a large transcript can't balloon the json_each rollup scan.
  const chunks = await chunkSessionIdsByMetadataBudget(
    prisma,
    ids,
    SESSION_ANALYTICS_ROLLUP_METADATA_BUDGET_BYTES,
    Math.max(1, Math.floor(chunkSize))
  );
  let done = 0;
  for (const chunk of chunks) {
    try {
      await prisma.write((client) =>
        client.$transaction((tx) =>
          upsertSessionAnalyticsRollupBatch(tx, chunk, now)
        )
      );
      done += chunk.length;
    } catch (error) {
      log(
        `session-analytics backfill failed for ${chunk.length} session(s): ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  log(`session-analytics backfill complete: ${done}/${ids.length}`);
}

/**
 * FEA-2870: one-time/idempotent boot pass that re-derives the analytics rollup
 * for headless/autonomous sessions still marked `is_human = 1` by a pre-fix
 * rollup. The rollup SQL now forces `is_human = 0` for headless sessions (see
 * `headlessMetadataSql`), so re-running it flips the stale rows — correcting the
 * autonomy trend and the Human/Agent heatmap split for existing data. Bounded to
 * the mis-marked set and chunked exactly like `backfillSessionAnalytics`.
 */
export async function recomputeHeadlessSessionAnalytics(
  prisma: DesktopPrisma,
  log: (message: string) => void,
  chunkSize: number = SESSION_ANALYTICS_BACKFILL_CHUNK
): Promise<void> {
  const stale = await prisma.client.$queryRawUnsafe<{ id: string }[]>(
    `SELECT s.id FROM sessions s
     JOIN session_analytics sa ON sa.session_id = s.id
     WHERE sa.is_human = 1
       AND ${headlessMetadataSql("s.metadata")}`
  );
  if (stale.length === 0) {
    return;
  }
  const ids = stale.map((row) => row.id);
  const now = new Date().toISOString();
  // FEA-3132 (D6): metadata-byte-budgeted chunks (see backfillSessionAnalytics).
  const chunks = await chunkSessionIdsByMetadataBudget(
    prisma,
    ids,
    SESSION_ANALYTICS_ROLLUP_METADATA_BUDGET_BYTES,
    Math.max(1, Math.floor(chunkSize))
  );
  let done = 0;
  for (const chunk of chunks) {
    try {
      await prisma.write((client) =>
        client.$transaction((tx) =>
          upsertSessionAnalyticsRollupBatch(tx, chunk, now)
        )
      );
      done += chunk.length;
    } catch (error) {
      log(
        `headless session-analytics recompute failed for ${chunk.length} session(s): ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  log(
    `headless session-analytics recompute complete (FEA-2870): ${done}/${ids.length}`
  );
}

/**
 * COST_ATTRIBUTION_DRIFT: boot-time pass that re-prices `token_usage` rows to the
 * CURRENT `estimateTokenCost` of their EFFECTIVE total. Two row populations are
 * healed here:
 *
 *  1. `cost_usd_estimated IS NULL` — rows whose `model` was not priceable when
 *     first imported (e.g. a model that `genai-prices` did not yet know). A later
 *     app version that ships an updated pricing table can now price them.
 *  2. FEA-2879 repair: already-costed COMPACTED rows (`baseline_* > 0` AND
 *     `cost_usd_estimated IS NOT NULL`). A row compacted BEFORE the FEA-2879 patch
 *     had its cost computed by the old current-only pricing path, which ignored
 *     the pre-compaction totals rolled into `baseline_*`, so it undercounts. Since
 *     this PR does not bump `DATA_REVISION`, those rows are never re-imported and
 *     would keep their stale cost indefinitely without this repair.
 *
 * Most cost surfaces (session list/detail, cloud sync, artifact usage) re-derive
 * such rows on every read via `resolveTokenUsageCostUsd`, but the MATERIALIZED
 * snapshots — `session_analytics.est_cost` (the dashboard "Cost" KPI) and
 * `sessions.cost_usd_estimated` (the session-list authoritative cost) — were
 * frozen at the value the row contributed at rollup time (the `$0` a NULL row
 * contributes, or the undercounted current-only cost of a pre-patch compacted
 * row). So both populations leave those snapshots undercounting versus the
 * re-pricing read surfaces.
 *
 * This pass re-prices each affected row with the CURRENT `estimateTokenCost` of
 * the effective total (`current + baseline_*`), persists the newly-resolved cost
 * (mirroring the ingest path's `updateTokenUsageCost`), then rebuilds both
 * snapshots for the affected sessions (`updateSessionCostRollup` +
 * `upsertSessionAnalyticsRollupBatch`) so every surface agrees again.
 *
 * Idempotent / convergent: cost is recomputed from the effective total (never
 * added onto the stored value), and `baseline_*` is read-only here, so re-running
 * yields the identical cost — no double-count. A still-unpriceable NULL row stays
 * NULL and is skipped. An already-correct compacted row (stored cost already ==
 * the effective-total price) is left untouched, so once repaired it is never
 * rewritten and the pass converges. Chunked per session set like
 * `backfillSessionAnalytics`; a failed chunk is logged and skipped, and remaining
 * chunks still run.
 *
 * Scope: `token_usage` only. The sibling `token_events` table also stores a NULL
 * cost for unpriceable rows, but no surface reads its frozen `cost_usd_estimated`
 * as a materialized value (every token_events cost surface re-derives on read),
 * so there is no snapshot to heal there.
 */
export async function repriceUnpricedTokenUsage(
  prisma: DesktopPrisma,
  log: (message: string) => void,
  chunkSize: number = SESSION_ANALYTICS_BACKFILL_CHUNK
): Promise<void> {
  // Distinct sessions with at least one row that needs (re-)pricing: an unpriced
  // row (population 1) OR an already-costed compacted row whose stored cost may
  // predate the FEA-2879 effective-total pricing (population 2). Raw read on the
  // one client; the chunk pass filters precisely + skips already-correct rows.
  const unpriced = await prisma.client.$queryRawUnsafe<
    { session_id: string }[]
  >(
    `SELECT DISTINCT session_id FROM token_usage
      WHERE cost_usd_estimated IS NULL
         OR baseline_input > 0
         OR baseline_output > 0
         OR baseline_cache_read > 0
         OR baseline_cache_write > 0`
  );
  if (unpriced.length === 0) {
    return;
  }
  const ids = unpriced.map((row) => row.session_id);
  const now = new Date().toISOString();
  const safeChunkSize = Math.max(1, Math.floor(chunkSize));
  let repricedRows = 0;
  let repricedSessions = 0;
  for (let start = 0; start < ids.length; start += safeChunkSize) {
    const chunk = ids.slice(start, start + safeChunkSize);
    try {
      const result = await prisma.write((client) =>
        client.$transaction((tx) =>
          repriceUnpricedTokenUsageChunk(tx, chunk, now)
        )
      );
      repricedRows += result.repricedRows;
      repricedSessions += result.repricedSessions;
    } catch (error) {
      log(
        `token-usage re-pricing failed for chunk [${start}, ${start + chunk.length}): ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  log(
    `token-usage re-pricing complete: repriced ${repricedRows} row(s) across ${repricedSessions} session(s)`
  );
}

/**
 * Re-price one chunk of sessions in a single transaction, persist the
 * newly-resolved costs, and rebuild both cost snapshots for the sessions that
 * actually changed. Returns counts for the caller's completion log.
 *
 * Selects the two populations `repriceUnpricedTokenUsage` documents: unpriced
 * rows (`cost_usd_estimated IS NULL`) and already-costed compacted rows
 * (`baseline_* > 0`). For each, prices the EFFECTIVE total (current +
 * pre-compaction `baseline_*`):
 *  - a row that is still unpriceable is left NULL and silently skipped (it was
 *    already reported as a pricing miss at ingest, so re-reporting it every boot
 *    would only add noise);
 *  - a row whose freshly-computed effective cost already equals the stored value
 *    is left untouched — this makes the FEA-2879 compacted-row repair convergent:
 *    once repriced, it never rewrites again.
 */
async function repriceUnpricedTokenUsageChunk(
  tx: Prisma.TransactionClient,
  sessionIds: string[],
  now: string
): Promise<{ repricedRows: number; repricedSessions: number }> {
  if (sessionIds.length === 0) {
    return { repricedRows: 0, repricedSessions: 0 };
  }
  const placeholders = sessionIds.map((_, i) => `$${i + 1}`).join(", ");
  const rows = await tx.$queryRawUnsafe<
    {
      session_id: string;
      model: string;
      input_tokens: unknown;
      output_tokens: unknown;
      cache_read_tokens: unknown;
      cache_write_tokens: unknown;
      created_at: string | null;
      cost_usd_estimated: number | null;
    }[]
  >(
    // FEA-2879: reprice the EFFECTIVE total (current + pre-compaction
    // baseline_*) so a compacted session's healed cost reflects all incurred
    // tokens, not just the post-compaction subset. Mirrors
    // selectTokenUsagePricingRows; aliases keep the row shape unchanged. Selects
    // BOTH unpriced rows and already-costed compacted rows (baseline_* > 0) so
    // pre-FEA-2879 compacted rows priced under the old current-only path are
    // repaired; `cost_usd_estimated` is read back to skip already-correct rows.
    `SELECT session_id, model,
            input_tokens + baseline_input AS input_tokens,
            output_tokens + baseline_output AS output_tokens,
            cache_read_tokens + baseline_cache_read AS cache_read_tokens,
            cache_write_tokens + baseline_cache_write AS cache_write_tokens,
            created_at,
            cost_usd_estimated
       FROM token_usage
      WHERE (
              cost_usd_estimated IS NULL
              OR baseline_input > 0
              OR baseline_output > 0
              OR baseline_cache_read > 0
              OR baseline_cache_write > 0
            )
        AND session_id IN (${placeholders})`,
    ...sessionIds
  );
  const affected = new Set<string>();
  let repricedRows = 0;
  for (const row of rows) {
    const observedAt = row.created_at ?? now;
    const estimate = estimateTokenCost({
      model: row.model,
      inputTokens: tokenCountValue(row.input_tokens, "reprice.input"),
      outputTokens: tokenCountValue(row.output_tokens, "reprice.output"),
      cacheReadTokens: tokenCountValue(
        row.cache_read_tokens,
        "reprice.cache_read"
      ),
      cacheWriteTokens: tokenCountValue(
        row.cache_write_tokens,
        "reprice.cache_write"
      ),
      observedAt,
    });
    if (!estimate) {
      // Still unpriceable with the current table — leave NULL, revisit next boot.
      continue;
    }
    // Convergence guard: an already-costed compacted row whose stored cost
    // already matches the effective-total price needs no rewrite. Recomputing
    // from the effective total (never additively) means a correctly-priced row
    // hits this equality on every subsequent boot, so the repair runs at most
    // once per row. `cost_usd_estimated` is read straight from the row above and
    // compared to the value updateTokenUsageCost would persist — both flow from
    // the same estimateTokenCost path, so exact equality is stable.
    const storedCost =
      row.cost_usd_estimated == null ? null : Number(row.cost_usd_estimated);
    if (storedCost !== null && storedCost === estimate.costUsd) {
      continue;
    }
    await updateTokenUsageCost(
      tx,
      row.session_id,
      row.model,
      estimate,
      observedAt
    );
    affected.add(row.session_id);
    repricedRows += 1;
  }
  const repricedSessions = [...affected];
  if (repricedSessions.length > 0) {
    // Heal the per-session snapshot (`sessions.cost_usd_estimated`) and the
    // analytics rollup (`session_analytics.est_cost`) the same way the ingest
    // path does once token_usage costs change.
    for (const sessionId of repricedSessions) {
      await updateSessionCostRollup(tx, sessionId);
    }
    await upsertSessionAnalyticsRollupBatch(tx, repricedSessions, now);
  }
  return { repricedRows, repricedSessions: repricedSessions.length };
}

/**
 * FEA-2344: boot-time pass that re-splits the cache cost components of
 * `token_events` rows whose `cache_creation_cost_usd_estimated` is NULL and that
 * have cache tokens. Pre-fix writes folded all cache cost into `input_cost`, so
 * the cache columns are ~$0 and `cache_creation` is hardcoded NULL. This pass
 * recomputes the split with the fixed `estimateTokenCost` and updates ONLY the
 * component columns — `cost_usd_estimated` totals are already correct and are
 * never touched. Idempotent: post-fix writes always store a number in
 * `cache_creation`, so the NULL filter converges and healed rows are never
 * revisited. Chunked per session; a failed chunk is logged and skipped.
 */
export async function healCacheCostSplit(
  prisma: DesktopPrisma,
  log: (message: string) => void,
  chunkSize: number = SESSION_ANALYTICS_BACKFILL_CHUNK
): Promise<void> {
  const unhealed = await prisma.client.$queryRawUnsafe<
    { session_id: string }[]
  >(
    `SELECT DISTINCT session_id FROM token_events
     WHERE cost_usd_estimated IS NOT NULL
       AND (cache_read_tokens > 0 OR cache_write_tokens > 0)
       AND cache_creation_cost_usd_estimated IS NULL`
  );
  if (unhealed.length === 0) {
    return;
  }
  const ids = unhealed.map((row) => row.session_id);
  const safeChunkSize = Math.max(1, Math.floor(chunkSize));
  let healedRows = 0;
  let healedSessions = 0;
  let failedChunks = 0;
  for (let start = 0; start < ids.length; start += safeChunkSize) {
    const chunk = ids.slice(start, start + safeChunkSize);
    try {
      const count = await prisma.write((client) =>
        client.$transaction((tx) => healCacheCostSplitChunk(tx, chunk))
      );
      healedRows += count;
      if (count > 0) {
        healedSessions += chunk.length;
      }
    } catch (error) {
      failedChunks += 1;
      log(
        `cache-cost-split heal failed for chunk [${start}, ${start + chunk.length}): ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  if (healedRows > 0 || failedChunks > 0) {
    log(
      `cache-cost-split heal: re-split ${healedRows} row(s) across ${healedSessions} session(s)` +
        (failedChunks > 0 ? ` (${failedChunks} chunk(s) failed)` : "")
    );
  }
}

async function healCacheCostSplitChunk(
  tx: Prisma.TransactionClient,
  sessionIds: string[]
): Promise<number> {
  if (sessionIds.length === 0) {
    return 0;
  }
  const placeholders = sessionIds.map((_, i) => `$${i + 1}`).join(", ");
  const rows = await tx.$queryRawUnsafe<
    {
      session_id: string;
      model: string;
      created_at: string;
      input_tokens: unknown;
      output_tokens: unknown;
      cache_read_tokens: unknown;
      cache_write_tokens: unknown;
    }[]
  >(
    `SELECT session_id, model, created_at, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens
       FROM token_events
      WHERE cost_usd_estimated IS NOT NULL
        AND (cache_read_tokens > 0 OR cache_write_tokens > 0)
        AND cache_creation_cost_usd_estimated IS NULL
        AND session_id IN (${placeholders})`,
    ...sessionIds
  );
  let healed = 0;
  const affected = new Set<string>();
  for (const row of rows) {
    const inputTokens = tokenCountValue(row.input_tokens, "heal.input");
    const outputTokens = tokenCountValue(row.output_tokens, "heal.output");
    const cacheReadTokens = tokenCountValue(
      row.cache_read_tokens,
      "heal.cache_read"
    );
    const cacheWriteTokens = tokenCountValue(
      row.cache_write_tokens,
      "heal.cache_write"
    );
    const estimate = estimateTokenCost({
      model: row.model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      observedAt: row.created_at,
    });
    if (!estimate) {
      continue;
    }
    await tx.$executeRawUnsafe(
      `UPDATE token_events SET
         input_cost_usd_estimated = $1,
         cache_read_cost_usd_estimated = $2,
         cache_creation_cost_usd_estimated = $3
       WHERE session_id = $4
         AND model = $5
         AND created_at = $6
         AND input_tokens = $7
         AND output_tokens = $8
         AND cache_read_tokens = $9
         AND cache_write_tokens = $10`,
      estimate.inputCostUsd,
      estimate.cacheReadCostUsd,
      estimate.cacheWriteCostUsd,
      row.session_id,
      row.model,
      row.created_at,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens
    );
    affected.add(row.session_id);
    healed += 1;
  }
  if (affected.size > 0) {
    const affectedPlaceholders = [...affected]
      .map((_, i) => `$${i + 1}`)
      .join(", ");
    await tx.$executeRawUnsafe(
      `UPDATE sessions SET updated_at = datetime('now')
       WHERE id IN (${affectedPlaceholders})`,
      ...[...affected]
    );
  }
  return healed;
}

/**
 * Perf: (re)compute and persist `sessions.last_activity_at` for one session from
 * its current `events` / `started_at` rows. This is the denormalized cursor sort
 * key the Sessions list orders by; recomputing it from source on every ingest
 * write keeps it correct on re-import and on each live hook event. The value is
 * BYTE-FOR-BYTE the old per-page cursor expression:
 *   COALESCE(MAX(<events.created_at GLOB-guarded, else NULL>),
 *            <started_at GLOB-guarded, else 1970 epoch>)
 * so the read path that now ORDER BYs this column produces an identical page.
 * Scoped to one session_id — cheap (uses idx_events_session_id).
 *
 * Exported as the single source of truth for the denormalized-key SQL: test
 * fixtures that write events directly (bypassing the importer/hook ingest paths)
 * call this instead of re-implementing the UPDATE, so the expression can never
 * drift between production and tests.
 */
export async function recomputeSessionLastActivityAt(
  tx: Prisma.TransactionClient,
  sessionId: string
): Promise<void> {
  await tx.$executeRawUnsafe(
    `UPDATE sessions
       SET last_activity_at = COALESCE(
         (
           SELECT MAX(
             CASE
               WHEN e.created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'
                 THEN e.created_at
               ELSE NULL
             END
           )
           FROM events e
           WHERE e.session_id = sessions.id
         ),
         CASE
           WHEN started_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'
             THEN started_at
           ELSE '1970-01-01T00:00:00.000Z'
         END
       )
     WHERE id = $1`,
    sessionId
  );
}

// Per-session aggregate CTEs (agent/event counts + token totals) the detail
// reads LEFT-JOIN onto the filtered/paginated session set in a single query.

function mainAgentId(sessionId: string): string {
  return `${sessionId}-main`;
}

function getSession(tx: Prisma.TransactionClient, sessionId: string) {
  return tx.session.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      status: true,
      harness: true,
      billingMode: true,
      model: true,
    },
  });
}

function getImportSession(tx: Prisma.TransactionClient, sessionId: string) {
  return tx.session.findUnique({
    where: { id: sessionId },
    select: { id: true, status: true, endedAt: true },
  });
}

function getAgent(tx: Prisma.TransactionClient, agentId: string) {
  return tx.agent.findUnique({
    where: { id: agentId },
    select: { id: true, status: true, type: true, parentAgentId: true },
  });
}

async function ensureSession(
  tx: Prisma.TransactionClient,
  sessionId: string,
  data: HookData,
  harness: string,
  now: string,
  detectBillingMode: (harness: string) => string,
  getUserIdentity?: () => {
    userId: string | null;
    organizationId: string | null;
  } | null
): Promise<void> {
  if (await getSession(tx, sessionId)) {
    return;
  }
  const billingMode = safe(() => detectBillingMode(harness)) ?? "unknown";
  const identity = safe(() => getUserIdentity?.()) ?? null;
  await tx.$executeRawUnsafe(
    `INSERT INTO sessions (
       id, name, status, cwd, model, started_at, updated_at, harness,
       billing_mode, user_id, organization_id, data_revision
     )
     VALUES ($1, $2, 'active', $3, $4, $5, $5, $6, $7, $8, $9, $10)`,
    sessionId,
    data.session_name ?? null,
    data.cwd ?? null,
    data.model ?? null,
    now,
    harness,
    billingMode,
    identity?.userId ?? null,
    identity?.organizationId ?? null,
    DATA_REVISION
  );
  await tx.$executeRawUnsafe(
    `INSERT INTO agents (id, session_id, name, type, subagent_type, status, task, current_tool, started_at, updated_at, parent_agent_id, metadata)
     VALUES ($1, $2, 'main', 'main', NULL, 'working', NULL, NULL, $3, $3, NULL, NULL)`,
    mainAgentId(sessionId),
    sessionId,
    now
  );
}

async function clearAwaitingInput(
  tx: Prisma.TransactionClient,
  sessionId: string,
  now: string
): Promise<void> {
  await tx.$executeRawUnsafe(
    "UPDATE sessions SET awaiting_input_since = NULL, updated_at = $1 WHERE id = $2",
    now,
    sessionId
  );
  await tx.$executeRawUnsafe(
    "UPDATE agents SET awaiting_input_since = NULL, updated_at = $1 WHERE session_id = $2 AND awaiting_input_since IS NOT NULL",
    now,
    sessionId
  );
}

async function setMainWaiting(
  tx: Prisma.TransactionClient,
  sessionId: string,
  now: string
): Promise<void> {
  await tx.$executeRawUnsafe(
    "UPDATE sessions SET awaiting_input_since = $1, updated_at = $1 WHERE id = $2",
    now,
    sessionId
  );
  await tx.$executeRawUnsafe(
    "UPDATE agents SET awaiting_input_since = $1, status = 'waiting', updated_at = $1 WHERE id = $2",
    now,
    mainAgentId(sessionId)
  );
}

async function promoteMain(
  tx: Prisma.TransactionClient,
  main: string,
  now: string
): Promise<void> {
  await tx.$executeRawUnsafe(
    "UPDATE agents SET status = 'working', awaiting_input_since = NULL, updated_at = $1 WHERE id = $2 AND status != 'working'",
    now,
    main
  );
}

async function setAgentTool(
  tx: Prisma.TransactionClient,
  agentId: string,
  toolName: string | null,
  now: string
): Promise<void> {
  await tx.$executeRawUnsafe(
    "UPDATE agents SET current_tool = $1, status = 'working', updated_at = $2 WHERE id = $3",
    toolName,
    now,
    agentId
  );
}

async function setAgentStatus(
  tx: Prisma.TransactionClient,
  agentId: string,
  status: string,
  now: string
): Promise<void> {
  await tx.$executeRawUnsafe(
    "UPDATE agents SET status = $1, updated_at = $2, ended_at = $2 WHERE id = $3",
    status,
    now,
    agentId
  );
}

async function setSessionStatus(
  tx: Prisma.TransactionClient,
  sessionId: string,
  status: string,
  now: string
): Promise<void> {
  await tx.$executeRawUnsafe(
    "UPDATE sessions SET status = $1, updated_at = $2, ended_at = $2 WHERE id = $3",
    status,
    now,
    sessionId
  );
}

async function insertEvent(
  tx: Prisma.TransactionClient,
  sessionId: string,
  agentId: string | null,
  eventType: string,
  data: HookData,
  now: string,
  summary?: string
): Promise<void> {
  const toolName = data.tool_name ?? null;
  const discriminator =
    typeof data.tool_use_id === "string" ? data.tool_use_id : null;
  await tx.$executeRawUnsafe(
    "INSERT INTO events (id, session_id, agent_id, event_type, tool_name, summary, data, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING",
    deterministicEventId(sessionId, eventType, now, toolName, discriminator),
    sessionId,
    agentId,
    eventType,
    toolName,
    summary ?? null,
    importEventData(data),
    now
  );
}

async function maybeReactivate(
  tx: Prisma.TransactionClient,
  session: { id: string; status: string },
  hookType: string,
  now: string
): Promise<void> {
  if (
    session.status === DESKTOP_SESSION_STATUS.ACTIVE ||
    hookType === "SessionEnd"
  ) {
    return;
  }
  const isUserActivity =
    hookType === "UserPromptSubmit" || hookType === "PreToolUse";
  const isStopLike = hookType === "Stop" || hookType === "SubagentStop";
  const reactivate =
    isUserActivity ||
    (!isStopLike && session.status !== DESKTOP_SESSION_STATUS.ERROR) ||
    (isStopLike &&
      (session.status === DESKTOP_SESSION_STATUS.COMPLETED ||
        session.status === DESKTOP_SESSION_STATUS.ABANDONED));
  if (reactivate) {
    await tx.$executeRawUnsafe(
      "UPDATE sessions SET status = 'active', updated_at = $1, ended_at = NULL WHERE id = $2",
      now,
      session.id
    );
    await promoteMain(tx, mainAgentId(session.id), now);
    session.status = DESKTOP_SESSION_STATUS.ACTIVE;
  }
}

async function spawnSubagent(
  tx: Prisma.TransactionClient,
  sessionId: string,
  data: HookData,
  now: string
): Promise<string> {
  const input = (data.tool_input as Record<string, unknown> | undefined) ?? {};
  const description = strOf(input.description) ?? strOf(data.description);
  const subagentType = strOf(input.subagent_type) ?? strOf(data.subagent_type);
  const prompt = strOf(input.prompt) ?? strOf(data.prompt);
  const nativeSubagentId = extractNativeSubagentId(data);
  const metadata = nativeSubagentId
    ? JSON.stringify({ nativeSubagentId })
    : null;
  const name =
    description ??
    subagentType ??
    (prompt ? prompt.split("\n")[0].slice(0, 60) : undefined) ??
    "Subagent";
  let parentId = mainAgentId(sessionId);
  const main = await getAgent(tx, parentId);
  if (main?.status !== DESKTOP_AGENT_STATUS.WORKING) {
    // RAW (named blocker: recursive CTE) — find the deepest working subagent.
    const deepest = await tx.$queryRawUnsafe<{ id: string }[]>(
      `
      WITH RECURSIVE chain(id, depth) AS (
        SELECT id, 0 FROM agents WHERE session_id = $1 AND parent_agent_id IS NULL
        UNION ALL
        SELECT a.id, c.depth + 1 FROM agents a JOIN chain c ON a.parent_agent_id = c.id
      )
      SELECT a.id AS id FROM chain c JOIN agents a ON a.id = c.id
      WHERE a.status = 'working' AND a.type = 'subagent'
      ORDER BY c.depth DESC, a.started_at DESC LIMIT 1
    `,
      sessionId
    );
    if (deepest[0]) {
      parentId = deepest[0].id;
    }
  }
  const agentId = `${sessionId}-sub-${randomUUID().slice(0, 8)}`;
  await tx.$executeRawUnsafe(
    `INSERT INTO agents (id, session_id, name, type, subagent_type, status, task, current_tool, started_at, updated_at, parent_agent_id, metadata)
     VALUES ($1, $2, $3, 'subagent', $4, 'working', $5, NULL, $6, $6, $7, $8)`,
    agentId,
    sessionId,
    name,
    subagentType ?? null,
    prompt ? prompt.slice(0, 500) : null,
    now,
    parentId,
    metadata
  );
  return agentId;
}

async function matchSubagent(
  tx: Prisma.TransactionClient,
  sessionId: string,
  data: HookData
): Promise<string | null> {
  const candidates = await tx.agent.findMany({
    where: { sessionId, type: "subagent", status: "working" },
    select: { id: true, name: true, subagentType: true, task: true },
    orderBy: { startedAt: "desc" },
  });
  if (candidates.length === 0) {
    return null;
  }
  const prefix =
    strOf(data.description) ??
    strOf(data.agent_type) ??
    strOf(data.subagent_type);
  if (prefix) {
    const byName = candidates.find((a) => a.name?.startsWith(prefix));
    if (byName) {
      return byName.id;
    }
  }
  if (data.agent_type) {
    const byType = candidates.find((a) => a.subagentType === data.agent_type);
    if (byType) {
      return byType.id;
    }
  }
  if (data.prompt) {
    const task = String(data.prompt).slice(0, 500);
    const byTask = candidates.find((a) => a.task === task);
    if (byTask) {
      return byTask.id;
    }
  }
  return candidates[0].id;
}

async function resolveNativeSubagentTranscriptPath(
  tx: Prisma.TransactionClient,
  agentId: string,
  _sessionId: string,
  transcriptPath: unknown
): Promise<string | null> {
  if (typeof transcriptPath !== "string" || transcriptPath.length === 0) {
    return null;
  }
  if (transcriptPath.includes(`${path.sep}subagents${path.sep}`)) {
    return null;
  }
  const row = await tx.agent.findUnique({
    where: { id: agentId },
    select: { metadata: true },
  });
  const metadata = row?.metadata ? safeJsonParse(row.metadata) : null;
  const nativeSubagentId =
    metadata && typeof metadata.nativeSubagentId === "string"
      ? normalizeNativeSubagentId(metadata.nativeSubagentId)
      : null;
  if (!nativeSubagentId) {
    return null;
  }
  const parentPath = path.resolve(transcriptPath);
  if (parentPath.includes(`${path.sep}subagents${path.sep}`)) {
    return null;
  }
  const roots = [getClaudeProjectsDir()].filter(
    (root): root is string => typeof root === "string" && root.length > 0
  );
  if (!isImportableSourcePath(parentPath, roots)) {
    return null;
  }
  const parentStat = await lstat(parentPath).catch(() => null);
  if (!parentStat?.isFile() || parentStat.isSymbolicLink()) {
    return null;
  }
  const subagentsDir = path.join(
    path.dirname(parentPath),
    path.basename(parentPath, ".jsonl"),
    "subagents"
  );
  const candidate = path.join(subagentsDir, `${nativeSubagentId}.jsonl`);
  const candidateStat = await lstat(candidate).catch(() => null);
  if (!candidateStat?.isFile() || candidateStat.isSymbolicLink()) {
    return null;
  }
  const [realSubagentsDir, realCandidate] = await Promise.all([
    realpath(subagentsDir).catch(() => null),
    realpath(candidate).catch(() => null),
  ]);
  if (!(realSubagentsDir && realCandidate)) {
    return null;
  }
  if (!isImportableSourcePath(realCandidate, roots)) {
    return null;
  }
  const relative = path.relative(realSubagentsDir, realCandidate);
  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  return realCandidate;
}

function extractNativeSubagentId(data: HookData): string | null {
  const input = (data.tool_input as Record<string, unknown> | undefined) ?? {};
  return (
    normalizeNativeSubagentId(data.nativeSubagentId) ??
    normalizeNativeSubagentId(data.native_subagent_id) ??
    normalizeNativeSubagentId(data.subagentId) ??
    normalizeNativeSubagentId(data.subagent_id) ??
    normalizeNativeSubagentId(data.agentId) ??
    normalizeNativeSubagentId(data.agent_id) ??
    normalizeNativeSubagentId(input.nativeSubagentId) ??
    normalizeNativeSubagentId(input.native_subagent_id) ??
    normalizeNativeSubagentId(input.subagentId) ??
    normalizeNativeSubagentId(input.subagent_id) ??
    normalizeNativeSubagentId(input.agentId) ??
    normalizeNativeSubagentId(input.agent_id)
  );
}

function normalizeNativeSubagentId(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const stem = value.endsWith(".jsonl") ? value.slice(0, -6) : value;
  return CLAUDE_NATIVE_SUBAGENT_STEM_PATTERN.test(stem) ? stem : null;
}

async function sweepStaleSessions(
  tx: Prisma.TransactionClient,
  currentSessionId: string,
  now: string,
  staleMinutes: number
): Promise<void> {
  const cutoff = new Date(
    new Date(now).valueOf() - staleMinutes * 60_000
  ).toISOString();
  const stale = await tx.session.findMany({
    where: {
      status: "active",
      id: { not: currentSessionId },
      updatedAt: { lt: cutoff },
    },
    select: { id: true },
  });
  for (const { id } of stale) {
    await tx.$executeRawUnsafe(
      "UPDATE agents SET status = 'completed', ended_at = $1, updated_at = $1 WHERE session_id = $2 AND status NOT IN ('completed', 'error')",
      now,
      id
    );
    await tx.$executeRawUnsafe(
      "UPDATE sessions SET status = 'abandoned', ended_at = $1, updated_at = $1 WHERE id = $2",
      now,
      id
    );
  }
}

function buildImportMetadata(
  session: NormalizedSession,
  harness: Harness
): string {
  return JSON.stringify({
    version: session.version ?? null,
    slug: session.slug ?? null,
    gitBranch: session.gitBranch ?? null,
    userMessages: session.userMessages ?? 0,
    assistantMessages: session.assistantMessages ?? 0,
    entrypoint: session.entrypoint ?? harness,
    permissionMode: session.permissionMode ?? null,
    thinkingBlockCount: session.thinkingBlockCount ?? 0,
    teams: session.teams ?? [],
    plans: session.plans ?? [],
    usageExtras: session.usageExtras ?? {
      service_tiers: [],
      speeds: [],
      inference_geos: [],
    },
    compactions: session.compactions ?? [],
    messages: session.messages ?? [],
    tokenSeries: session.tokenSeries ?? [],
    diffStats: session.diffStats ?? null,
    slashCommands: session.slashCommands ?? [],
    artifacts: session.artifacts ?? { prs: [], issues: [], repo: null },
    // FEA-2771: persist the parse-quality signal (malformed-line drops,
    // truncated final line) into the metadata blob so it survives the session
    // row, cloud sync, and detail reads — otherwise the parser computes it but
    // it is dropped before any consumer can observe corruption.
    parseQuality: session.parseQuality ?? null,
  });
}

async function persistNormalizedPullRequests(
  tx: Prisma.TransactionClient,
  session: NormalizedSession,
  harness: Harness,
  now: string,
  // `repo#number` → head branch, for PRs this session CREATED (per the artifact-
  // ref extractor, which records the branch active at `gh pr create` time). A PR
  // absent from this map was merely referenced and carries no head ref.
  createdPrHeadBranches: ReadonlyMap<string, string | null>
): Promise<number> {
  const artifacts = session.artifacts;
  const prs = Array.isArray(artifacts?.prs) ? artifacts.prs : [];
  if (prs.length === 0) {
    return 0;
  }

  let captured = 0;
  const defaultRepo = normalizeRepoFullName(artifacts?.repo);
  const observedAt = session.endedAt ?? session.startedAt ?? now;
  for (const pr of prs) {
    const fromUrl =
      typeof pr.url === "string" ? parseGitHubPrUrl(pr.url) : null;
    const prNumber = fromUrl?.number ?? numberFromUnknown(pr.number);
    const repoFullName =
      fromUrl?.repoFullName ?? normalizeRepoFullName(pr.repo) ?? defaultRepo;
    if (!(prNumber && repoFullName)) {
      continue;
    }
    const prUrl =
      pr.url ?? `https://github.com/${repoFullName}/pull/${prNumber}`;
    // Only a PR this session CREATED has a head branch we can trust — the branch
    // the user was on at `gh pr create` time, captured by the extractor. A merely-
    // referenced PR (someone else's, or one inspected via `gh pr view`) is absent
    // from the map and must NOT inherit this session's branch, or it is mis-filed
    // onto this branch in the Branches view and the branch↔PR link propagation
    // (both match on `pull_requests.branch_name`).
    const headBranch =
      createdPrHeadBranches.get(`${repoFullName}#${prNumber}`) ?? null;
    // Dual-write: PR detail goes into pull_requests (lifecycle store, feeds
    // FEA-1869 status observer); attribution goes into artifacts below.
    await upsertPullRequest(tx, {
      externalSessionId: session.sessionId,
      harness,
      prUrl,
      prNumber,
      repoFullName,
      branchName: headBranch,
      headSha: null,
      title: null,
    });

    // FEA-1899: PRs are canonical kind='pull_request' artifacts keyed by
    // identity_key. COALESCE-fill the descriptive fields and bump last_seen_at;
    // never touch enrichment columns. SQLite has no `xmax`, so distinguish a
    // fresh insert (counts as captured) from an ON CONFLICT update by probing
    // for the row first: absence ⇒ this upsert will insert ⇒ captured.
    const identityKey = computeIdentityKey({
      kind: "pull_request",
      repoFullName,
      prNumber,
    });
    const artifactId = artifactIdFromIdentityKey(identityKey);
    const existingArtifact = await tx.artifact.findUnique({
      where: { identityKey },
      select: { id: true },
    });
    const wasInserted = existingArtifact === null;
    const artifactRows = await tx.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO artifacts
         (id, identity_key, kind, repo_full_name, pr_number, branch_name,
          title, harness, url, observed_at, created_at, last_seen_at)
       VALUES ($1,$2,'pull_request',$3,$4,$5,$6,$7,$8,$9,$9,$9)
       ON CONFLICT(identity_key) DO UPDATE SET
         last_seen_at = EXCLUDED.last_seen_at,
         branch_name = COALESCE(
           CASE WHEN artifacts.branch_name IN (${defaultBranchSqlList()})
                     AND COALESCE(artifacts.enrichment_state, '') != 'final'
                THEN NULL
                ELSE artifacts.branch_name END,
           EXCLUDED.branch_name),
         title = COALESCE(artifacts.title, EXCLUDED.title),
         harness = COALESCE(artifacts.harness, EXCLUDED.harness),
         url = COALESCE(artifacts.url, EXCLUDED.url),
         observed_at = COALESCE(artifacts.observed_at, EXCLUDED.observed_at)
       RETURNING id`,
      artifactId,
      identityKey,
      repoFullName,
      prNumber,
      headBranch,
      null,
      harness,
      prUrl,
      observedAt
    );
    const resolvedArtifactId = artifactRows[0]?.id ?? artifactId;
    // session.artifacts.prs is populated by collectArtifacts for ANY PR URL the
    // session touched (created OR merely referenced), so we cannot assert
    // 'created' here without corrupting attribution. The artifact-ref extractor
    // owns the created-vs-referenced distinction via tool-call evidence and runs
    // first (persistArtifactLinks above). Only add a conservative 'referenced'
    // link when the extractor did not already link this PR to the session.
    const linkId = artifactLinkId(
      session.sessionId,
      "pull_request",
      `${repoFullName}#${prNumber}`,
      "referenced"
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO session_artifact_links
         (id, session_id, artifact_id, relation, method, evidence, is_primary,
          status, extractor_version, observed_at, created_at)
       SELECT $1,$2,$3,'referenced','normalized_pr','{}',0,'candidate',1,$4,$4
       WHERE NOT EXISTS (
         SELECT 1 FROM session_artifact_links
         WHERE session_id = $2 AND artifact_id = $3
       )
       ON CONFLICT(session_id, artifact_id, relation) DO NOTHING`,
      linkId,
      session.sessionId,
      resolvedArtifactId,
      observedAt
    );
    if (wasInserted) {
      captured++;
    }
  }
  return captured;
}

function importEventData(input: unknown): string | null {
  if (input == null) {
    return null;
  }
  let text: string;
  try {
    text = JSON.stringify(input);
  } catch {
    return null;
  }
  if (text.length > MAX_EVENT_DATA_BYTES) {
    return JSON.stringify({ truncated: true, bytes: text.length });
  }
  return text;
}

function importToolEventData(toolUse: NormalizedToolUse): string | null {
  const input = asRecord(toolUse.input);
  const payload: Record<string, unknown> = input ? { ...input } : {};
  if (toolUse.skillName && !payload.skillName) {
    payload.skillName = toolUse.skillName;
  }
  if (toolUse.mcpServer && !payload.mcpServer) {
    payload.mcpServer = toolUse.mcpServer;
  }
  if (toolUse.mcpMethod && !payload.mcpMethod) {
    payload.mcpMethod = toolUse.mcpMethod;
  }
  if (toolUse.diffDelta && !payload.diffDelta) {
    payload.diffDelta = toolUse.diffDelta;
  }
  return Object.keys(payload).length > 0 ? importEventData(payload) : null;
}

function buildSubagentMetadata(subagent: NormalizedSubagent): string | null {
  const metadata: Record<string, unknown> = {
    ...(subagent.metadata ?? {}),
  };
  if (subagent.nativeSubagentId) {
    metadata.nativeSubagentId = subagent.nativeSubagentId;
  }
  if (Object.keys(metadata).length === 0) {
    return null;
  }
  return importEventData(metadata);
}

function sanitizeSubagentIdSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 160);
}

function subagentName(tu: NormalizedToolUse): string {
  const input = (tu.input ?? {}) as Record<string, unknown>;
  const description = strOf(input.description);
  const subagentType = strOf(input.subagent_type);
  const prompt = strOf(input.prompt);
  return (
    description ??
    subagentType ??
    (prompt ? prompt.split("\n")[0].slice(0, 60) : undefined) ??
    "Subagent"
  );
}

async function persistImportedTokenCosts(
  tx: Prisma.TransactionClient,
  input: {
    sessionId: string;
    harness: string;
    tokenUsageObservedAt: string;
    tokenUsageModels?: string[];
    tokenEvents: TokenEventRecord[];
    tokenEventObservedAtFallback: string;
  }
): Promise<void> {
  const usageRows = await selectTokenUsagePricingRows(
    tx,
    input.sessionId,
    input.tokenUsageModels
  );
  for (const row of usageRows) {
    const observedAt = row.created_at ?? input.tokenUsageObservedAt;
    const costInput = {
      model: row.model,
      inputTokens: tokenCountValue(row.input_tokens, "pricing.input"),
      outputTokens: tokenCountValue(row.output_tokens, "pricing.output"),
      cacheReadTokens: tokenCountValue(
        row.cache_read_tokens,
        "pricing.cache_read"
      ),
      cacheWriteTokens: tokenCountValue(
        row.cache_write_tokens,
        "pricing.cache_write"
      ),
      observedAt,
    };
    const estimate = estimateTokenCost(costInput);
    if (!estimate) {
      reportTokenCostPricingMiss(
        costInput,
        "imported_token_costs",
        input.sessionId
      );
    }
    await updateTokenUsageCost(
      tx,
      input.sessionId,
      row.model,
      estimate,
      observedAt
    );
  }

  for (const event of input.tokenEvents) {
    const observedAt = event.timestamp || input.tokenEventObservedAtFallback;
    const costInput = {
      model: event.model,
      inputTokens: event.input,
      outputTokens: event.output,
      cacheReadTokens: event.cacheRead,
      cacheWriteTokens: event.cacheWrite,
      observedAt,
    };
    const estimate = estimateTokenCost(costInput);
    if (!estimate) {
      reportTokenCostPricingMiss(
        costInput,
        "imported_token_costs",
        input.sessionId
      );
    }
    await updateTokenEventCost(
      tx,
      input.sessionId,
      event,
      estimate,
      observedAt
    );
  }

  await updateSessionCostRollup(tx, input.sessionId);
}

async function selectTokenUsagePricingRows(
  tx: Prisma.TransactionClient,
  sessionId: string,
  models?: string[]
): Promise<TokenUsagePricingRow[]> {
  const uniqueModels =
    models === undefined
      ? null
      : [...new Set(models.filter((model) => model.length > 0))].sort();
  if (uniqueModels?.length === 0) {
    return [];
  }
  const modelFilter =
    uniqueModels === null
      ? ""
      : ` AND model IN (${uniqueModels.map((_, index) => `$${index + 2}`).join(", ")})`;
  return tx.$queryRawUnsafe<TokenUsagePricingRow[]>(
    // FEA-2879: price the EFFECTIVE total (post-compaction current_* plus the
    // pre-compaction totals rolled into baseline_* by upsertTokenUsage). A
    // transcript compaction shrinks the re-derived current_* counts; pricing
    // current-only would silently undercount already-incurred spend. This is
    // the reader half of the write's `effective_total = baseline + current`
    // contract (see read-stores.ts). The aliases keep the row shape unchanged.
    `SELECT
       model,
       input_tokens + baseline_input AS input_tokens,
       output_tokens + baseline_output AS output_tokens,
       cache_read_tokens + baseline_cache_read AS cache_read_tokens,
       cache_write_tokens + baseline_cache_write AS cache_write_tokens,
       created_at
     FROM token_usage
     WHERE session_id = $1${modelFilter}
     ORDER BY model ASC`,
    ...(uniqueModels === null ? [sessionId] : [sessionId, ...uniqueModels])
  );
}

async function updateTokenUsageCost(
  tx: Prisma.TransactionClient,
  sessionId: string,
  model: string,
  estimate: EstimateTokenCostResult | undefined,
  observedAt: string
): Promise<void> {
  await tx.$executeRawUnsafe(
    `UPDATE token_usage SET
       cost_usd_estimated = $1,
       cost_currency = $2,
       cost_source = $3,
       cost_observed_at = $4
     WHERE session_id = $5 AND model = $6`,
    estimate?.costUsd ?? null,
    estimate ? ModelPricingCurrency.Usd : null,
    estimate ? ModelPricingSource.GenaiPricesV1 : null,
    estimate ? observedAt : null,
    sessionId,
    model
  );
}

async function updateTokenEventCost(
  tx: Prisma.TransactionClient,
  sessionId: string,
  event: TokenEventRecord,
  estimate: EstimateTokenCostResult | undefined,
  observedAt: string
): Promise<void> {
  // token_events is @@ignore'd (no PK → no generated delegate), so this stays
  // raw on the prisma tx client.
  await tx.$executeRawUnsafe(
    `UPDATE token_events SET
       cost_usd_estimated = $1,
       input_cost_usd_estimated = $2,
       output_cost_usd_estimated = $3,
       cache_read_cost_usd_estimated = $4,
       cache_creation_cost_usd_estimated = $5,
       cost_currency = $6,
       cost_source = $7,
       cost_observed_at = $8
     WHERE session_id = $9
       AND model = $10
       AND created_at = $11
       AND input_tokens = $12
       AND output_tokens = $13
       AND cache_read_tokens = $14
       AND cache_write_tokens = $15`,
    estimate?.costUsd ?? null,
    estimate?.inputCostUsd ?? null,
    estimate?.outputCostUsd ?? null,
    estimate?.cacheReadCostUsd ?? null,
    estimate?.cacheWriteCostUsd ?? null,
    estimate ? ModelPricingCurrency.Usd : null,
    estimate ? ModelPricingSource.GenaiPricesV1 : null,
    estimate ? observedAt : null,
    sessionId,
    event.model,
    event.timestamp,
    event.input,
    event.output,
    event.cacheRead,
    event.cacheWrite
  );
}

async function updateSessionCostRollup(
  tx: Prisma.TransactionClient,
  sessionId: string
): Promise<void> {
  const rows = await tx.$queryRawUnsafe<
    {
      cost_usd: number | null;
      priced_rows: number;
      cost_source: string | null;
    }[]
  >(
    `SELECT
       COALESCE(SUM(cost_usd_estimated), 0) AS cost_usd,
       COUNT(cost_usd_estimated) AS priced_rows,
       CASE
         WHEN SUM(CASE WHEN cost_source = $2 THEN 1 ELSE 0 END) > 0 THEN $2
         WHEN SUM(CASE WHEN cost_source = $3 THEN 1 ELSE 0 END) > 0 THEN $3
         ELSE NULL
       END AS cost_source
     FROM token_usage
     WHERE session_id = $1`,
    sessionId,
    ModelPricingSource.GenaiPricesV1,
    ModelPricingSource.PricingTableV1
  );
  const costUsd = Number(rows[0]?.cost_usd ?? 0);
  const pricedRows = Number(rows[0]?.priced_rows ?? 0);
  const costSource = rows[0]?.cost_source ?? null;
  await tx.$executeRawUnsafe(
    `UPDATE sessions SET
       cost_usd_estimated = $1,
       cost_currency = $2,
       cost_source = $3
     WHERE id = $4`,
    pricedRows > 0 ? costUsd : null,
    pricedRows > 0 ? ModelPricingCurrency.Usd : null,
    pricedRows > 0 ? costSource : null,
    sessionId
  );
}

/**
 * FEA-1459 Fix C: Replace token_events for a session via delete+reinsert.
 * Both the live-hook path and the boot-import path derive the FULL record set
 * from the whole transcript on every call, so delete+reinsert is correct and
 * inherently idempotent. This replaces the old high-water mark approach which
 * permanently dropped subagent token records discovered later with
 * interleaved-earlier timestamps.
 */
type TokenEventRecord = {
  timestamp: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

// token_events is @@ignore'd (no PK → no generated delegate), so this whole
// family stays raw on the prisma tx client.
async function insertTokenEvent(
  tx: Prisma.TransactionClient,
  sessionId: string,
  rec: TokenEventRecord
): Promise<void> {
  const storageCounts = normalizeTokenEventRecord(rec, "token_events");
  await tx.$executeRawUnsafe(
    `INSERT INTO token_events (session_id, model, created_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    sessionId,
    rec.model,
    rec.timestamp,
    storageCounts.input,
    storageCounts.output,
    storageCounts.cacheRead,
    storageCounts.cacheWrite
  );
}

/** Boot path: full re-derivation from the entire transcript (including merged
 * subagents, which can carry timestamps EARLIER than existing rows), so
 * delete+reinsert is the correct idempotent operation. */
async function replaceTokenEvents(
  tx: Prisma.TransactionClient,
  sessionId: string,
  records: TokenEventRecord[]
): Promise<void> {
  await tx.$executeRawUnsafe(
    "DELETE FROM token_events WHERE session_id = $1",
    sessionId
  );
  await insertTokenEventsBatched(tx, sessionId, records);
}

/**
 * perf: write token_events rows in chunked multi-row INSERTs instead of one
 * INSERT per record. Same columns, same normalization, same skip-on-missing-
 * timestamp behavior as {@link insertTokenEvent}; just fewer round-trips. Each
 * row binds 7 params; rows-per-chunk stays under EVENT_INSERT_PARAM_CAP.
 */
async function insertTokenEventsBatched(
  tx: Prisma.TransactionClient,
  sessionId: string,
  records: TokenEventRecord[]
): Promise<void> {
  const rows: unknown[][] = [];
  for (const rec of records) {
    if (!rec.timestamp) {
      continue;
    }
    const storageCounts = normalizeTokenEventRecord(rec, "token_events");
    rows.push([
      sessionId,
      rec.model,
      rec.timestamp,
      storageCounts.input,
      storageCounts.output,
      storageCounts.cacheRead,
      storageCounts.cacheWrite,
    ]);
  }
  // 7 columns per row; chunk so the bound-param count stays under the cap.
  for (const chunk of chunkRowsByParamCap(rows, 7)) {
    const { tuples, params } = buildValuesTuples(chunk);
    await tx.$executeRawUnsafe(
      `INSERT INTO token_events (session_id, model, created_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
     VALUES ${tuples.join(", ")}`,
      ...params
    );
  }
}

/** Live-hook path: the transcript only appends, so insert only records newer
 * than the session's high-water mark (created_at is TEXT ISO — lexicographic
 * compare, same convention as the events HWM). Cost per hook event is one
 * SELECT plus inserts for the new turn(s) instead of a full table rewrite. */
async function appendTokenEvents(
  tx: Prisma.TransactionClient,
  sessionId: string,
  records: TokenEventRecord[]
): Promise<TokenEventRecord[]> {
  const hwmResult = await tx.$queryRawUnsafe<{ hwm: string | null }[]>(
    "SELECT MAX(created_at) AS hwm FROM token_events WHERE session_id = $1",
    sessionId
  );
  const hwm = hwmResult[0]?.hwm ?? null;
  const insertedRecords: TokenEventRecord[] = [];
  for (const rec of records) {
    if (!rec.timestamp || (hwm != null && rec.timestamp <= hwm)) {
      continue;
    }
    await insertTokenEvent(tx, sessionId, rec);
    insertedRecords.push(rec);
  }
  return insertedRecords;
}

export async function deleteClaudeCodeOtelSessionRows(
  tx: Prisma.TransactionClient,
  sessionId: string
): Promise<void> {
  await tx.claudeCodeCostEvent.deleteMany({ where: { sessionId } });
  await tx.claudeCodePermissionEvent.deleteMany({ where: { sessionId } });
  await tx.claudeCodeApiRequest.deleteMany({ where: { sessionId } });
}

function normalizeTokenEventRecord(
  rec: TokenEventRecord,
  context: string
): TokenUsageCounts {
  return {
    input: tokenCountValue(rec.input, `${context}.input_tokens`),
    output: tokenCountValue(rec.output, `${context}.output_tokens`),
    cacheRead: tokenCountValue(rec.cacheRead, `${context}.cache_read_tokens`),
    cacheWrite: tokenCountValue(
      rec.cacheWrite,
      `${context}.cache_write_tokens`
    ),
  };
}
