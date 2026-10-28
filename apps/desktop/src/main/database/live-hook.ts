/**
 * @file live-hook.ts
 * @description The Claude live-hook lifecycle, extracted from write-core.ts
 * (ISS-4825). Everything that mutates the local store in response to a live
 * Closedloop hook event: the lifecycle wrapper (createSqliteLifecycle / its
 * processEvent closure), the per-hook dispatcher (handleHook), and the
 * per-transaction hook primitives it drives (session/agent/event upserts,
 * subagent spawn/match, native-subagent transcript resolution, and the
 * append-only token-event writes). Provider-neutral token-event persistence
 * lives in ./token-event-contract.js. The shared helpers these paths reuse are
 * imported one-directionally: persistImportedTokenCosts from
 * ./token-cost-writes.js (ISS-4936); recomputeSessionLastActivityAt from
 * ./write-core.js; sweepStaleActiveSessions from ./session-maintenance.js
 * (ISS-5182); importEventData from
 * ./import-metadata-builders.js (ISS-4853). The dependency runs one way only
 * (live-hook.ts -> those leaves), never the reverse, so there is no import cycle.
 */

import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import {
  SESSION_STATUS,
  type SessionStatus,
} from "@repo/api/src/types/session-status";
import { effectiveDataRevision } from "../collectors/engine/effective-data-revision.js";
import { isImportableSourcePath } from "../collectors/engine/source-admission.js";
import { coldReadGate } from "../collectors/parsing/cold-read-gate.js";
import { scanSubagentTranscriptStream } from "../collectors/parsing/subagent-scanner.js";
import { InvalidTokenCountError } from "../cost/token-counts.js";
import type {
  HookData,
  HookHarness,
} from "../dashboard/agent-dashboard-db-types.js";
import { reportCollectorRecordsDropped } from "../telemetry/collector-records-dropped-telemetry.js";
import { CollectorRecordsDroppedReason } from "../telemetry/telemetry-protocol.js";
import {
  CLAUDE_NATIVE_SUBAGENT_STEM_PATTERN,
  COMPACTION_RE,
  DESKTOP_AGENT_STATUS,
  TERMINAL_STATUS_SET,
  WAITING_INPUT_RE,
} from "./db-constants.js";
import { safe, safeJsonParse, strOf } from "./db-helpers.js";
import { deterministicEventId } from "./deterministic-event-id.js";
import type { Prisma } from "./generated/client.js";
import { importEventData } from "./import-metadata-builders.js";
import { closeNonTerminalAgents } from "./live-hook-agent-close.js";
import { claudeProjectsRoots, forkSkipFor } from "./live-hook-fork-lineage.js";
import { reconcileLiveHookSidecarEvents } from "./live-hook-sidecar-events.js";
import type { DesktopPrisma } from "./prisma-client.js";
import type { createSqliteTokenUsageStore } from "./read-stores.js";
import {
  DEFAULT_STALE_SESSION_MINUTES,
  type StaleSessionSweepResult,
  sweepStaleActiveSessions,
} from "./session-maintenance.js";
import {
  buildSessionIdentityInsert,
  type SessionIdentityProvider,
} from "./session-owner-identity.js";
import { persistImportedTokenCosts } from "./token-cost-writes.js";
import {
  appendTokenEvents,
  type PersistedTokenEventRecord,
} from "./token-event-contract.js";
import {
  createTranscriptCache,
  type TranscriptExtract,
  type TranscriptForkSkip,
} from "./transcript.js";
import { recomputeSessionLastActivityAt } from "./write-core.js";
import { mainAgentId } from "./write-core-main-agent-spine.js";

const defaultTranscriptExtract = createTranscriptCache();

export function createSqliteLifecycle(
  prisma: DesktopPrisma,
  tokenUsage: ReturnType<typeof createSqliteTokenUsageStore>,
  deps: {
    detectBillingMode: (harness: string, model?: string | null) => string;
    emit?: (sessionId: string) => void;
    /**
     * Best-effort notice fired once, after the write transaction commits, when a
     * live SessionEnd hook transitions a previously non-terminal session to a
     * terminal status. Used by the main process to surface a desktop completion
     * Notification; never fires for backfill/import (those bypass this lifecycle).
     */
    onSessionTerminal?: (notice: { sessionId: string; status: string }) => void;
    extractTranscript?: (
      path: string,
      forkSkip?: TranscriptForkSkip
    ) => TranscriptExtract | null;
    getUserIdentity?: SessionIdentityProvider;
    log: (message: string) => void;
    now: () => string;
    staleMinutes?: number;
  }
) {
  const staleMinutes = deps.staleMinutes ?? DEFAULT_STALE_SESSION_MINUTES;
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
          // stack their peak buffers in the one db-host heap. The fork-lineage
          // scan (ISS-12552) reads sibling transcripts, so it shares the slot,
          // and runs only under the attribution policy (PRD-800).
          transcript = await coldReadGate.run(async () =>
            extract(transcriptPath, await forkSkipFor(transcriptPath, deps.log))
          );
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
      // ISS-5429: the SessionStart stale sweep's counts, reported post-commit.
      // A mutable holder rather than a `let`, so the value the transaction
      // callback writes is still readable as a number afterwards (a
      // closure-assigned `let` narrows to its initializer for the reader).
      const staleSweep = { heldBack: 0 };
      const unplaceable: {
        count: number;
        agentId: string;
        transcriptPath: string;
      }[] = [];
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
              onStaleSweep: (result) => {
                staleSweep.heldBack = result.heldBack;
              },
              onUnplaceableToolUses: (report) => {
                unplaceable.push(report);
              },
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
        // ISS-5429: a held-back row keeps showing as `active` — and, never
        // terminal, stays outside the retention purge — and nothing else in
        // this lane says so. Reported here, after the commit that actually left
        // it behind. Deliberately states the CONDITION rather than promising a
        // repair: the FEA-3743 heal converges the shapes it can re-express as
        // an instant, but a date-prefixed value that parses to nothing is never
        // rewritten, so this can recur indefinitely and that is the signal.
        if (staleSweep.heldBack > 0) {
          deps.log(
            `live sweep: held back ${staleSweep.heldBack} stale session(s) whose stored timestamps are not canonical UTC; they stay active until that text is repaired`
          );
        }
        // ISS-6417: the corrupt-input signal for a stamp no `Date` could
        // represent, in two halves. The LOCAL half is one line per sidecar, not
        // per record — a corrupt file can hold many — and carries the detail
        // only an operator on this machine can act on: which session, which
        // agent row, which file to open.
        let droppedToolUses = 0;
        for (const report of unplaceable) {
          droppedToolUses += report.count;
          deps.log(
            `live subagent scan: dropped ${report.count} tool-use record(s) with an unreadable timestamp; session=${sessionId} agent=${report.agentId} transcript=${report.transcriptPath}`
          );
        }
        // The MONITORED half: a bounded reason and the total, carrying none of
        // the above. One event per hook rather than per sidecar, so a session
        // that fans out to many subagents cannot turn one corrupt harness write
        // into a burst. `reportCollectorRecordsDropped` is a no-op at zero, so
        // this never claims a drop that did not happen.
        //
        // ISS-7109: "monitored" is a claim about a process, not just a call.
        // This module runs in the FEA-2038 DB-host child, where
        // `Observability.init` never ran — so for the life of ISS-6417 the emit
        // below reached a null transport and every one of these events was
        // discarded. It leaves the machine now because the child installs a
        // telemetry relay (`telemetry/telemetry-relay-sink.ts`) that posts each
        // event to main, which emits it on this process's behalf. If that relay
        // is ever removed, this comment becomes a lie again.
        reportCollectorRecordsDropped({
          reason: CollectorRecordsDroppedReason.UnreadableTimestamp,
          count: droppedToolUses,
        });
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
    detectBillingMode: (harness: string, model?: string | null) => string;
    getUserIdentity?: SessionIdentityProvider;
    /**
     * ISS-5429: the `SessionStart` stale sweep's counts, handed back so the
     * caller can report them AFTER the hook transaction commits. Logging a
     * bad-data count from inside the still-open transaction would announce rows
     * a later failing statement then rolls back.
     */
    onStaleSweep: (result: StaleSessionSweepResult) => void;
    /**
     * ISS-6417: same post-commit contract as `onStaleSweep`. A sidecar tool-use
     * record whose stamp no `Date` could represent is read but not insertable —
     * an event needs a time — so it is dropped, and a drop caused by corrupt
     * input is reported rather than silent. Handed back so the caller reports
     * it AFTER the commit that actually left it out.
     */
    onUnplaceableToolUses: (report: {
      count: number;
      agentId: string;
      transcriptPath: string;
    }) => void;
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
      // ISS-5182: the same sweep the boot reaper runs, excluding the session
      // whose SessionStart hook is in flight — it is mid-write and must never be
      // declared terminal by its own hook.
      // ISS-5429: the sweep holds back a row whose timestamps it cannot compare
      // soundly. The counts go to the caller, which logs them AFTER this
      // transaction commits.
      options.onStaleSweep(
        await sweepStaleActiveSessions(tx, {
          excludeSessionId: sessionId,
          now,
          staleMinutes: options.staleMinutes,
        })
      );
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
        // ISS-6902: the session is terminal from here and `sweepStaleActiveSessions`
        // selects only `active` rows, so an agent this hook leaves non-terminal is
        // outside every later sweep — stranded at `working` locally and on the wire.
        // The shared close puts the run's `error` on the main spine (already
        // written, unguarded, by the line above) and `completed` on its subagents.
        await closeNonTerminalAgents(
          tx,
          sessionId,
          DESKTOP_AGENT_STATUS.ERROR,
          now
        );
        await setSessionStatus(tx, sessionId, SESSION_STATUS.ERROR, now, 1);
        await clearAwaitingInput(tx, sessionId, now);
        if (!wasTerminal) {
          terminalNotice = { sessionId, status: SESSION_STATUS.ERROR };
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
          const subagentResult = await scanSubagentTranscriptStream(
            subPath,
            sessionId,
            agentId
          ).catch(() => null);
          if (subagentResult) {
            // ISS-6417: a record the scanner read but could not place in time.
            // The guard below drops it — correctly, an event needs a time — but
            // a drop caused by corrupt input is reported rather than silent.
            // Counted, then reported once per sidecar: a corrupt file can hold
            // many, and one line per record would be unbounded log volume.
            const { unplaceableToolUses } =
              await reconcileLiveHookSidecarEvents(tx, {
                sessionId,
                agentId,
                scan: subagentResult,
              });
            if (unplaceableToolUses > 0) {
              options.onUnplaceableToolUses({
                count: unplaceableToolUses,
                agentId,
                transcriptPath: subPath,
              });
            }
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
      const wasTerminal = TERMINAL_STATUS_SET.has(session.status);
      const hasTrailingError = options.transcript?.hasTrailingApiError === true;
      // ISS-4586: a run that ended without an unrecovered error is INACTIVE (the
      // terminal-not-failed state that supersedes the former COMPLETED), else
      // ERROR. `endsWithError` mirrors that choice for the durable flag.
      const finalStatus =
        session.status === SESSION_STATUS.ERROR ||
        (hasTrailingError && !wasTerminal)
          ? SESSION_STATUS.ERROR
          : SESSION_STATUS.INACTIVE;
      const finalEndsWithError = finalStatus === SESSION_STATUS.ERROR ? 1 : 0;
      if (!wasTerminal) {
        terminalNotice = { sessionId, status: finalStatus };
      }
      // ISS-7658: the run's outcome is the MAIN agent's, and only the main
      // agent's. This arm used to hand `error` to the shared close, which
      // applied it to the session's in-flight subagents too — the exact shape
      // ISS-6902 removed from `Stop(error)`, left in place here.
      await closeNonTerminalAgents(
        tx,
        sessionId,
        finalStatus === SESSION_STATUS.ERROR
          ? DESKTOP_AGENT_STATUS.ERROR
          : DESKTOP_AGENT_STATUS.COMPLETED,
        now
      );
      await setSessionStatus(
        tx,
        sessionId,
        finalStatus,
        now,
        finalEndsWithError
      );
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
    // boot path only — so append records at or past the session's high-water
    // mark instead of delete+reinserting the full set on every hook event. The
    // equal-timestamp allowance lets distinct transport ids coexist while exact
    // replay is a no-op. A
    // 1000-turn session would otherwise pay 1000+ inserts per PostToolUse on
    // the serialized write queue. An empty extract inserts nothing and never
    // wipes rows the boot importer derived.
    let appendedTokenEvents: PersistedTokenEventRecord[] = [];
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
  detectBillingMode: (harness: string, model?: string | null) => string,
  getUserIdentity?: SessionIdentityProvider
): Promise<void> {
  if (await getSession(tx, sessionId)) {
    return;
  }
  // ISS-5445: the hook payload carries the model, so a BYOK harness is
  // classified from it rather than from the harness name.
  const billingMode =
    safe(() => detectBillingMode(harness, data.model ?? null)) ?? "unknown";
  // ISS-6168: identity columns + values come from the shared binding the
  // importer's INSERT also uses, so the two session-insert paths cannot drift.
  const identity = buildSessionIdentityInsert(getUserIdentity, 8);
  await tx.$executeRawUnsafe(
    `INSERT INTO sessions (
       id, name, status, cwd, model, started_at, updated_at, harness,
       billing_mode, data_revision, ${identity.columns}
     )
     VALUES ($1, $2, '${SESSION_STATUS.ACTIVE}', $3, $4, $5, $5, $6, $7, $8, ${identity.placeholders})`,
    sessionId,
    data.session_name ?? null,
    data.cwd ?? null,
    data.model ?? null,
    now,
    harness,
    billingMode,
    effectiveDataRevision(),
    ...identity.values
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

// ISS-4586: both callers declare the session TERMINAL (a live Stop(error) or
// SessionEnd), so each also stamps the durable `ends_with_error` flag (1 for the
// error terminal, 0 for the inactive terminal) — keeping the column consistent
// with the status the live hook path writes, so a later reaper reads the same
// signal the importer would.
async function setSessionStatus(
  tx: Prisma.TransactionClient,
  sessionId: string,
  status: SessionStatus,
  now: string,
  endsWithError: number
): Promise<void> {
  await tx.$executeRawUnsafe(
    "UPDATE sessions SET status = $1, updated_at = $2, ended_at = $2, ends_with_error = $4 WHERE id = $3",
    status,
    now,
    sessionId,
    endsWithError
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
  if (session.status === SESSION_STATUS.ACTIVE || hookType === "SessionEnd") {
    return;
  }
  const isUserActivity =
    hookType === "UserPromptSubmit" || hookType === "PreToolUse";
  const isStopLike = hookType === "Stop" || hookType === "SubagentStop";
  const reactivate =
    isUserActivity ||
    (!isStopLike && session.status !== SESSION_STATUS.ERROR) ||
    // ISS-4586 / ISS-4654: a Stop/SubagentStop reactivates a terminal-not-failed
    // session — `inactive`, the only such state now that migration 0042 has
    // collapsed the legacy spellings. An `error` session is never revived.
    (isStopLike && session.status === SESSION_STATUS.INACTIVE);
  if (reactivate) {
    await tx.$executeRawUnsafe(
      // ISS-4586 (@whitlockk / davetho): reset ends_with_error as the row comes
      // back to life. This hook path has no fresh parse to re-derive from, so a
      // prior terminal flag (e.g. `error`) must not survive to steer a later
      // orphan sweep — an active session that has produced no error since
      // reactivation is not-error (0). A subsequent Stop(error)/SessionEnd
      // re-stamps the flag from the real outcome.
      `UPDATE sessions SET status = '${SESSION_STATUS.ACTIVE}', updated_at = $1, ended_at = NULL, ends_with_error = 0 WHERE id = $2`,
      now,
      session.id
    );
    await promoteMain(tx, mainAgentId(session.id), now);
    session.status = SESSION_STATUS.ACTIVE;
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
  const nativeSubagentId = extractNativeSubagentId(data);
  const candidates = await tx.agent.findMany({
    where: {
      sessionId,
      type: "subagent",
      status: {
        in: [DESKTOP_AGENT_STATUS.WORKING, DESKTOP_AGENT_STATUS.COMPLETED],
      },
    },
    select: {
      id: true,
      metadata: true,
      name: true,
      status: true,
      subagentType: true,
      task: true,
    },
    orderBy: { startedAt: "desc" },
  });
  if (candidates.length === 0) {
    return null;
  }
  if (nativeSubagentId) {
    return (
      candidates.find((candidate) => {
        const metadata = candidate.metadata
          ? safeJsonParse(candidate.metadata)
          : null;
        return metadata?.nativeSubagentId === nativeSubagentId;
      })?.id ?? null
    );
  }
  // ISS-6902: a terminal hook closes a session's still-running subagents at
  // `completed`, so by the time a late `SubagentStop` arrives there may be no
  // `working` row left to match. Identify against the closed rows too — the set
  // the native-id path above has always searched — rather than returning null
  // and dropping both the event's attribution and its sidecar ingest.
  // `working` rows are searched FIRST so a live subagent always outranks a
  // finished namesake, and the blind positional last resort below stays
  // `working`-only: picking an arbitrary CLOSED subagent is a misattribution,
  // not a fallback.
  const working = candidates.filter(
    (candidate) => candidate.status === DESKTOP_AGENT_STATUS.WORKING
  );
  const identified =
    matchSubagentByIdentifier(working, data) ??
    matchSubagentByIdentifier(candidates, data);
  if (identified) {
    return identified;
  }
  return working[0]?.id ?? null;
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
  const roots = claudeProjectsRoots();
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

type SubagentMatchCandidate = {
  id: string;
  name: string | null;
  subagentType: string | null;
  task: string | null;
};

/**
 * The first candidate `data` POSITIVELY identifies — by name prefix, then
 * subagent type, then task.
 *
 * Null means "nothing here matches", never "take the newest": the caller
 * decides whether an unidentified stop may fall back to a positional guess,
 * and that is only ever sound over still-`working` rows.
 */
function matchSubagentByIdentifier(
  candidates: SubagentMatchCandidate[],
  data: HookData
): string | null {
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
  return null;
}
