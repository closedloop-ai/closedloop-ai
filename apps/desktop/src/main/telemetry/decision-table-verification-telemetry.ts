import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  countNewlinesBeforeOffset,
  getJsonlFileOffset,
} from "./telemetry-file-utils.js";
import type {
  DecisionTableVerificationMissingDiagnostics,
  DecisionTableVerificationRecordDiagnostics,
  TelemetryEmitter,
} from "./telemetry-protocol.js";

export const DECISION_TABLE_VERIFICATION_RELATIVE_PATH = path.join(
  "decision-table-verifications.jsonl"
);

const decisionTableVerificationSchema = z.object({
  timestamp: z.string().refine((value) => !Number.isNaN(Date.parse(value))),
  workdir: z.string(),
  decision_table_path: z.string(),
  final_status: z.enum([
    "aligned",
    "aligned_with_clarifications",
    "verification_failed",
  ]),
  iterations: z.number().int().nonnegative(),
  drift_kind_counts: z.object({
    code_drift: z.number().int().nonnegative(),
    test_drift: z.number().int().nonnegative(),
    plan_ambiguity: z.number().int().nonnegative(),
  }),
  fixes_attempted: z.number().int().nonnegative(),
  parse_failures: z.number().int().nonnegative(),
  verifier_invocations: z.number().int().nonnegative(),
  phase_duration_ms: z.number().int().nonnegative(),
});

type RawDecisionTableVerification = z.infer<
  typeof decisionTableVerificationSchema
>;

export type DecisionTableVerificationScanResult = {
  filePath: string;
  filePresent: boolean;
  startOffset: number;
  endOffset: number;
  linesRead: number;
  invalidLines: number;
  records: DecisionTableVerificationRecordDiagnostics[];
  missing?: DecisionTableVerificationMissingDiagnostics;
};

export type DecisionTableVerificationEmissionSummary = {
  filePath: string;
  emittedRecords: number;
  emittedMissing: boolean;
  startOffset: number;
  endOffset: number;
  linesRead: number;
  invalidLines: number;
  missingReason?: DecisionTableVerificationMissingDiagnostics["missingReason"];
};

/**
 * Capture the current append boundary for the Phase 5.5 verifier JSONL before
 * an EXECUTE process starts writing new telemetry lines.
 */
export function getDecisionTableVerificationTelemetryOffset(
  closedLoopWorkDir: string
): number {
  return getJsonlFileOffset(
    getDecisionTableVerificationTelemetryFilePath(closedLoopWorkDir)
  );
}

/**
 * Read Phase 5.5 verifier JSONL from a Closedloop workdir and return only
 * records appended after the current EXECUTE process boundary.
 */
export function scanDecisionTableVerificationTelemetry(
  closedLoopWorkDir: string,
  options: { startOffset?: number } = {}
): DecisionTableVerificationScanResult {
  const filePath =
    getDecisionTableVerificationTelemetryFilePath(closedLoopWorkDir);
  const startOffset = normalizeStartOffset(options.startOffset);

  // Emitted telemetry must not carry the absolute workdir path: it is rooted at
  // the user's home directory and reveals the OS username + local project
  // layout. Report the path relative to the Closedloop workdir instead. The
  // top-level `filePath` stays absolute for local operator logging only.
  // (FEA-2702)
  const telemetryFilePath = path.relative(closedLoopWorkDir, filePath);

  if (!existsSync(filePath)) {
    return {
      filePath,
      filePresent: false,
      startOffset,
      endOffset: 0,
      linesRead: 0,
      invalidLines: 0,
      records: [],
      missing: {
        telemetryStatus: "missing",
        telemetryFilePath,
        filePresent: false,
        linesRead: 0,
        invalidLines: 0,
        missingReason: "file_not_found",
      },
    };
  }

  let contentBuffer: Buffer;
  try {
    contentBuffer = readFileSync(filePath);
  } catch (err) {
    return {
      filePath,
      filePresent: true,
      startOffset,
      endOffset: 0,
      linesRead: 0,
      invalidLines: 0,
      records: [],
      missing: {
        telemetryStatus: "missing",
        telemetryFilePath,
        filePresent: true,
        linesRead: 0,
        invalidLines: 0,
        missingReason: "read_error",
        // Raw fs error strings typically embed the same absolute path, so scrub
        // the workdir out before it reaches the telemetry sink. (FEA-2702)
        readError: redactWorkdirPaths(
          err instanceof Error ? err.message : String(err),
          closedLoopWorkDir,
          filePath,
          telemetryFilePath
        ),
      },
    };
  }

  const endOffset = contentBuffer.byteLength;
  const readStartOffset = Math.min(startOffset, endOffset);
  const lineNumberBase = countNewlinesBeforeOffset(
    contentBuffer,
    readStartOffset
  );
  const content = contentBuffer.subarray(readStartOffset).toString("utf-8");
  const records: DecisionTableVerificationRecordDiagnostics[] = [];
  let linesRead = 0;
  let invalidLines = 0;

  for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    linesRead += 1;

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(line);
    } catch {
      invalidLines += 1;
      continue;
    }

    const parsed = decisionTableVerificationSchema.safeParse(parsedJson);
    if (!parsed.success) {
      invalidLines += 1;
      continue;
    }

    records.push(
      toTelemetryRecord(
        parsed.data,
        { filePath, telemetryFilePath, closedLoopWorkDir },
        lineNumberBase + index + 1
      )
    );
  }

  const missingReason =
    records.length > 0
      ? null
      : linesRead === 0 && readStartOffset === 0
        ? "empty"
        : "no_current_run_records";

  return {
    filePath,
    filePresent: true,
    startOffset: readStartOffset,
    endOffset,
    linesRead,
    invalidLines,
    records,
    ...(missingReason
      ? {
          missing: {
            telemetryStatus: "missing",
            telemetryFilePath,
            filePresent: true,
            linesRead,
            invalidLines,
            missingReason,
          },
        }
      : {}),
  };
}

/**
 * Emit Datadog-bound telemetry for the decision-table verifier JSONL generated
 * by the just-finished EXECUTE command.
 */
export function emitDecisionTableVerificationTelemetry(args: {
  telemetry: TelemetryEmitter;
  commandId?: string;
  operationId?: string;
  loopId: string;
  closedLoopWorkDir: string;
  startOffset?: number;
}): DecisionTableVerificationEmissionSummary {
  const scan = scanDecisionTableVerificationTelemetry(args.closedLoopWorkDir, {
    startOffset: args.startOffset,
  });

  for (const record of scan.records) {
    args.telemetry.emit({
      severity: record.finalStatus === "verification_failed" ? "warn" : "info",
      category: "job.decision_table_verification",
      message: `Decision-table verification ${record.finalStatus}`,
      trace: {
        commandId: args.commandId,
        operationId: args.operationId,
        loopId: args.loopId,
        jobId: args.loopId,
      },
      diagnostics: { decisionTableVerification: record },
    });
  }

  if (scan.records.length === 0 && scan.missing) {
    emitMissingTelemetry(args, scan.missing);
  }

  return {
    filePath: scan.filePath,
    emittedRecords: scan.records.length,
    emittedMissing: scan.records.length === 0 && scan.missing !== undefined,
    startOffset: scan.startOffset,
    endOffset: scan.endOffset,
    linesRead: scan.linesRead,
    invalidLines: scan.invalidLines,
    ...(scan.missing ? { missingReason: scan.missing.missingReason } : {}),
  };
}

function emitMissingTelemetry(
  args: {
    telemetry: TelemetryEmitter;
    commandId?: string;
    operationId?: string;
    loopId: string;
  },
  diagnostic: DecisionTableVerificationMissingDiagnostics
): void {
  args.telemetry.emit({
    severity: "info",
    category: "job.decision_table_verification",
    message: `Decision-table verification telemetry ${diagnostic.missingReason}`,
    trace: {
      commandId: args.commandId,
      operationId: args.operationId,
      loopId: args.loopId,
      jobId: args.loopId,
    },
    diagnostics: { decisionTableVerification: diagnostic },
  });
}

/**
 * Strip the absolute Closedloop workdir out of a free-text string (e.g. a raw
 * `fs` error message) before it reaches the telemetry sink. The workdir is
 * rooted at the user's home directory, so leaving it in leaks the OS username
 * and local project layout. The known absolute file path is rewritten to its
 * relative form first, then any residual workdir occurrence is masked. Finally,
 * any home-rooted absolute path that lies *outside* the workdir (e.g. a
 * `decision_table_path` pointing elsewhere under $HOME) has its home-directory
 * prefix collapsed to `~`, so the OS username never egresses. (FEA-2702)
 */
export function redactWorkdirPaths(
  text: string,
  closedLoopWorkDir: string,
  filePath: string,
  relativeFilePath: string
): string {
  // Guard against empty search strings: `String.prototype.replaceAll("", x)`
  // inserts `x` between every character, which would corrupt the message.
  let scrubbed = text;
  if (filePath) {
    scrubbed = scrubbed.replaceAll(filePath, relativeFilePath);
  }
  if (closedLoopWorkDir) {
    scrubbed = scrubbed.replaceAll(closedLoopWorkDir, "<workdir>");
  }
  // Collapse any remaining occurrence of the OS home directory (a workdir
  // outside $HOME leaves its own username-bearing prefix untouched above, but
  // home-rooted paths pointing outside the workdir would still leak the
  // username without this pass).
  const home = homedir();
  if (home) {
    scrubbed = scrubbed.replaceAll(home, "~");
  }
  return scrubbed;
}

function getDecisionTableVerificationTelemetryFilePath(
  closedLoopWorkDir: string
): string {
  return path.join(
    closedLoopWorkDir,
    DECISION_TABLE_VERIFICATION_RELATIVE_PATH
  );
}

function normalizeStartOffset(startOffset: number | undefined): number {
  if (
    startOffset === undefined ||
    !Number.isFinite(startOffset) ||
    startOffset < 0
  ) {
    return 0;
  }
  return Math.floor(startOffset);
}

function toTelemetryRecord(
  record: RawDecisionTableVerification,
  paths: {
    filePath: string;
    telemetryFilePath: string;
    closedLoopWorkDir: string;
  },
  lineNumber: number
): DecisionTableVerificationRecordDiagnostics {
  // The reported record egresses to the telemetry sink, so strip the absolute
  // workdir out of every path-bearing field. `telemetryFilePath` is our own
  // constructed path; `workdir`/`decisionTablePath` come from the JSONL and may
  // also be home-rooted absolute paths. (FEA-2702)
  return {
    telemetryStatus: "reported",
    telemetryFilePath: paths.telemetryFilePath,
    lineNumber,
    timestamp: record.timestamp,
    workdir: redactWorkdirPaths(
      record.workdir,
      paths.closedLoopWorkDir,
      paths.filePath,
      paths.telemetryFilePath
    ),
    decisionTablePath: redactWorkdirPaths(
      record.decision_table_path,
      paths.closedLoopWorkDir,
      paths.filePath,
      paths.telemetryFilePath
    ),
    finalStatus: record.final_status,
    iterations: record.iterations,
    driftKindCounts: {
      codeDrift: record.drift_kind_counts.code_drift,
      testDrift: record.drift_kind_counts.test_drift,
      planAmbiguity: record.drift_kind_counts.plan_ambiguity,
    },
    fixesAttempted: record.fixes_attempted,
    parseFailures: record.parse_failures,
    verifierInvocations: record.verifier_invocations,
    phaseDurationMs: record.phase_duration_ms,
  };
}
