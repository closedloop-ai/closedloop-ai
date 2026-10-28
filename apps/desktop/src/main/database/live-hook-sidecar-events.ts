import type {
  SubagentScanResult,
  SubagentToolUseRecord,
} from "../collectors/parsing/subagent-scanner.js";
import { safeJsonParse } from "./db-helpers.js";
import { deterministicEventId } from "./deterministic-event-id.js";
import type { Prisma } from "./generated/client.js";
import { importToolPayloadWithinCap } from "./import-metadata-builders.js";

/**
 * Make one sidecar rescan authoritative for its deterministic tool events.
 * Later completion evidence replaces the partial row, while a later identity
 * conflict removes the row that the now-contradictory evidence had produced.
 */
export async function reconcileLiveHookSidecarEvents(
  tx: Prisma.TransactionClient,
  input: {
    sessionId: string;
    agentId: string;
    scan: SubagentScanResult;
  }
): Promise<{ unplaceableToolUses: number }> {
  const conflictedToolUseIds = new Set(input.scan.conflictedToolUseIds);
  if (conflictedToolUseIds.size > 0) {
    const storedEvents = await tx.event.findMany({
      where: {
        sessionId: input.sessionId,
        agentId: input.agentId,
        eventType: "PostToolUse",
      },
      select: { id: true, data: true },
    });
    const conflictingEventIds = storedEvents.flatMap((event) => {
      const data = event.data ? safeJsonParse(event.data) : null;
      const toolUseId = data?.tool_use_id;
      return typeof toolUseId === "string" &&
        conflictedToolUseIds.has(toolUseId)
        ? [event.id]
        : [];
    });
    if (conflictingEventIds.length > 0) {
      await tx.event.deleteMany({ where: { id: { in: conflictingEventIds } } });
    }
  }

  let unplaceableToolUses = 0;
  for (const toolUse of input.scan.toolUses) {
    if (toolUse.toolName && !toolUse.timestamp) {
      unplaceableToolUses += 1;
    }
    if (!(toolUse.toolName && toolUse.timestamp)) {
      continue;
    }
    const data = sidecarToolEventData(toolUse);
    const eventId = deterministicEventId(
      input.sessionId,
      "PostToolUse",
      toolUse.timestamp,
      toolUse.toolName,
      toolUse.toolUseId
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO events
         (id, session_id, agent_id, event_type, tool_name, summary, data, created_at)
       VALUES ($1, $2, $3, 'PostToolUse', $4, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         agent_id = excluded.agent_id,
         event_type = excluded.event_type,
         tool_name = excluded.tool_name,
         summary = excluded.summary,
         data = excluded.data,
         created_at = excluded.created_at`,
      eventId,
      input.sessionId,
      input.agentId,
      toolUse.toolName,
      data,
      toolUse.timestamp
    );
  }
  return { unplaceableToolUses };
}

function parseScannedToolValue(value: string | null): unknown | undefined {
  if (value === null) {
    return undefined;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * ISS-6480: the scanner carries `input` raw, so it needs no re-parse. This lane
 * had the same defect as the boot importer — an over-bound input threw in
 * `JSON.parse` and was persisted as nothing. `null` is the scanner's absent
 * sentinel; `output` keeps its bounded-JSON form and still parses.
 */
function scannedToolInput(value: unknown): unknown {
  return value === null ? undefined : value;
}

/**
 * ISS-6480: serialize one sidecar tool event within `MAX_EVENT_DATA_BYTES` the
 * same way the boot importer does, keeping the small identity keys and dropping
 * only the heavy `tool_input`/`tool_response` detail when the row will not fit.
 *
 * This lane used bare `importEventData`, which replaces the WHOLE blob with the
 * `{truncated}` sentinel past the cap. That was survivable only while the scanner
 * bounded each input to 1000 characters; carrying the raw input made an oversized
 * row reachable, and a nuked row loses `tool_use_id` — which the conflict cleanup
 * at the top of this file matches on, and which anchors `storedProviderToolUseId`.
 * Preserving it is what this buys.
 *
 * Three limits, stated because the obvious readings are wrong:
 *
 *  • The overwrite is NOT removed. The insert still upserts `data`
 *    unconditionally, so an over-cap rescan strips detail from a row that had
 *    it. That is a downgrade from a total nuke, not an elimination. The writer
 *    it can clobber is the boot/parser import lane in `write-core.ts`, which
 *    mints the SAME deterministic id off the transcript timestamp and inserts
 *    with DO NOTHING. `live-hook.ts` is not that peer — it mints from the wall
 *    clock, so its ids do not collide with these.
 *  • Base preservation is conditional. If `base` alone exceeded the cap it would
 *    still nuke; unreachable in practice, since only `tool_name` is unbounded.
 *  • This lane's ONLY skill signal is `tool_input.skill`, which is exactly what
 *    the cap drops. Unlike the import lane, whose base carries `skillName`,
 *    `kind`, and `mcpServer`, an over-cap row here still loses its component
 *    classification. The two lanes do not degrade identically.
 */
export function sidecarToolEventData(
  toolUse: Pick<
    SubagentToolUseRecord,
    | "toolName"
    | "toolUseId"
    | "input"
    | "output"
    | "resultTimestamp"
    | "isError"
  >
): string | null {
  const toolInput = scannedToolInput(toolUse.input);
  const toolOutput = parseScannedToolValue(toolUse.output);
  const base: Record<string, unknown> = {
    tool_name: toolUse.toolName,
    ...(toolUse.toolUseId === null ? {} : { tool_use_id: toolUse.toolUseId }),
    ...(toolUse.resultTimestamp === null
      ? {}
      : { resultTimestamp: toolUse.resultTimestamp }),
    ...(toolUse.isError === null ? {} : { isError: toolUse.isError }),
  };
  const detail: Record<string, unknown> = {
    ...(toolInput === undefined ? {} : { tool_input: toolInput }),
    ...(toolOutput === undefined ? {} : { tool_response: toolOutput }),
  };
  return importToolPayloadWithinCap(base, detail);
}
