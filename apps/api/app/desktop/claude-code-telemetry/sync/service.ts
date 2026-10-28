import {
  DesktopClaudeCodeTelemetrySyncAckReason as AckReason,
  type DesktopClaudeCodeTelemetrySyncAckReason,
  type DesktopClaudeCodeTelemetrySyncResponse,
  desktopClaudeCodeTelemetrySyncRequestSchema,
  isSupportedDesktopClaudeCodeTelemetrySyncProtocolVersion,
} from "@repo/api/src/types/desktop-claude-code-telemetry-sync";
import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
import { type TransactionClient, withDb } from "@repo/database";
import { computeTargetsService } from "@/app/compute-targets/service";
import {
  type RecordWriteInTransaction,
  writeRecorded,
} from "@/lib/record-write-in-transaction";

/**
 * ISS-10717 — ingest for the desktop Claude Code telemetry lane.
 *
 * The first production writer of `claude_code_session_telemetry`,
 * `claude_code_component_telemetry` and `claude_code_signal_drop_counter`.
 *
 * ── Order of the two gates is load-bearing ─────────────────────────────────
 * Parse FIRST, so a body that is merely malformed is answered as such; then
 * check the protocol version BEFORE any write, because an unrecognized version
 * means this build cannot know what the fields mean. The version answer is a
 * LANE-WIDE retryable condition, never a validation failure: the skew is a
 * property of the deployment, not of the session, and a permanent 400 is what
 * ISS-4976 / ISS-7795 measured dead-lettering a whole corpus.
 *
 * The request schema is NOT `.strict()` for the same reason — a newer desktop's
 * unknown keys are dropped by Zod rather than rejecting the payload.
 *
 * Every write is ORG-SCOPED: the session is resolved through the caller's own
 * compute target, and `organizationId` is never read from the body.
 */

type DesktopClaudeCodeTelemetrySyncInput = {
  clerkUserId: string | null;
  computeTargetId: string;
  organizationId: string;
  rawBody: unknown;
  userId: string;
};

export type DesktopClaudeCodeTelemetrySyncFailure = {
  reason: StatusCode | DesktopClaudeCodeTelemetrySyncAckReason;
};

async function sync(
  input: DesktopClaudeCodeTelemetrySyncInput,
  recordWrite?: RecordWriteInTransaction<DesktopClaudeCodeTelemetrySyncResponse>
): Promise<
  Result<
    DesktopClaudeCodeTelemetrySyncResponse,
    DesktopClaudeCodeTelemetrySyncFailure
  >
> {
  const target = await computeTargetsService.findOwnedById(
    input.computeTargetId,
    input.organizationId,
    input.userId,
    input.clerkUserId
  );
  if (!target) {
    return Result.err({ reason: Status.Forbidden });
  }

  const parsed = desktopClaudeCodeTelemetrySyncRequestSchema.safeParse(
    input.rawBody
  );
  if (!parsed.success) {
    return Result.err({ reason: AckReason.ValidationFailed });
  }
  if (
    !isSupportedDesktopClaudeCodeTelemetrySyncProtocolVersion(
      parsed.data.protocolVersion
    )
  ) {
    return Result.err({ reason: AckReason.ProtocolUnsupported });
  }

  const written = await writeRecorded(
    recordWrite,
    () =>
      withDb((db) => writeTelemetry(db, input.computeTargetId, parsed.data)),
    (response) => response
  );
  return Result.ok(written);
}

type ParsedRequest = ReturnType<
  typeof desktopClaudeCodeTelemetrySyncRequestSchema.parse
>;
type ParsedSession = NonNullable<
  ReturnType<
    typeof desktopClaudeCodeTelemetrySyncRequestSchema.parse
  >["session"]
>;
type ParsedDropCounters = ReturnType<
  typeof desktopClaudeCodeTelemetrySyncRequestSchema.parse
>["dropCounters"];

/**
 * The count and cost columns, mapping an OMITTED wire field to `null`.
 *
 * `null` here means "this machine has never recorded this signal family", which
 * is the claim the producer made by omitting it. Nothing in this map may
 * substitute `0`: that would turn a never-observed family into a measured zero,
 * which is the exact conflation ISS-10717's completeness signal exists to break.
 */
function telemetryColumns(session: ParsedSession) {
  return {
    costEventCount: session.costEventCount ?? null,
    apiRequestCount: session.apiRequestCount ?? null,
    errorEventCount: session.errorEventCount ?? null,
    permissionEventCount: session.permissionEventCount ?? null,
    permissionModeChangeCount: session.permissionModeChangeCount ?? null,
    mcpServerConnectionCount: session.mcpServerConnectionCount ?? null,
    toolResultCount: session.toolResultCount ?? null,
    llmRequestCount: session.llmRequestCount ?? null,
    authEventCount: session.authEventCount ?? null,
    pluginEventCount: session.pluginEventCount ?? null,
    sessionStartCount: session.sessionStartCount ?? null,
    costEventUsd: session.costEventUsd ?? null,
    apiRequestCostUsdMicros:
      session.apiRequestCostUsdMicros === undefined
        ? null
        : BigInt(session.apiRequestCostUsdMicros),
    observedFrom: parseInstant(session.observedFrom),
    observedTo: parseInstant(session.observedTo),
    componentsTruncated: session.componentsTruncated === true,
  };
}

/**
 * The two breakdowns' recorded and truncated flags, and the identity block —
 * EACH WRITTEN ONLY WHEN ITS WIRE FIELD WAS PRESENT.
 *
 * `activeTimeRecorded` is the PRESENCE of the wire field, not whether it had
 * rows. An omitted array means the machine has never recorded the family; a
 * present `[]` is the measured claim that it does and this session produced none.
 * Neither is derivable from the stored rows afterwards, because a rollup exists
 * for a session with any of the fourteen families — so without these flags the
 * read would report a measured zero on every machine that never captured them.
 *
 * WHICH IS EXACTLY WHY THE OMITTED CASE MUST WRITE NOTHING. The protocol is
 * version-skewed in both directions, so a delayed delivery from an older build —
 * or a downgraded install — arrives with these fields absent for a reason that is
 * about the BUILD, not the machine. Folding that into `false` would clear a
 * recorded breakdown back to unknown and mark a truncated one complete, and
 * `replaceActiveTime` would then leave the rows in place under a flag that says
 * they were never measured. The flag travels with its array or not at all.
 */
function breakdownColumns(session: ParsedSession) {
  return {
    ...(session.activeTime === undefined
      ? {}
      : {
          activeTimeRecorded: true,
          activeTimeTruncated: session.activeTimeTruncated === true,
        }),
    ...(session.linesOfCode === undefined
      ? {}
      : {
          linesOfCodeRecorded: true,
          linesOfCodeTruncated: session.linesOfCodeTruncated === true,
        }),
    ...identityColumns(session.identity),
  };
}

/**
 * The identity dimensions, or NO COLUMNS AT ALL when the payload omitted them.
 *
 * An omission is not a measurement — the same rule `replaceActiveTime` follows for
 * an omitted array — so it writes nothing and clears nothing. Returning
 * `identityRecorded: false` plus five NULLs here instead would do two wrong things
 * at once: publish "the harness stamped no identity for this session" for a machine
 * that has never recorded the family, and DELETE dimensions a previous delivery
 * stored. The second is the sharper edge, because the desktop's retention sweep
 * purges `claude_code_session_identity` rows, so an aged-out machine would
 * otherwise wipe cloud identity for every session it still syncs.
 *
 * `identityRecorded` stays the read's gate: TRUE with five NULLs is "the family is
 * captured here and no dimension is known for this session", and FALSE — the
 * column default, so also what a pre-ISS-11322 row carries — is "never recorded".
 */
function identityColumns(identity: ParsedSession["identity"]) {
  if (!identity) {
    return {};
  }
  return {
    identityRecorded: true,
    identityOrganizationId: identity.organizationId ?? null,
    identitySource: identity.identitySource ?? null,
    identityTerminalType: identity.terminalType ?? null,
    identityAppVersion: identity.appVersion ?? null,
    identityAppEntrypoint: identity.appEntrypoint ?? null,
  };
}

/**
 * A wire instant as a `Date`, or `null` when it is absent or unparseable.
 *
 * An unparseable instant becomes `null` rather than `Invalid Date`: the column
 * is only a window bound, and storing an invalid date would fail the write and
 * cost the whole session over a field nothing keys on.
 */
function parseInstant(value: string | undefined): Date | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Persist the machine's drop counters, LAST-WRITE-WINS.
 *
 * Each payload carries the machine's current TOTAL, so the stored value is
 * replaced and never incremented — adding two deliveries of the same counter
 * would double-count and report a machine as less complete than it is.
 */
async function persistDropCounters(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  computeTargetId: string,
  counters: ParsedDropCounters
): Promise<number> {
  let recorded = 0;
  for (const counter of counters) {
    const firstObservedAt = parseInstant(counter.firstObservedAt);
    const lastObservedAt = parseInstant(counter.lastObservedAt);
    if (!(firstObservedAt && lastObservedAt)) {
      // A counter whose window cannot be read is not a smaller measurement, it
      // is an unusable one. Skipped rather than stored with an invented window.
      continue;
    }
    const droppedCount = BigInt(counter.droppedCount);
    await db.claudeCodeSignalDropCounter.upsert({
      where: {
        computeTargetId_harness_reason: {
          computeTargetId,
          harness: counter.harness,
          reason: counter.reason,
        },
      },
      create: {
        computeTargetId,
        harness: counter.harness,
        reason: counter.reason,
        droppedCount,
        firstObservedAt,
        lastObservedAt,
      },
      update: {
        droppedCount,
        firstObservedAt,
        lastObservedAt,
        lastSyncedAt: new Date(),
      },
      select: { id: true },
    });
    recorded += 1;
  }
  return recorded;
}

/**
 * Replace this session's component set with the payload's.
 *
 * ORDER IS LOAD-BEARING: upsert first, delete the survivors' complement second.
 * The payload is the WHOLE set, so a component that stopped appearing must stop
 * being reported, but `withDb` hands a client that is already inside the
 * caller's transaction scope or is the bare client, and in neither case can this
 * service open one of its own. A delete-then-insert would therefore leave a
 * window in which the session has NO components, and a read landing there would
 * report a confident, wrong zero for a session that has plenty. Reversed, the
 * worst a failure between the two steps can do is leave a stale extra row, which
 * over-reports rather than lies about absence and which the next delivery clears.
 *
 * A per-row upsert rather than a batch because Prisma ships no `upsertMany`; the
 * loop is bounded by the wire contract's per-request component cap.
 */
async function replaceComponents(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  artifactId: string,
  components: ParsedSession["components"],
  options: { truncated: boolean }
): Promise<void> {
  for (const component of components) {
    const fields = {
      attributionSource: component.attributionSource,
      agentName: component.agentName ?? null,
      skillName: component.skillName ?? null,
      pluginName: component.pluginName ?? null,
      mcpServerName: component.mcpServerName ?? null,
      mcpToolName: component.mcpToolName ?? null,
      querySource: component.querySource ?? null,
      speed: component.speed ?? null,
      effort: component.effort ?? null,
      costEventCount: component.costEventCount,
      costUsd: component.costUsd ?? null,
    };
    await db.claudeCodeComponentTelemetry.upsert({
      where: {
        artifactId_attributionKey: {
          artifactId,
          attributionKey: component.attributionKey,
        },
      },
      create: {
        artifactId,
        attributionKey: component.attributionKey,
        ...fields,
      },
      update: { ...fields, lastSyncedAt: new Date() },
      select: { id: true },
    });
  }
  if (options.truncated) {
    // The producer could not fit this session's whole component set in one
    // request, so `components` is the top slice by cost. Deleting its
    // complement would delete the tail nobody sent — turning a bounded payload
    // into permanent cloud-side loss of the very attribution this lane exists
    // to carry. What is already stored stays, and the read says the breakdown
    // is partial.
    return;
  }
  await db.claudeCodeComponentTelemetry.deleteMany({
    where: {
      artifactId,
      attributionKey: {
        notIn: components.map((component) => component.attributionKey),
      },
    },
  });
}

/**
 * Replace this session's active-time breakdown with the payload's.
 *
 * Same ORDER and same TRUNCATION rule as {@link replaceComponents}, and for the
 * same reasons: upsert first so no read can land on an empty set and report a
 * confident wrong zero, and skip the complement delete when the producer says the
 * slice is partial so a bounded payload cannot become permanent cloud-side loss.
 *
 * `undefined` is the third case and is NOT an empty set: it means the family has
 * never been recorded on that machine, so this writes nothing at all.
 */
async function replaceActiveTime(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  artifactId: string,
  rows: ParsedSession["activeTime"],
  options: { truncated: boolean }
): Promise<void> {
  if (rows === undefined) {
    return;
  }
  for (const row of rows) {
    await db.claudeCodeActiveTimeTelemetry.upsert({
      where: {
        artifactId_activityType: { artifactId, activityType: row.activityType },
      },
      create: {
        artifactId,
        activityType: row.activityType,
        seconds: row.seconds,
      },
      update: { seconds: row.seconds, lastSyncedAt: new Date() },
      select: { id: true },
    });
  }
  if (options.truncated) {
    return;
  }
  await db.claudeCodeActiveTimeTelemetry.deleteMany({
    where: {
      artifactId,
      activityType: { notIn: rows.map((row) => row.activityType) },
    },
  });
}

/**
 * Replace this session's lines-of-code breakdown with the payload's.
 *
 * The complement delete cannot be expressed as one `notIn` here, because the
 * identity is the PAIR `(model, changeType)` and a `notIn` over either column
 * alone would delete a surviving pair that happens to share one half with a
 * departed one. It is stated as "not any of these pairs" instead, which is the
 * same set the upserts above wrote.
 */
async function replaceLinesOfCode(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  artifactId: string,
  rows: ParsedSession["linesOfCode"],
  options: { truncated: boolean }
): Promise<void> {
  if (rows === undefined) {
    return;
  }
  for (const row of rows) {
    const lineCount = BigInt(row.lineCount);
    await db.claudeCodeLinesOfCodeTelemetry.upsert({
      where: {
        artifactId_model_changeType: {
          artifactId,
          model: row.model,
          changeType: row.changeType,
        },
      },
      create: {
        artifactId,
        model: row.model,
        changeType: row.changeType,
        lineCount,
      },
      update: { lineCount, lastSyncedAt: new Date() },
      select: { id: true },
    });
  }
  if (options.truncated) {
    return;
  }
  await db.claudeCodeLinesOfCodeTelemetry.deleteMany({
    where: {
      artifactId,
      NOT: rows.map((row) => ({
        model: row.model,
        changeType: row.changeType,
      })),
    },
  });
}

export const desktopClaudeCodeTelemetrySyncService = { sync };

/**
 * Write one accepted payload. With no receipt to record it runs on the bare
 * client, each statement committing on its own; recorded, it runs in one
 * transaction with the request's receipt (ISS-12552).
 */
async function writeTelemetry(
  db: TransactionClient,
  computeTargetId: string,
  payload: ParsedRequest
): Promise<DesktopClaudeCodeTelemetrySyncResponse> {
  const { session, dropCounters, protocolVersion } = payload;
  // The drop counters are machine-level and do NOT depend on the session
  // existing, so they are written before the session gate. Losing them to a
  // session the metadata lane has not delivered yet would mean the completeness
  // signal arrived later than the data it qualifies.
  const dropCountersRecorded = await persistDropCounters(
    db,
    computeTargetId,
    dropCounters
  );

  if (!session) {
    // A COUNTERS-ONLY delivery: the only thing that moved on that machine was
    // a loss recorded before any signal row existed, so there is no session to
    // name. Accepted, because the write the payload asked for is done — the
    // desktop's counter watermark advances on exactly this ack, and refusing it
    // would leave the completeness signal stranded on the machine forever.
    return {
      accepted: true,
      protocolVersion,
      dropCountersRecorded,
    } satisfies DesktopClaudeCodeTelemetrySyncResponse;
  }

  const sessionRow = await db.sessionDetail.findUnique({
    where: {
      computeTargetId_externalSessionId: {
        computeTargetId,
        externalSessionId: session.externalSessionId,
      },
    },
    select: { artifactId: true },
  });

  if (!sessionRow) {
    // Ordinary, not a failure: the session lane creates the row and runs
    // independently. Reported so the desktop can defer rather than treat the
    // absence as a payload defect.
    return {
      accepted: false,
      protocolVersion,
      externalSessionId: session.externalSessionId,
      dropCountersRecorded,
      reason: AckReason.SessionNotFound,
    } satisfies DesktopClaudeCodeTelemetrySyncResponse;
  }

  const artifactId = sessionRow.artifactId;
  await db.claudeCodeSessionTelemetry.upsert({
    where: { artifactId },
    create: {
      artifactId,
      harness: session.harness,
      protocolVersion,
      ...telemetryColumns(session),
      // A CREATE has nothing to preserve, so the three omission-gated column
      // groups take their honest starting value here: the family was not
      // reported, so it was not recorded.
      ...breakdownColumns(session),
    },
    update: {
      harness: session.harness,
      protocolVersion,
      ...telemetryColumns(session),
      // OMITTED ON UPDATE WHEN THE WIRE FIELD IS ABSENT, unlike the create
      // above. A downgraded or delayed desktop that cannot report these
      // families omits them, and writing `false` there would convert "this
      // build does not speak the field" into "this machine measured the family
      // and found none", flipping a recorded breakdown back to unknown and
      // marking a truncated one complete. Same rule `identityColumns` follows.
      ...breakdownColumns(session),
      lastSyncedAt: new Date(),
    },
    // The row is written, never read back: without a `select` Prisma asks for
    // `RETURNING *` and materialises every column for a value nobody uses.
    select: { artifactId: true },
  });

  const components = session.components ?? [];
  await replaceComponents(db, artifactId, components, {
    truncated: session.componentsTruncated === true,
  });
  // ISS-11322's two value-bearing breakdowns. An OMITTED array means the
  // recording machine has never recorded that family, so nothing is written and
  // nothing is deleted — what the cloud already holds is what a previous build
  // delivered and is still the best evidence there is. A PRESENT `[]` is the
  // measured claim "this machine records the family and this session produced
  // none", and that one DOES clear the rows.
  await replaceActiveTime(db, artifactId, session.activeTime, {
    truncated: session.activeTimeTruncated === true,
  });
  await replaceLinesOfCode(db, artifactId, session.linesOfCode, {
    truncated: session.linesOfCodeTruncated === true,
  });

  return {
    accepted: true,
    protocolVersion,
    externalSessionId: session.externalSessionId,
    componentsRecorded: components.length,
    dropCountersRecorded,
  } satisfies DesktopClaudeCodeTelemetrySyncResponse;
}
