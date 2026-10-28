/**
 * @file claude-code-telemetry-measures.ts
 * @description ISS-11322 — the three `claude_code_*` families whose signal is a
 * VALUE rather than a row count, loaded at the grain that value actually has.
 *
 * ISS-10717 carried eight families as counts and cut six. Three of the six were
 * drop-in counts and joined the rollup unchanged. These are the other three, and
 * the reason they were cut is that a count of them is a DIFFERENT NUMBER wearing
 * the same name. Each is loaded here as its measurement:
 *
 * - `active_time` → summed `seconds`, keyed by `activity_type`. The harness
 *   separates user seconds from CLI seconds, so one blended total would describe
 *   neither.
 * - `lines_of_code` → summed `line_count`, keyed by `(model, change_type)`.
 *   Lines added by one model and lines removed by another are not addends of any
 *   quantity a reader asks for, so a single scalar would be the sum of two
 *   opposite-signed magnitudes reported as one positive number.
 * - `session_identity` → its dimensions. `@id` on `session_id` means the count is
 *   0 or 1 and says only whether the harness stamped an identity at all.
 *
 * ── A SHORTENED BREAKDOWN PUBLISHES ITS OWN SHORTFALL ───────────────────────
 * Both breakdowns are bounded, and both request ONE ROW OVER the cap so the
 * caller can tell a full page from a truncated one without a second count — the
 * same shape, and the same reason, as the component breakdown. A slice that hit
 * the cap is returned WITH `truncated`, never as the whole set: the ingest
 * replaces the set it is given, so a partial list presented as complete would
 * delete the tail the producer could not send.
 *
 * TWO THINGS SET THAT FLAG, not one. The cap is the expected reason; a row whose
 * summed value the column cannot represent is dropped rather than clamped, and
 * that is a shortfall too. A reader cannot act on the difference between the two
 * reasons, and the consequence is identical either way — so both set the flag, and
 * the list that leaves here is never presented as whole when anything was left
 * out of it.
 *
 * ── AN EMPTY ARRAY IS A MEASUREMENT, AN OMITTED ONE IS NOT ──────────────────
 * These loaders return the rows they found and say nothing about whether the
 * family is recorded on this machine. That decision belongs to the ONE place it
 * is made for every family — the caller's `families` probe — so a `[]` from here
 * reaches the wire only when the family IS recorded and this session genuinely
 * produced none.
 */

import type {
  DesktopClaudeCodeActiveTimeTelemetryInput,
  DesktopClaudeCodeLinesOfCodeTelemetryInput,
  DesktopClaudeCodeSessionIdentityTelemetryInput,
} from "@repo/api/src/types/desktop-claude-code-telemetry-sync";
import {
  DESKTOP_CLAUDE_CODE_TELEMETRY_MAX_ACTIVE_TIME_ROWS,
  DESKTOP_CLAUDE_CODE_TELEMETRY_MAX_LINES_OF_CODE_ROWS,
} from "@repo/api/src/types/desktop-claude-code-telemetry-sync";
import type { DesktopPrismaReadClient } from "../database/prisma-client.js";
import { secondsDecimalText } from "./claude-code-telemetry-decimal.js";

/** A bounded breakdown, WITH whether the bound cut it. */
export type ClaudeCodeMeasureBreakdown<TRow> = {
  rows: TRow[];
  truncated: boolean;
};

/**
 * Summed seconds per activity type.
 *
 * Ordered by SECONDS first so the activity types that survive the cap are the
 * ones a reader asks about, with the type name as the tiebreak — which is what
 * makes the page stable across ticks rather than a set that silently reshuffles.
 */
export async function loadSessionActiveTime(
  client: DesktopPrismaReadClient,
  sessionId: string
): Promise<
  ClaudeCodeMeasureBreakdown<DesktopClaudeCodeActiveTimeTelemetryInput>
> {
  const grouped = await client.claudeCodeActiveTime.groupBy({
    by: ["activityType"],
    where: { sessionId },
    _sum: { seconds: true },
    orderBy: [{ _sum: { seconds: "desc" } }, { activityType: "asc" }],
    take: DESKTOP_CLAUDE_CODE_TELEMETRY_MAX_ACTIVE_TIME_ROWS + 1,
  });
  let truncated =
    grouped.length > DESKTOP_CLAUDE_CODE_TELEMETRY_MAX_ACTIVE_TIME_ROWS;
  const rows: DesktopClaudeCodeActiveTimeTelemetryInput[] = [];
  for (const row of grouped.slice(
    0,
    DESKTOP_CLAUDE_CODE_TELEMETRY_MAX_ACTIVE_TIME_ROWS
  )) {
    const seconds = secondsDecimalText(row._sum.seconds);
    if (seconds === undefined) {
      // A total the column cannot represent is DROPPED rather than clamped, for
      // the reason stated on the decimal helper: there is no "unknown seconds"
      // shape on the wire, and every number it could be sent as is a lie about a
      // duration. But a drop is still a SHORTFALL, so it sets the same flag the
      // cap does — the list that leaves here is not the whole set either way, and
      // a reader cannot act on which reason shortened it. Without this the ingest
      // would delete the stored row for that activity type and the read would
      // present the remainder as complete.
      truncated = true;
      continue;
    }
    rows.push({ activityType: row.activityType, seconds });
  }
  return { rows, truncated };
}

/**
 * Summed line count per `(model, change_type)`.
 *
 * `line_count` is a `BigInt`, summed in SQLite and carried as a decimal STRING:
 * a long-lived machine can exceed the safe-integer range, and parsing it into a
 * JS number would silently round the figure.
 */
export async function loadSessionLinesOfCode(
  client: DesktopPrismaReadClient,
  sessionId: string
): Promise<
  ClaudeCodeMeasureBreakdown<DesktopClaudeCodeLinesOfCodeTelemetryInput>
> {
  const grouped = await client.claudeCodeLinesOfCode.groupBy({
    by: ["model", "changeType"],
    where: { sessionId },
    _sum: { lineCount: true },
    orderBy: [{ model: "asc" }, { changeType: "asc" }],
    take: DESKTOP_CLAUDE_CODE_TELEMETRY_MAX_LINES_OF_CODE_ROWS + 1,
  });
  let truncated =
    grouped.length > DESKTOP_CLAUDE_CODE_TELEMETRY_MAX_LINES_OF_CODE_ROWS;
  const rows: DesktopClaudeCodeLinesOfCodeTelemetryInput[] = [];
  for (const row of grouped.slice(
    0,
    DESKTOP_CLAUDE_CODE_TELEMETRY_MAX_LINES_OF_CODE_ROWS
  )) {
    const lineCount = nonNegativeBigIntText(row._sum.lineCount);
    if (lineCount === undefined) {
      // A dropped row is a shortfall, exactly as in `loadSessionActiveTime`.
      truncated = true;
      continue;
    }
    rows.push({
      model: row.model,
      changeType: row.changeType,
      lineCount,
    });
  }
  return { rows, truncated };
}

/**
 * The session's identity dimensions, or `undefined` when the harness stamped no
 * identity row for it.
 *
 * Every field is omitted when its column is NULL, so an identity row whose every
 * dimension is null reaches the wire as `{}` — present, and measurably empty —
 * while a session with no row at all is absent. Those are different claims.
 *
 * The two user-account columns are NOT selected. See the note on
 * `desktopClaudeCodeSessionIdentityTelemetrySchema`: they identify a person
 * rather than describe the run, and carrying them across this boundary is a
 * decision for a human.
 */
export async function loadSessionIdentity(
  client: DesktopPrismaReadClient,
  sessionId: string
): Promise<DesktopClaudeCodeSessionIdentityTelemetryInput | undefined> {
  const row = await client.claudeCodeSessionIdentity.findUnique({
    where: { sessionId },
    select: {
      organizationId: true,
      identitySource: true,
      terminalType: true,
      appVersion: true,
      appEntrypoint: true,
    },
  });
  if (!row) {
    return undefined;
  }
  return {
    organizationId: row.organizationId ?? undefined,
    identitySource: row.identitySource ?? undefined,
    terminalType: row.terminalType ?? undefined,
    appVersion: row.appVersion ?? undefined,
    appEntrypoint: row.appEntrypoint ?? undefined,
  };
}

/**
 * A summed `BigInt` as the wire's decimal string, or omitted.
 *
 * A NEGATIVE sum is refused rather than sent: `line_count` is a magnitude, the
 * cloud column is unsigned in meaning, and the wire schema's `/^\d+$/` would
 * reject the string anyway — as a 400 the lane would keep re-earning. Refusing it
 * here omits one row instead of failing the session's whole delivery.
 */
function nonNegativeBigIntText(value: bigint | null): string | undefined {
  if (value === null || value < 0n) {
    return undefined;
  }
  return value.toString();
}
