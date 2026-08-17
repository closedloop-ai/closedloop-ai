/**
 * FEA-2274 (PRD-488) — offline linguistic-distillation harness.
 *
 * The developer/CI-run MEASUREMENT tool resolved by Q-002 (offline-only). It is
 * NOT wired into the runtime importer and ships nothing to users. It:
 *   1. loads every golden dossier's frozen `normalized.json` (the production
 *      NormalizedSession — the Layer-1 golden contract guarantees fidelity) and
 *      its signed `harness`;
 *   2. runs the shipped FEA-2269 classifier over it, prices each turn with the
 *      canonical genai-prices engine, and attributes spend to segments through
 *      the classifier's own boundary rule;
 *   3. scans the prose inside each RESIDUAL (`other`/low-confidence) window with
 *      the deterministic linguistic labeler; and
 *   4. reports, via the FEA-2266 Coverage SSOT, how much residual spend is
 *      linguistically recognizable — overall and per cohort — plus the per-rule
 *      support that tells a human which signatures deserve promotion into the
 *      deterministic classifier.
 *
 * READ-ONLY over packages/golden-sessions (see its AGENTS.md); output
 * is written to this test/golden directory, never into the corpus. Like
 * derive-corpus-expectations.ts, it never runs in CI — invoke explicitly:
 *   pnpm exec tsx test/golden/derive-linguistic-distillation.ts
 *
 * HONEST UPPER BOUND: the corpus has no per-segment activity ground-truth, so the
 * "after" coverage assumes every matched relabel is correct. This measures
 * linguistic RECOGNIZABILITY of residual spend, not label correctness. See the
 * generated report's caveat and distill-report.ts.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { EVIDENCE_MODEL_VERSION } from "../../src/main/collectors/evidence/evidence-model.js";
import { listDossierDirs } from "../../src/main/collectors/golden/corpus-layout.js";
import {
  ACTIVITY_CLASSIFIER_VERSION,
  type ActivitySegmentRecord,
  classifyActivitySegments,
  deriveSessionBoundsMs,
  segmentIndexForMs,
} from "../../src/main/collectors/parsing/activity-segment-classifier.js";
import { isClosedloopMcpTool } from "../../src/main/collectors/parsing/artifact-ref-extractor.js";
import {
  buildDistillationReport,
  type DistillationReport,
  type DistillSegmentInput,
  type DistillSessionInput,
} from "../../src/main/collectors/parsing/linguistic/distill-report.js";
import {
  LINGUISTIC_RULES,
  MAX_PROSE_SCAN_CHARS,
} from "../../src/main/collectors/parsing/linguistic/linguistic-features.js";
import { isResidualSegment } from "../../src/main/collectors/parsing/linguistic/residual-selector.js";
import {
  type Harness,
  HarnessValues,
  type NormalizedSession,
} from "../../src/main/collectors/types.js";
import {
  ATTRIBUTION_METRIC_VERSION,
  autonomyBandFor,
  COHORT_AXIS_VALUES,
  type CohortAxis,
  type CoverageCell,
  type CoverageResult,
  type SessionCohort,
  sessionLengthBandFor,
  TAXONOMY_VERSION,
} from "../../src/main/telemetry/attribution-metrics.js";
import { estimateTokenCost } from "../../src/shared/token-cost.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CORPUS_ROOT = resolve(SCRIPT_DIR, "../../../../packages/golden-sessions");
const REPORT_MD = join(SCRIPT_DIR, "linguistic-distillation-report.md");
const REPORT_JSON = join(SCRIPT_DIR, "linguistic-distillation-report.json");

/** Bumped when the report's shape/sections change (independent of the versions it stamps). */
const REPORT_SCHEMA_VERSION = 1;

/**
 * Deterministic provenance stamped into every report. The numbers only mean the
 * same thing across runs that share these versions + rule set; a bump to any of
 * them marks an older committed report as stale.
 */
type ReportMeta = {
  reportSchemaVersion: number;
  activityClassifierVersion: number;
  evidenceModelVersion: number;
  attributionMetricVersion: number;
  taxonomyVersion: number;
  ruleIds: string[];
  /** Content hash over the rule id+phase+regex source — flags a cue edit that keeps its id. */
  ruleSetHash: string;
};

/**
 * A stable hash of the rule set's SEMANTICS (id + phase + regex source), not just
 * the ids. Editing a cue's pattern without renaming its id changes this hash, so a
 * committed report whose hash no longer matches the code is detectably stale —
 * `ruleIds` alone would stay byte-identical and hide the drift.
 */
function ruleSetHash(): string {
  const signature = LINGUISTIC_RULES.map(
    (rule) => `${rule.id}:${rule.phase}:${rule.pattern.source}`
  ).join("|");
  return createHash("sha256").update(signature).digest("hex").slice(0, 16);
}

function buildReportMeta(): ReportMeta {
  return {
    reportSchemaVersion: REPORT_SCHEMA_VERSION,
    activityClassifierVersion: ACTIVITY_CLASSIFIER_VERSION,
    evidenceModelVersion: EVIDENCE_MODEL_VERSION,
    attributionMetricVersion: ATTRIBUTION_METRIC_VERSION,
    taxonomyVersion: TAXONOMY_VERSION,
    ruleIds: LINGUISTIC_RULES.map((rule) => rule.id),
    ruleSetHash: ruleSetHash(),
  };
}

// ── Corpus loading ────────────────────────────────────────────────────────────

function readHarness(dossierDir: string): Harness | null {
  const path = join(dossierDir, "expectations.yaml");
  if (!existsSync(path)) {
    return null;
  }
  const doc = parseYaml(readFileSync(path, "utf8")) as { harness?: unknown };
  const value = doc.harness;
  if (typeof value !== "string") {
    return null;
  }
  return HarnessValues.find((h) => h === value) ?? null;
}

function readSession(dossierDir: string): NormalizedSession | null {
  const path = join(dossierDir, "normalized.json");
  if (!existsSync(path)) {
    return null;
  }
  return JSON.parse(readFileSync(path, "utf8")) as NormalizedSession;
}

// ── Spend attribution (pure genai-prices per turn) ────────────────────────────

type SpendEvent = { ms: number; costUsd: number };

function priceTurns(session: NormalizedSession): {
  events: SpendEvent[];
  totalUsd: number;
} {
  const events: SpendEvent[] = [];
  let totalUsd = 0;
  for (const rec of session.tokenSeries) {
    const ms = Date.parse(rec.timestamp);
    if (!Number.isFinite(ms)) {
      continue;
    }
    const priced = estimateTokenCost({
      model: rec.model,
      inputTokens: rec.input,
      outputTokens: rec.output,
      cacheReadTokens: rec.cacheRead,
      cacheWriteTokens: rec.cacheWrite,
      observedAt: rec.timestamp,
    });
    const costUsd = priced?.costUsd ?? 0;
    events.push({ ms, costUsd });
    totalUsd += costUsd;
  }
  return { events, totalUsd };
}

function attributeSpend(
  segments: readonly ActivitySegmentRecord[],
  events: readonly SpendEvent[]
): { perSegmentUsd: number[]; gapUsd: number; totalUsd: number } {
  const perSegmentUsd = segments.map(() => 0);
  let totalUsd = 0;
  let assignedUsd = 0;
  for (const event of events) {
    totalUsd += event.costUsd;
    const index = segmentIndexForMs(segments, event.ms);
    if (index >= 0) {
      perSegmentUsd[index] += event.costUsd;
      assignedUsd += event.costUsd;
    }
  }
  return { perSegmentUsd, gapUsd: totalUsd - assignedUsd, totalUsd };
}

// ── Prose extraction per residual window ──────────────────────────────────────

type ProseEvent = { ms: number; text: string };

function proseEvents(session: NormalizedSession): ProseEvent[] {
  const out: ProseEvent[] = [];
  for (const message of session.messages) {
    if (message.role === "system" || !message.text || !message.timestamp) {
      continue;
    }
    const ms = Date.parse(message.timestamp);
    if (Number.isFinite(ms)) {
      out.push({ ms, text: message.text });
    }
  }
  return out;
}

function proseInWindow(
  prose: readonly ProseEvent[],
  startMs: number,
  endMs: number
): string {
  const parts: string[] = [];
  let remaining = MAX_PROSE_SCAN_CHARS;
  for (const event of prose) {
    if (event.ms < startMs || event.ms >= endMs) {
      continue;
    }
    // Truncate the message to the remaining budget BEFORE appending, so a single
    // oversized corpus message can never balloon peak memory past the cap.
    const piece =
      event.text.length > remaining
        ? event.text.slice(0, remaining)
        : event.text;
    parts.push(piece);
    remaining -= piece.length + 1;
    if (remaining <= 0) {
      break;
    }
  }
  return parts.join("\n");
}

// ── Cohort derivation (session-level proxies; no DB) ──────────────────────────

/**
 * Cohort proxy: did the session call the ClosedLoop MCP server at all? Reuses the
 * canonical `isClosedloopMcpTool` SSOT (artifact-ref-extractor.ts), which matches
 * BOTH the Claude `mcp__closedloop__` name prefix AND Codex's separate
 * `mcpServer === "closedloop"` field. A bare name-prefix check silently drops
 * every Codex ClosedLoop session into the `external` cohort. Closed-set by
 * construction (per apps/desktop/AGENTS.md — never a `"closedloop"` substring
 * scan). Exported for the cohort-detection test.
 */
export function hasClosedloopSignal(session: NormalizedSession): boolean {
  return session.toolUses.some((tool) => isClosedloopMcpTool(tool));
}

/** Session-level autonomy proxy: agent-turn share (0 manual → 100 agentic). */
function autonomyIndex(session: NormalizedSession): number {
  const total = session.userMessages + session.assistantMessages;
  if (total <= 0) {
    return 0;
  }
  return (100 * session.assistantMessages) / total;
}

function deriveCohort(
  session: NormalizedSession,
  harness: Harness,
  runtimeMs: number
): SessionCohort {
  return {
    harness,
    autonomyBand: autonomyBandFor(autonomyIndex(session)),
    closedloopUser: hasClosedloopSignal(session),
    lengthBand: sessionLengthBandFor(runtimeMs),
  };
}

// ── Per-dossier → DistillSessionInput ─────────────────────────────────────────

function buildSessionInput(
  sessionId: string,
  dossierDir: string
): DistillSessionInput | null {
  const session = readSession(dossierDir);
  const harness = readHarness(dossierDir);
  if (!(session && harness)) {
    return null;
  }
  const bounds = deriveSessionBoundsMs(session);
  if (!bounds) {
    return null;
  }
  const segments = classifyActivitySegments(session, harness);
  if (segments.length === 0) {
    return null;
  }
  const { events } = priceTurns(session);
  const { perSegmentUsd, gapUsd } = attributeSpend(segments, events);
  const prose = proseEvents(session);

  const segmentInputs: DistillSegmentInput[] = segments.map((segment, i) => {
    const residual = isResidualSegment({
      phase: segment.phase,
      confidence: segment.confidence,
    });
    return {
      state: segment.phase,
      confidence: segment.confidence,
      spendUsd: perSegmentUsd[i],
      prose: residual
        ? proseInWindow(prose, segment.startMs, segment.endMs)
        : "",
    };
  });

  return {
    sessionId,
    cohort: deriveCohort(session, harness, bounds.endMs - bounds.startMs),
    segments: segmentInputs,
    gapSpendUsd: gapUsd,
  };
}

// ── Report rendering ──────────────────────────────────────────────────────────

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function coverageLine(
  label: string,
  before: CoverageCell,
  after: CoverageCell
): string {
  const delta = after.coverage - before.coverage;
  const flag = before.lowSample ? " _(low sample)_" : "";
  return `| ${label} | ${before.sessionCount} | ${pct(before.coverage)} | ${pct(after.coverage)} | ${delta >= 0 ? "+" : ""}${pct(delta)} |${flag}`;
}

function renderCohortAxis(
  axis: CohortAxis,
  before: CoverageResult,
  after: CoverageResult
): string {
  const beforeCells = before.byCohort[axis];
  const afterCells = after.byCohort[axis];
  const lines = [
    `#### Cohort: ${axis}`,
    "",
    "| bucket | sessions | coverage before | coverage after | Δ |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const key of Object.keys(beforeCells).sort()) {
    lines.push(coverageLine(key, beforeCells[key], afterCells[key]));
  }
  return lines.join("\n");
}

function renderRules(report: DistillationReport): string {
  if (report.proposedRules.length === 0) {
    return "_No residual prose matched any linguistic rule._";
  }
  const lines = [
    "| rule | phase | sessions | segments | residual spend | % of residual |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const rule of report.proposedRules) {
    const share =
      report.residualSpendUsd > 0
        ? rule.residualSpendUsd / report.residualSpendUsd
        : 0;
    lines.push(
      `| \`${rule.ruleId}\` | ${rule.phase} | ${rule.sessions} | ${rule.segments} | ${usd(rule.residualSpendUsd)} | ${pct(share)} |`
    );
  }
  return lines.join("\n");
}

/** The durable follow-up recommendation — the decision this measurement must feed. */
function renderRecommendation(report: DistillationReport): string {
  const upliftPts = report.overallCoverageUplift * 100;
  const matchedShare =
    report.residualSpendUsd > 0
      ? report.matchedResidualSpendUsd / report.residualSpendUsd
      : 0;
  const broad = report.proposedRules.filter((r) => r.sessions >= 3);
  const lines = [
    "## Recommended follow-up (decision required — do not lose this)",
    "",
    `- **Headline:** promoting every matched natural-language signature would raise overall coverage by at most **${upliftPts.toFixed(1)} percentage points** (${pct(report.before.overall.coverage)} → ${pct(report.after.overall.coverage)}). ${pct(matchedShare)} of residual spend is linguistically recognizable.`,
  ];
  if (upliftPts < 2) {
    lines.push(
      "- **Assessment:** the deterministic FEA-2269 classifier already claims the large majority of spend; the residual is small and only partly recognizable. A runtime linguistic fallback (privacy surface, model cost, per-session bounds) is **not justified by this corpus**. Recommend keeping the layer offline-only and revisiting if coverage floors are missed for a specific cohort as the corpus grows."
    );
  } else {
    lines.push(
      "- **Assessment:** residual spend is materially recognizable. Recommend evaluating promotion of the broadest-support rules below into FEA-2269's deterministic scorer (a version bump + backfill), gated on a distinguishing STRUCTURAL co-signal to avoid over-fitting."
    );
  }
  if (broad.length > 0) {
    const ids = broad
      .map((r) => `\`${r.ruleId}\` (${r.sessions} sessions)`)
      .join(", ");
    lines.push(
      `- **Candidate rules for promotion** (fired in ≥3 sessions — enough breadth to not be a single-session artifact): ${ids}. Each still needs (a) a co-occurring structural signal in FEA-2269 and (b) ground-truth validation before it changes the shipped classifier.`
    );
  } else {
    lines.push(
      "- **Candidate rules for promotion:** none fired in ≥3 sessions. Every matched rule is currently a low-breadth (possibly over-fitted) signal; none should be promoted into the deterministic classifier on this evidence alone."
    );
  }
  lines.push(
    "- **Hard caveat:** the corpus has no per-segment activity ground-truth, so these are UPPER-BOUND, recognizability-only numbers. Do not promote any rule, or build the opt-in runtime fallback, without ground-truth validation (a labeled corpus — an FEA-2266 follow-up) confirming the relabels are correct."
  );
  return lines.join("\n");
}

function renderMeta(versions: ReportMeta): string {
  return [
    "## Provenance / versions",
    "",
    "These numbers are only comparable across runs that share the versions below;",
    "a bump to any of them (or the rule set) marks this report stale.",
    "",
    `- report schema: v${versions.reportSchemaVersion}`,
    `- activity classifier: v${versions.activityClassifierVersion} (FEA-2269)`,
    `- evidence model: v${versions.evidenceModelVersion} (FEA-2268)`,
    `- attribution metric: v${versions.attributionMetricVersion} (FEA-2266)`,
    `- taxonomy: v${versions.taxonomyVersion} (Q-001)`,
    `- linguistic rule set: ${versions.ruleIds.join(", ")} (hash ${versions.ruleSetHash})`,
  ].join("\n");
}

function renderReport(
  report: DistillationReport,
  corpus: { dossiers: number; skipped: number },
  versions: ReportMeta
): string {
  const matchedShare =
    report.residualSpendUsd > 0
      ? report.matchedResidualSpendUsd / report.residualSpendUsd
      : 0;
  const sections = [
    "# Linguistic-distillation report (FEA-2274, PRD-488 Phase 3)",
    "",
    "> Generated by `apps/desktop/test/golden/derive-linguistic-distillation.ts`.",
    "> Reproducible from the frozen golden corpus + pinned genai-prices; re-run to refresh.",
    "> **Offline-only measurement (Q-002).** Nothing here ships to users. The shipped",
    "> FEA-2269 classifier is unchanged; `ACTIVITY_CLASSIFIER_VERSION` is not bumped.",
    "",
    "## What this measures",
    "",
    "How much of the spend the deterministic classifier left as residual",
    "(`other`/below the Q-003 confident floor) carries a recognizable natural-language",
    "signature — expressed as a coverage uplift via the FEA-2266 Coverage SSOT, as an",
    "**honest upper bound** (assumes every matched relabel is correct; the corpus has",
    "no per-segment ground truth).",
    "",
    renderMeta(versions),
    "",
    "## Corpus",
    "",
    `- Dossiers scanned: **${corpus.dossiers}** (skipped ${corpus.skipped} without a usable session/harness/timeline).`,
    `- Sessions measured: **${report.sessionCount}**; segments: ${report.segmentCount}; residual segments: ${report.residualSegmentCount}.`,
    `- Total spend: **${usd(report.totalSpendUsd)}**; residual spend: **${usd(report.residualSpendUsd)}** (${pct(report.residualSpendUsd / (report.totalSpendUsd || 1))} of total).`,
    `- Residual spend that is linguistically recognizable: **${usd(report.matchedResidualSpendUsd)}** (${pct(matchedShare)} of residual).`,
    "",
    "## Overall coverage",
    "",
    "| scope | sessions | coverage before | coverage after | Δ |",
    "| --- | --- | --- | --- | --- |",
    coverageLine("overall", report.before.overall, report.after.overall),
    "",
    "## Proposed linguistic rules (by residual spend captured)",
    "",
    renderRules(report),
    "",
    "## Coverage by cohort",
    "",
    ...COHORT_AXIS_VALUES.map(
      (axis) => `${renderCohortAxis(axis, report.before, report.after)}\n`
    ),
    renderRecommendation(report),
    "",
  ];
  return sections.join("\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
  const dossiers = listDossierDirs(CORPUS_ROOT);
  const inputs: DistillSessionInput[] = [];
  let skipped = 0;
  for (const dossier of dossiers) {
    const input = buildSessionInput(dossier.sessionId, dossier.dir);
    if (input) {
      inputs.push(input);
    } else {
      skipped += 1;
    }
  }
  const report = buildDistillationReport(inputs);
  const versions = buildReportMeta();
  writeFileSync(
    REPORT_JSON,
    `${JSON.stringify({ meta: versions, ...report }, null, 2)}\n`
  );
  writeFileSync(
    REPORT_MD,
    renderReport(report, { dossiers: dossiers.length, skipped }, versions)
  );
  process.stdout.write(
    `linguistic-distillation: ${report.sessionCount} sessions, ` +
      `residual ${usd(report.residualSpendUsd)}, ` +
      `uplift ${(report.overallCoverageUplift * 100).toFixed(1)}pts → ${REPORT_MD}\n`
  );
}

// Run only when invoked directly (`tsx …/derive-linguistic-distillation.ts`), so a
// test can import this module's pure helpers without triggering the derivation.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
