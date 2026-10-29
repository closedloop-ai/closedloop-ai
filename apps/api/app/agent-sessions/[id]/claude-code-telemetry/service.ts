import { Harness } from "@repo/api/src/types/agent-component";
import {
  type ClaudeCodeActiveTimeReading,
  type ClaudeCodeComponentReading,
  type ClaudeCodeCostReading,
  ClaudeCodeCostSource,
  ClaudeCodeCostUnit,
  type ClaudeCodeDropCounterReading,
  type ClaudeCodeIdentityReading,
  type ClaudeCodeLinesOfCodeReading,
  type ClaudeCodeSignalReadings,
  ClaudeCodeTelemetryAvailability,
  type ClaudeCodeTelemetryResponse,
  signalReadingOf,
  unrecordedSignal,
} from "@repo/api/src/types/claude-code-telemetry";
import { withDb } from "@repo/database";

/**
 * ISS-10717 — the read side of the synced Claude Code OTel corpus.
 *
 * Two disciplines are applied HERE rather than left to each caller, so two
 * surfaces cannot draw different conclusions from the same rows:
 *
 * 1. **Unknown is not zero.** A `NULL` count column is what the producer's
 *    OMISSION persisted, and it becomes `{ recorded: false, count: null }`. It
 *    never becomes `0`.
 * 2. **Every cost names its ledger.** A session now has up to four costs from
 *    three producers, so no cost leaves here as a bare number.
 */

type ClaudeCodeTelemetryQuery = {
  id: string;
  organizationId: string;
};

/**
 * Whether a harness produces `claude_code_*` signals at all.
 *
 * Only Claude Code does. For a Codex, Cursor, Copilot or OpenCode session the
 * absence is BY HARNESS — nothing failed and nothing is missing — and conflating
 * it with a capture failure is what makes a correct empty state read as a bug.
 *
 * THE ROW IS TESTED FIRST, and that order is load-bearing rather than
 * cosmetic. `session_detail.harness` is nullable at the producer and defaults to
 * `"unknown"` on both sides, so a genuine Claude Code session can carry a label
 * that is not `Harness.Claude` while a rollup for it sits right here. Answering
 * `absent_by_harness` for that session would assert "this harness emits none of
 * these signals, nothing is missing" on the same object whose `signals` and
 * `components` are carrying real synced counts — the response contradicting
 * itself. A present row is measured evidence and outranks a label that may never
 * have been set. The genuine Codex case is unaffected: those sessions never grow
 * a row, so they still fall through to the harness test.
 */
function availabilityOf(
  harness: string,
  hasRow: boolean
): ClaudeCodeTelemetryAvailability {
  if (hasRow) {
    return ClaudeCodeTelemetryAvailability.Recorded;
  }
  if (harness !== Harness.Claude) {
    return ClaudeCodeTelemetryAvailability.AbsentByHarness;
  }
  return ClaudeCodeTelemetryAvailability.NotRecorded;
}

/** Every signal family reported as never recorded. */
function noSignals(): ClaudeCodeSignalReadings {
  return {
    costEvents: unrecordedSignal(),
    apiRequests: unrecordedSignal(),
    errorEvents: unrecordedSignal(),
    permissionEvents: unrecordedSignal(),
    permissionModeChanges: unrecordedSignal(),
    mcpServerConnections: unrecordedSignal(),
    toolResults: unrecordedSignal(),
    llmRequests: unrecordedSignal(),
    authEvents: unrecordedSignal(),
    pluginEvents: unrecordedSignal(),
    sessionStarts: unrecordedSignal(),
  };
}

function costReading(
  source: ClaudeCodeCostSource,
  unit: ClaudeCodeCostUnit,
  value: { toString(): string } | null
): ClaudeCodeCostReading | null {
  return value === null ? null : { source, unit, value: value.toString() };
}

/**
 * Read one session's telemetry, or `null` when the session is not visible to
 * this org.
 *
 * Org scoping is the boundary and it is enforced on the JOIN to `artifacts`, so
 * a session in another org is indistinguishable from one that does not exist.
 */
async function findClaudeCodeTelemetry(
  query: ClaudeCodeTelemetryQuery
): Promise<ClaudeCodeTelemetryResponse | null> {
  return await withDb(async (db) => {
    const session = await db.sessionDetail.findFirst({
      where: {
        artifactId: query.id,
        artifact: { organizationId: query.organizationId },
      },
      select: {
        artifactId: true,
        computeTargetId: true,
        harness: true,
        estimatedCost: true,
        authoritativeCostUsd: true,
        claudeCodeTelemetry: true,
      },
    });
    if (!session) {
      return null;
    }

    const rollup = session.claudeCodeTelemetry;
    const [components, drops, activeTimeRows, linesOfCodeRows] =
      await Promise.all([
        rollup
          ? db.claudeCodeComponentTelemetry.findMany({
              where: { artifactId: session.artifactId },
              orderBy: [{ costEventCount: "desc" }, { attributionKey: "asc" }],
              // BOUNDED, because the stored set is NOT bounded by the per-request
              // component cap. When `componentsTruncated` is set the ingest
              // deliberately skips the `deleteMany` so it does not delete the tail
              // the producer could not send, so what accumulates across deliveries
              // is the UNION of every top-slice — and the slice shifts as cost
              // moves between components. Without this a long session returns
              // thousands of rows on an endpoint with no pagination. Same cost
              // ordering as the producer's own slice, so the rows kept here are
              // the ones a reader asks about.
              take: CLAUDE_CODE_TELEMETRY_MAX_COMPONENTS_READ + 1,
            })
          : Promise.resolve([]),
        db.claudeCodeSignalDropCounter.findMany({
          // Scoped to THIS SESSION'S harness. The counter table is per machine and
          // keyed by `(harness, reason)`, so an unscoped read would let a Codex
          // export evicted at the receiver mark every Claude session on that
          // machine incomplete — a shortfall attributed to data it says nothing
          // about.
          where: {
            computeTargetId: session.computeTargetId,
            harness: session.harness,
          },
          orderBy: [{ reason: "asc" }],
        }),
        // BOUNDED for the same reason as the components read: when the producer
        // flags the breakdown truncated the ingest skips the complement delete, so
        // what accumulates across deliveries is the UNION of every slice and is not
        // bounded by the per-request cap. Crossing the ceiling sets the matching
        // `*Partial` flag rather than silently returning a slice as the whole set.
        rollup
          ? db.claudeCodeActiveTimeTelemetry.findMany({
              where: { artifactId: session.artifactId },
              orderBy: [{ seconds: "desc" }, { activityType: "asc" }],
              take: CLAUDE_CODE_TELEMETRY_MAX_ACTIVE_TIME_READ + 1,
            })
          : Promise.resolve([]),
        rollup
          ? db.claudeCodeLinesOfCodeTelemetry.findMany({
              where: { artifactId: session.artifactId },
              orderBy: [{ model: "asc" }, { changeType: "asc" }],
              take: CLAUDE_CODE_TELEMETRY_MAX_LINES_OF_CODE_READ + 1,
            })
          : Promise.resolve([]),
      ]);

    const dropReadings: ClaudeCodeDropCounterReading[] = drops.map((row) => ({
      harness: row.harness,
      reason: row.reason,
      droppedCount: row.droppedCount.toString(),
      firstObservedAt: row.firstObservedAt.toISOString(),
      lastObservedAt: row.lastObservedAt.toISOString(),
    }));

    const costs = collectCosts(session, rollup);
    const componentReadings: ClaudeCodeComponentReading[] = components
      .slice(0, CLAUDE_CODE_TELEMETRY_MAX_COMPONENTS_READ)
      .map((row) => ({
        attributionKey: row.attributionKey,
        attributionSource: row.attributionSource,
        agentName: row.agentName,
        skillName: row.skillName,
        pluginName: row.pluginName,
        mcpServerName: row.mcpServerName,
        mcpToolName: row.mcpToolName,
        querySource: row.querySource,
        speed: row.speed,
        effort: row.effort,
        costEventCount: row.costEventCount,
        cost: costReading(
          ClaudeCodeCostSource.HarnessCostEvent,
          ClaudeCodeCostUnit.Usd,
          row.costUsd
        ),
      }));

    // ONE PAST THE CAP WAS FETCHED, so a stored set of exactly the cap is
    // returned whole and reported complete. Comparing `length >= cap` against a
    // `take: cap` read cannot tell "the set is exactly this big" from "the set
    // was cut here", so an exactly-500 component set was published as a
    // shortfall that does not exist. The extra row is the observation, never
    // part of the answer, so it is dropped before anything reads the rows.
    const componentsPartial =
      components.length > CLAUDE_CODE_TELEMETRY_MAX_COMPONENTS_READ;
    const activeTimePartial =
      activeTimeRows.length > CLAUDE_CODE_TELEMETRY_MAX_ACTIVE_TIME_READ;
    const linesOfCodePartial =
      linesOfCodeRows.length > CLAUDE_CODE_TELEMETRY_MAX_LINES_OF_CODE_READ;

    const activeTime = activeTimeReadingsOf(
      rollup,
      activeTimeRows.slice(0, CLAUDE_CODE_TELEMETRY_MAX_ACTIVE_TIME_READ)
    );
    const linesOfCode = linesOfCodeReadingsOf(
      rollup,
      linesOfCodeRows.slice(0, CLAUDE_CODE_TELEMETRY_MAX_LINES_OF_CODE_READ)
    );
    const identity = identityReadingOf(rollup);

    // `complete` is drawn once, here, so two surfaces cannot disagree about it.
    // A machine that dropped anything makes every count it reports a LOWER
    // BOUND, which is a different claim from the count being right.
    const anyDrops = dropReadings.some((row) => row.droppedCount !== "0");
    return {
      availability: availabilityOf(session.harness, rollup !== null),
      harness: session.harness,
      protocolVersion: rollup?.protocolVersion ?? null,
      observedFrom: rollup?.observedFrom?.toISOString() ?? null,
      observedTo: rollup?.observedTo?.toISOString() ?? null,
      signals: signalsOf(rollup),
      costs,
      components: componentReadings,
      activeTime,
      linesOfCode,
      identity,
      completeness: {
        complete:
          rollup !== null &&
          !anyDrops &&
          rollup.componentsTruncated === false &&
          // ISS-11322: a truncated active-time or lines-of-code breakdown is a
          // real shortfall too. Leaving them out of this conclusion would report
          // a session as COMPLETE while two of its breakdowns were slices, which
          // is the exact conflation the flag exists to prevent.
          rollup.activeTimeTruncated === false &&
          rollup.linesOfCodeTruncated === false,
        drops: dropReadings,
        // EITHER shortfall makes the breakdown partial: the producer could not
        // send the whole set, or this read cut it at the cap above. Both mean
        // the reader is holding a slice, and a reader cannot act on the
        // difference.
        componentsPartial:
          rollup?.componentsTruncated === true || componentsPartial,
        activeTimePartial:
          rollup?.activeTimeTruncated === true || activeTimePartial,
        linesOfCodePartial:
          rollup?.linesOfCodeTruncated === true || linesOfCodePartial,
      },
    } satisfies ClaudeCodeTelemetryResponse;
  });
}

/**
 * The four costs a session can have, each naming its ledger.
 *
 * Assembled in one place so no caller can hand out a bare number: our estimate,
 * Claude's result envelope, the harness's OTel counter, and the producer's own
 * exact-integer micros are four DIFFERENT producers and none is a second
 * opinion of another.
 */
function collectCosts(
  session: {
    estimatedCost: { toString(): string } | null;
    authoritativeCostUsd: { toString(): string } | null;
  },
  rollup: {
    costEventUsd: { toString(): string } | null;
    apiRequestCostUsdMicros: { toString(): string } | null;
  } | null
): ClaudeCodeCostReading[] {
  const candidates = [
    costReading(
      ClaudeCodeCostSource.DesktopEstimate,
      ClaudeCodeCostUnit.Usd,
      session.estimatedCost
    ),
    costReading(
      ClaudeCodeCostSource.HarnessResultEnvelope,
      ClaudeCodeCostUnit.Usd,
      session.authoritativeCostUsd
    ),
    costReading(
      ClaudeCodeCostSource.HarnessCostEvent,
      ClaudeCodeCostUnit.Usd,
      rollup?.costEventUsd ?? null
    ),
    costReading(
      ClaudeCodeCostSource.ProducerApiRequestMicros,
      ClaudeCodeCostUnit.UsdMicros,
      rollup?.apiRequestCostUsdMicros ?? null
    ),
  ];
  return candidates.filter(
    (reading): reading is ClaudeCodeCostReading => reading !== null
  );
}

/**
 * Every family's reading. A `null` column is what the producer's OMISSION
 * persisted, so `signalReadingOf` maps it to "never recorded" — never to `0`.
 */
function signalsOf(
  rollup: {
    costEventCount: number | null;
    apiRequestCount: number | null;
    errorEventCount: number | null;
    permissionEventCount: number | null;
    permissionModeChangeCount: number | null;
    mcpServerConnectionCount: number | null;
    toolResultCount: number | null;
    llmRequestCount: number | null;
    authEventCount: number | null;
    pluginEventCount: number | null;
    sessionStartCount: number | null;
  } | null
): ClaudeCodeSignalReadings {
  if (!rollup) {
    return noSignals();
  }
  return {
    costEvents: signalReadingOf(rollup.costEventCount),
    apiRequests: signalReadingOf(rollup.apiRequestCount),
    errorEvents: signalReadingOf(rollup.errorEventCount),
    permissionEvents: signalReadingOf(rollup.permissionEventCount),
    permissionModeChanges: signalReadingOf(rollup.permissionModeChangeCount),
    mcpServerConnections: signalReadingOf(rollup.mcpServerConnectionCount),
    toolResults: signalReadingOf(rollup.toolResultCount),
    llmRequests: signalReadingOf(rollup.llmRequestCount),
    authEvents: signalReadingOf(rollup.authEventCount),
    pluginEvents: signalReadingOf(rollup.pluginEventCount),
    sessionStarts: signalReadingOf(rollup.sessionStartCount),
  };
}

/**
 * `null` when the family was never recorded on the delivering machine; an EMPTY
 * ARRAY when it was and this session produced none.
 *
 * GATED ON `activeTimeRecorded`, NOT ON `rollup === null`, and the difference is
 * the whole rule. A rollup row exists for a session with ANY of the fourteen
 * families, so "rollup present, zero rows" is the ordinary state of every machine
 * that has never captured active time — reporting `[]` there would assert a
 * measured absence of active time that was never observed, which is the exact
 * conflation this contract exists to break. The flag is the producer's OMISSION,
 * persisted; it is not recoverable from the rows.
 */
function activeTimeReadingsOf(
  rollup: { activeTimeRecorded: boolean } | null,
  rows: readonly { activityType: string; seconds: { toString(): string } }[]
): ClaudeCodeActiveTimeReading[] | null {
  if (rollup?.activeTimeRecorded !== true) {
    return null;
  }
  return rows.map((row) => ({
    activityType: row.activityType,
    seconds: row.seconds.toString(),
  }));
}

/** See {@link activeTimeReadingsOf} for the `null`-vs-empty rule and why the flag gates it. */
function linesOfCodeReadingsOf(
  rollup: { linesOfCodeRecorded: boolean } | null,
  rows: readonly {
    model: string;
    changeType: string;
    lineCount: { toString(): string };
  }[]
): ClaudeCodeLinesOfCodeReading[] | null {
  if (rollup?.linesOfCodeRecorded !== true) {
    return null;
  }
  return rows.map((row) => ({
    model: row.model,
    changeType: row.changeType,
    lineCount: row.lineCount.toString(),
  }));
}

/**
 * The identity dimensions, or `null` when the harness stamped no identity.
 *
 * `identityRecorded` is what the ingest persisted so that an identity row whose
 * every dimension was NULL stays distinguishable from a session with no identity
 * row at all. Reading the five columns for nullness instead would collapse them.
 */
function identityReadingOf(
  rollup: {
    identityRecorded: boolean;
    identityOrganizationId: string | null;
    identitySource: string | null;
    identityTerminalType: string | null;
    identityAppVersion: string | null;
    identityAppEntrypoint: string | null;
  } | null
): ClaudeCodeIdentityReading | null {
  if (rollup?.identityRecorded !== true) {
    return null;
  }
  return {
    organizationId: rollup.identityOrganizationId,
    identitySource: rollup.identitySource,
    terminalType: rollup.identityTerminalType,
    appVersion: rollup.identityAppVersion,
    appEntrypoint: rollup.identityAppEntrypoint,
  };
}

export const claudeCodeTelemetryReadService = { findClaudeCodeTelemetry };

/**
 * The most component rows one read returns.
 *
 * Deliberately larger than the producer's per-request cap: the stored set is the
 * union of every delivery's slice, so bounding at the request cap would hide
 * components the cloud legitimately holds. It is a ceiling against an unbounded
 * read, not a second truncation policy — crossing it sets `componentsPartial`.
 */
const CLAUDE_CODE_TELEMETRY_MAX_COMPONENTS_READ = 500;

/**
 * The most active-time rows one read returns. Larger than the producer's
 * per-request cap for the same reason as the component ceiling: the stored set is
 * the union of every delivery's slice. Crossing it sets `activeTimePartial`.
 */
const CLAUDE_CODE_TELEMETRY_MAX_ACTIVE_TIME_READ = 100;

/** The most lines-of-code rows one read returns. Crossing it sets `linesOfCodePartial`. */
const CLAUDE_CODE_TELEMETRY_MAX_LINES_OF_CODE_READ = 300;
