import { normalizeClaudeCodeOtelExport } from "../otel/claude-code-otel-normalizer.js";
import type { ClaudeCodeOtelSideTableSignal } from "../otel/claude-code-otel-signal-contract.js";
import type { ClaudeCodeOtelPersistenceSummary } from "../otel/claude-code-persistence.js";
import { ClaudeCodeSignalDropReason } from "../otel/claude-code-signal-drop.js";
import type { CodexOtelBatch } from "../otel/codex-otel-contract.js";
import { normalizeCodexOtelTraceExport } from "../otel/codex-otel-trace-normalizer.js";
import type {
  NormalizedOtlpExport,
  OtlpHttpReceiverOptions,
} from "./otlp-http-receiver.js";

export type OtlpExportWiring = {
  log: (message: string) => void;
  /**
   * ISS-7352 closed-by-default gate (`claudeCodeOtelCapture`). Read on EVERY
   * export rather than captured at construction, so turning the toggle off
   * stops capture at the next export instead of at the next app start.
   */
  isClaudeCaptureEnabled: () => boolean;
  /**
   * The local store's `claudeCodeOtel.persistSignals` seam. Injected rather
   * than imported so this module stays free of the DB host and can be driven
   * by a recorder in tests.
   *
   * Typed to the side-table-only union rather than `unknown[]`, so the
   * `token_usage` exclusion holds from the normalizer all the way to the
   * db-host facade instead of being re-widened here.
   */
  persistClaudeSignals: (
    signals: ClaudeCodeOtelSideTableSignal[]
  ) => Promise<ClaudeCodeOtelPersistenceSummary>;
  /**
   * ISS-10717: record a lost signal against the machine's drop counters.
   *
   * Injected rather than imported so this module stays free of the DB host, and
   * OPTIONAL so a composition that has not wired the recorder degrades to the
   * previous behaviour (the loss is logged) instead of throwing on an export.
   *
   * Fire-and-forget by signature, because an export must not be held up by the
   * bookkeeping about it; the recorder owns its own failure.
   */
  recordSignalDrop?: (input: {
    harness: string;
    reason: ClaudeCodeSignalDropReason;
    count: number;
  }) => void;
  /**
   * ISS-10719: the local store's `codexOtel.persistBatch` seam.
   *
   * OPTIONAL so a composition that predates the lane keeps the previous
   * behaviour (the export is logged) rather than throwing on every Codex
   * export. Injected, like its Claude sibling, so this module stays free of the
   * DB host.
   */
  persistCodexBatch?: (batch: CodexOtelBatch) => Promise<void>;
};

export type OtlpExportCallbacks = Required<
  Pick<OtlpHttpReceiverOptions, "onClaudeExport" | "onCodexExport">
>;

/**
 * The capture gate: BOTH switches must be on for a Claude OTel row to be kept.
 *
 * `claudeCodeOtelCapture` (ISS-7352) is this lane's own toggle;
 * `collectClaudeEnabled` (FEA-3741) is the shipped per-tool collector switch.
 * Reading only the former would let OTel rows keep writing while the collector
 * UI tells the user Claude collection is off — the UI would be lying about
 * state. Either being off is a promise that nothing is being kept.
 *
 * Returns a FUNCTION rather than a boolean so both switches are re-read on
 * every export: a gate captured at construction would keep capturing until the
 * next app start.
 */
export function claudeCaptureGate(readers: {
  isOtelCaptureEnabled: () => boolean;
  isClaudeCollectorEnabled: () => boolean;
}): () => boolean {
  return () =>
    readers.isOtelCaptureEnabled() && readers.isClaudeCollectorEnabled();
}

/**
 * ISS-7352 — the receiver's export callbacks, wired to persistence. Extracted
 * from the dashboard runtime composition root, which only ever logged the
 * exports it received: Claude Code's cost and per-request telemetry was
 * decoded, ACKed, and dropped.
 *
 * Only the CALLBACKS are built here. `new OtlpHttpReceiver` deliberately stays
 * at the composition root, because that is the only place that can read
 * `app.isPackaged` to resolve the ISS-5723 isolated loopback port — moving the
 * construction behind a factory would put the receiver's `port:` out of reach
 * of `test/loopback-port-isolation.test.ts`, which asserts on that argument.
 *
 * The receiver awaits and catches whatever a callback returns, so a store
 * failure here costs the batch and never the process.
 */
export function createOtlpExportCallbacks(
  wiring: OtlpExportWiring
): OtlpExportCallbacks {
  return {
    onClaudeExport: (payload) => persistClaudeExport(payload, wiring),
    onCodexExport: (payload) => persistCodexExport(payload, wiring),
  };
}

async function persistClaudeExport(
  payload: NormalizedOtlpExport,
  wiring: OtlpExportWiring
): Promise<void> {
  // Receipt is logged BEFORE the gate, matching the Codex branch: with capture
  // off there would otherwise be no record that Claude exports arrive at all,
  // which is the one question an operator debugging a silent table will ask.
  wiring.log(
    `received Claude ${payload.kind} export with ${payload.resourceAttributes.length} resource batch(es)`
  );
  if (!wiring.isClaudeCaptureEnabled()) {
    return;
  }
  const { signals, unusable, keyCollisions } =
    normalizeClaudeCodeOtelExport(payload);
  wiring.log(
    `Claude ${payload.kind} export normalized: ${signals.length} signal(s), ${unusable} unusable`
  );
  if (keyCollisions > 0) {
    // ISS-7481, counted under its OWN reason: a collision means the table is a
    // lower bound on real events, which is a different disclosure from a record
    // that could not be read.
    wiring.recordSignalDrop?.({
      harness: payload.harness,
      reason: ClaudeCodeSignalDropReason.NaturalKeyCollision,
      count: keyCollisions,
    });
  }
  // `unusable` INCLUDES the collisions, so the remainder is what is left after
  // they are attributed. Recording the whole of it under both reasons would
  // double-count the same lost signal.
  const unreadable = unusable - keyCollisions;
  if (unreadable > 0) {
    // ISS-10717: this count used to be logged and discarded, which is why
    // nothing downstream could say how complete the corpus was.
    wiring.recordSignalDrop?.({
      harness: payload.harness,
      reason: ClaudeCodeSignalDropReason.NormalizerUnusable,
      count: unreadable,
    });
  }
  if (signals.length === 0) {
    return;
  }
  const summary = await wiring.persistClaudeSignals(signals);
  if (summary.rejected > 0) {
    wiring.log(
      `Claude ${payload.kind} export persisted ${summary.accepted}, rejected ${summary.rejected}`
    );
    wiring.recordSignalDrop?.({
      harness: payload.harness,
      reason: ClaudeCodeSignalDropReason.PersistenceRejected,
      count: summary.rejected,
    });
  }
}

/**
 * ISS-10719 — the Codex half, which used to log the export and return.
 *
 * Only TRACES carry the spans this lane persists; a Codex metrics or logs
 * export is acknowledged and not counted unusable, because it is out of scope
 * rather than corrupt.
 *
 * The capture gate is deliberately NOT read here. That gate is
 * `claudeCodeOtelCapture` × the Claude collector toggle — both Claude-specific,
 * and reading either would let the Claude switch silently govern Codex. Codex
 * capture is governed by whether the user pointed Codex at this receiver at all.
 */
async function persistCodexExport(
  payload: NormalizedOtlpExport,
  wiring: OtlpExportWiring
): Promise<void> {
  wiring.log(
    `received Codex ${payload.kind} export with ${payload.resourceAttributes.length} resource batch(es)`
  );
  if (!wiring.persistCodexBatch) {
    return;
  }
  const { batch, unusable } = normalizeCodexOtelTraceExport(payload);
  if (unusable > 0) {
    wiring.recordSignalDrop?.({
      harness: payload.harness,
      reason: ClaudeCodeSignalDropReason.NormalizerUnusable,
      count: unusable,
    });
  }
  if (batch.spans.length === 0) {
    return;
  }
  wiring.log(
    `Codex ${payload.kind} export persisted ${batch.spans.length} span(s)`
  );
  try {
    await wiring.persistCodexBatch(batch);
  } catch (error) {
    // The Codex writer commits the WHOLE batch in one transaction, so a single
    // bad row rolls back every span with it — and the export was ACKed long
    // ago, so the exporter will never re-send. Without this the loss would
    // reach only a log line, and the completeness counter this lane exists to
    // feed would report the machine as clean while spans were being dropped.
    wiring.recordSignalDrop?.({
      harness: payload.harness,
      reason: ClaudeCodeSignalDropReason.PersistenceRejected,
      count: batch.spans.length,
    });
    wiring.log(
      `Codex ${payload.kind} export failed to persist ${batch.spans.length} span(s): ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
