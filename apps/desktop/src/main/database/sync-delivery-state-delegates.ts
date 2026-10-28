/**
 * @file sync-delivery-state-delegates.ts
 * @description The desktop→cloud DELIVERY-STATE delegate slices, composed once.
 *
 * `sync-source.ts` is about BUILDING sync payloads; what has already been
 * delivered is a separate concern, and each lane already owns its own slice next
 * to its store (FEA-3781). This module is the one place those slices are joined,
 * so a new lane adds a line HERE rather than another import and another spread
 * to a module that is already over the file-size ceiling.
 *
 * Nothing is derived or reinterpreted here: each slice is passed the same seam
 * it was passed before, and the returned object is their union.
 */

import { createAgentSessionOutboxDelegates } from "./agent-session-outbox-delegates.js";
import { createClaudeCodeTelemetrySyncDelegates } from "./claude-code-telemetry-sync-store.js";
import { createInvocationSyncSourceDelegates } from "./invocation-sync-source-delegates.js";
import type { DesktopPrisma } from "./prisma-client.js";
import { createSyncCursorStateDelegates } from "./sync-cursor-state-delegates.js";

export function createSyncDeliveryStateDelegates(
  prisma: DesktopPrisma,
  log: (message: string) => void
) {
  return {
    ...createSyncCursorStateDelegates(prisma),
    ...createAgentSessionOutboxDelegates(prisma),
    ...createInvocationSyncSourceDelegates(prisma, log),
    ...createClaudeCodeTelemetrySyncDelegates(prisma),
  };
}
