/**
 * @file claude-code-telemetry-sync-store.ts
 * @description ISS-10717 — the SQLite half of the Claude Code telemetry lane:
 * candidate selection, rollup construction, and the delivered watermark.
 *
 * Reads go through the READER pool (`prisma.read`) and writes through the single
 * writer (`prisma.write`), matching `invocation-sync-outbox-parts.ts`: the
 * selection probe runs every tick and must never queue behind the writer.
 */

import type { DesktopClaudeCodeDropCounterInput } from "@repo/api/src/types/desktop-claude-code-telemetry-sync";
import type {
  ClaudeCodeTelemetryPendingSession,
  ClaudeCodeTelemetrySyncStore,
} from "../agent-sync/claude-code-telemetry-sync-service.js";
import { effectiveDataRevision } from "../collectors/engine/effective-data-revision.js";
import { loadClaudeCodeTelemetryCandidates } from "../otel/claude-code-telemetry-candidates.js";
import type { ClaudeCodeDropCounterSnapshot } from "../otel/claude-code-telemetry-rollup.js";
import {
  buildClaudeCodeSessionRollup,
  loadClaudeCodeDropCounters,
  loadSignalFamiliesRecorded,
} from "../otel/claude-code-telemetry-rollup.js";
import { yieldDbHostLoop } from "./db-host/yield-db-host-loop.js";
import type { DesktopPrisma } from "./prisma-client.js";

/**
 * The harness recorded for a session that has none.
 *
 * `sessions.harness` is nullable, and a NULL is genuinely unknown rather than
 * "claude". It is carried through as `"unknown"` so the cloud read answers
 * NotRecorded for it instead of claiming a harness the machine never recorded.
 */
const UNKNOWN_HARNESS = "unknown";

/**
 * The lane's methods as the shared db-host sync source exposes them, bound to
 * one `prisma`. A factory spread into `createSqliteSessionSyncSource` rather
 * than four inline delegates there — the same shape and reason as
 * `createInvocationSyncSourceDelegates`.
 */
export function createClaudeCodeTelemetrySyncDelegates(
  prisma: Pick<DesktopPrisma, "read" | "write">,
  now: () => string = () => new Date().toISOString()
) {
  const store = createClaudeCodeTelemetrySyncStore(prisma, now);
  return {
    loadClaudeCodeTelemetryPendingSessions: (
      sourceKey: string,
      limit: number
    ) => store.loadPendingSessions(sourceKey, limit),
    loadClaudeCodeTelemetryDropCounters: () => store.loadDropCounters(),
    markClaudeCodeTelemetryDropCountersDelivered: (
      counters: readonly DesktopClaudeCodeDropCounterInput[]
    ) => store.markDropCountersDelivered(counters),
    recordClaudeCodeTelemetryDelivered: (
      sourceKey: string,
      sessionId: string,
      observedTo: string
    ) => store.recordDelivered(sourceKey, sessionId, observedTo),
    recordClaudeCodeTelemetryRejection: (
      sourceKey: string,
      sessionId: string
    ) => store.recordRejection(sourceKey, sessionId),
    recordClaudeCodeTelemetrySessionAbsent: (
      sourceKey: string,
      sessionId: string
    ) => store.recordSessionAbsent(sourceKey, sessionId),
    recordClaudeCodeTelemetryAbandoned: (
      sourceKey: string,
      sessionId: string,
      observedTo: string,
      reason: string
    ) => store.recordAbandoned(sourceKey, sessionId, observedTo, reason),
  };
}

export function createClaudeCodeTelemetrySyncStore(
  prisma: Pick<DesktopPrisma, "read" | "write">,
  now: () => string = () => new Date().toISOString()
): ClaudeCodeTelemetrySyncStore {
  return {
    async loadPendingSessions(
      sourceKey: string,
      limit: number
    ): Promise<ClaudeCodeTelemetryPendingSession[]> {
      return await prisma.read(async (client) => {
        // FEA-2264: the candidate union groups over all fourteen `claude_code_*`
        // signal tables (ISS-11322) and this lane runs it every tick, forever,
        // including once the corpus has drained. ISS-11323's per-session floor
        // made the steady-state pass cheap, not free, so yielding around it is
        // still what keeps a Sessions list read posted mid-sweep from waiting out
        // the whole selection.
        await yieldDbHostLoop();
        const candidates = await loadClaudeCodeTelemetryCandidates(
          client,
          sourceKey,
          limit
        );
        await yieldDbHostLoop();
        if (candidates.length === 0) {
          return [];
        }
        const families = await loadSignalFamiliesRecorded(client);
        const sessions = await client.session.findMany({
          where: { id: { in: candidates.map((c) => c.sessionId) } },
          select: { id: true, harness: true },
        });
        const harnessById = new Map(
          sessions.map((row) => [row.id, row.harness ?? UNKNOWN_HARNESS])
        );
        const pending: ClaudeCodeTelemetryPendingSession[] = [];
        for (const candidate of candidates) {
          // One rollup is several aggregates plus a groupBy; the page is small
          // but each unit is not, so the boundary goes BETWEEN them.
          await yieldDbHostLoop();
          const rollup = await buildClaudeCodeSessionRollup(client, {
            sessionId: candidate.sessionId,
            harness: harnessById.get(candidate.sessionId) ?? UNKNOWN_HARNESS,
            families,
          });
          if (!rollup) {
            continue;
          }
          pending.push({
            sessionId: candidate.sessionId,
            session: rollup.session,
            // The candidate query's watermark, not the rollup's own cost-event
            // window: a session whose only new rows are error events has a
            // newer candidate watermark than cost window, and persisting the
            // narrower one would leave it owed forever.
            observedTo: candidate.latestObservedAt,
          });
        }
        return pending;
      });
    },

    async loadDropCounters(): Promise<ClaudeCodeDropCounterSnapshot> {
      return await prisma.read((client) => loadClaudeCodeDropCounters(client));
    },

    /**
     * Advance each counter's delivery watermark to the value that was actually
     * SENT, never to whatever `dropped_count` reads now.
     *
     * A drop recorded between the load and the ack must stay owed; writing the
     * current total here would mark it delivered on the strength of an ack that
     * never carried it, which is the same class of lie as advancing a session
     * watermark on send (invariant 1).
     */
    async markDropCountersDelivered(counters) {
      if (counters.length === 0) {
        return;
      }
      await prisma.write(async (client) => {
        for (const counter of counters) {
          await client.claudeCodeSignalDrop.updateMany({
            where: { harness: counter.harness, reason: counter.reason },
            data: { syncedCount: BigInt(counter.droppedCount) },
          });
        }
      });
    },

    async recordDelivered(sourceKey, sessionId, observedTo) {
      const updatedAt = now();
      await prisma.write((client) =>
        client.claudeCodeTelemetrySyncCursor.upsert({
          where: { sourceKey_sessionId: { sourceKey, sessionId } },
          create: {
            sourceKey,
            sessionId,
            syncedObservedTo: observedTo,
            dataRevision: effectiveDataRevision(),
            updatedAt,
          },
          // A successful delivery clears the rejection state: the payload the
          // cloud just accepted is evidence the earlier refusals no longer
          // describe this session.
          update: {
            syncedObservedTo: observedTo,
            rejectedAttempts: 0,
            deferredAttempts: 0,
            lastError: null,
            dataRevision: effectiveDataRevision(),
            updatedAt,
          },
        })
      );
    },

    async recordSessionAbsent(sourceKey, sessionId) {
      const updatedAt = now();
      const row = await prisma.write((client) =>
        client.claudeCodeTelemetrySyncCursor.upsert({
          where: { sourceKey_sessionId: { sourceKey, sessionId } },
          // `""` sorts below every ISO instant, so the session stays owed: a
          // deferral is not a delivery and must not move the watermark.
          create: {
            sourceKey,
            sessionId,
            syncedObservedTo: "",
            deferredAttempts: 1,
            dataRevision: effectiveDataRevision(),
            updatedAt,
          },
          update: { deferredAttempts: { increment: 1 }, updatedAt },
          select: { deferredAttempts: true },
        })
      );
      return row.deferredAttempts;
    },

    async recordRejection(sourceKey, sessionId) {
      const updatedAt = now();
      const row = await prisma.write((client) =>
        client.claudeCodeTelemetrySyncCursor.upsert({
          where: { sourceKey_sessionId: { sourceKey, sessionId } },
          // A first rejection has no cursor row yet. `""` sorts below every
          // ISO instant, so the session stays owed — the watermark must not
          // move on a failure.
          create: {
            sourceKey,
            sessionId,
            syncedObservedTo: "",
            rejectedAttempts: 1,
            dataRevision: effectiveDataRevision(),
            updatedAt,
          },
          update: { rejectedAttempts: { increment: 1 }, updatedAt },
          select: { rejectedAttempts: true },
        })
      );
      return row.rejectedAttempts;
    },

    async recordAbandoned(sourceKey, sessionId, observedTo, reason) {
      const updatedAt = now();
      await prisma.write((client) =>
        client.claudeCodeTelemetrySyncCursor.upsert({
          where: { sourceKey_sessionId: { sourceKey, sessionId } },
          create: {
            sourceKey,
            sessionId,
            syncedObservedTo: observedTo,
            lastError: reason,
            dataRevision: effectiveDataRevision(),
            updatedAt,
          },
          update: {
            syncedObservedTo: observedTo,
            lastError: reason,
            // Reset, not left at the ceiling. The watermark advance takes this
            // session out of the owed set, but a live session keeps producing
            // OTel rows and will be re-selected with a DIFFERENT payload — and
            // a counter left at the ceiling would abandon that one on its FIRST
            // rejection instead of its third, permanently.
            rejectedAttempts: 0,
            deferredAttempts: 0,
            dataRevision: effectiveDataRevision(),
            updatedAt,
          },
        })
      );
    },
  };
}
