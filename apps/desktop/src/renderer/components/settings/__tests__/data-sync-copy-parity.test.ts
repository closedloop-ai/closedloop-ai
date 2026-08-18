import {
  DATA_SYNC_LEVEL_COPY,
  DataSyncLevelValue,
  DEFAULT_DATA_SYNC_LEVEL_VALUE,
  ELEVATED_DATA_SYNC_LEVEL_VALUE,
} from "@repo/app/shared/lib/data-sync-copy";
import { describe, expect, it } from "vitest";
import { DataSyncLevel } from "../../../../shared/contracts";
import {
  DATA_SYNC_LEVELS,
  DEFAULT_DATA_SYNC_LEVEL,
  dataSyncLevelToBooleans,
  ELEVATED_DATA_SYNC_LEVEL,
} from "../../../../shared/data-sync-level";

// FEA-4055: the shared per-level copy (@repo/app/shared/lib/data-sync-copy) is
// the ONE source both the desktop Settings "Data & Sync" tab and the onboarding
// sync-consent step render from. This renderer test — which, unlike the desktop
// `node:test` slice, CAN import the shared TSX-adjacent module — pins that copy
// against the desktop's value logic (`dataSyncLevelToBooleans`), so the labels
// can never claim more egress than the level actually performs. It replaces the
// copy-honesty assertions that used to live in `test/data-sync-level.test.ts`
// before the copy moved.

// A synced CONTENT line claims that a class of session *content* (tool
// inputs/outputs, file contents, prompts, completions, or full transcripts)
// leaves the device — as opposed to session-shape metadata (timing, cost,
// tool-call names/counts), which the metadata lane legitimately syncs. Content
// only leaves when the transcript lane is on.
const SYNCED_CONTENT_LABEL_RE =
  /tool inputs|file contents|prompts|completions|transcript/i;
const METADATA_ONLY_CAVEAT_RE = /metadata only/i;

describe("shared data-sync copy parity with desktop level logic", () => {
  it("mirrors the canonical DataSyncLevel value set and default/elevated anchors", () => {
    // The shared value strings must match the desktop const 1:1 — a divergence
    // would silently desync onboarding's payload from the setter's contract.
    expect(Object.values(DataSyncLevelValue).toSorted()).toEqual(
      Object.values(DataSyncLevel).toSorted()
    );
    expect(DEFAULT_DATA_SYNC_LEVEL_VALUE).toBe(DEFAULT_DATA_SYNC_LEVEL);
    expect(ELEVATED_DATA_SYNC_LEVEL_VALUE).toBe(ELEVATED_DATA_SYNC_LEVEL);
  });

  it("has copy for every level and no orphan keys", () => {
    for (const level of DATA_SYNC_LEVELS) {
      expect(DATA_SYNC_LEVEL_COPY[level]).toBeDefined();
    }
    expect(Object.keys(DATA_SYNC_LEVEL_COPY).toSorted()).toEqual(
      [...DATA_SYNC_LEVELS].toSorted()
    );
  });

  it("never advertises synced session content while the transcript lane is off", () => {
    for (const level of DATA_SYNC_LEVELS) {
      const booleans = dataSyncLevelToBooleans(level);
      const hasSyncedContentLine = DATA_SYNC_LEVEL_COPY[level].dataLines.some(
        (line) =>
          line.kind === "sync" && SYNCED_CONTENT_LABEL_RE.test(line.label)
      );
      if (!booleans.transcriptSyncEnabled) {
        expect(
          hasSyncedContentLine,
          `${level} must not advertise synced session content while transcriptSyncEnabled is false`
        ).toBe(false);
      }
    }
  });

  it("marks every line synced only when the level actually syncs (Off = all local)", () => {
    const offLines = DATA_SYNC_LEVEL_COPY[DataSyncLevelValue.Off].dataLines;
    expect(offLines.every((line) => line.kind === "local")).toBe(true);

    const fullLines = DATA_SYNC_LEVEL_COPY[DataSyncLevelValue.Full].dataLines;
    expect(fullLines.every((line) => line.kind === "sync")).toBe(true);
  });

  it("metadata syncs session-shape + tool-call activity but keeps content local", () => {
    const metadata =
      DATA_SYNC_LEVEL_COPY[DataSyncLevelValue.Metadata].dataLines;
    const synced = metadata
      .filter((line) => line.kind === "sync")
      .map((line) => line.label);
    const local = metadata
      .filter((line) => line.kind === "local")
      .map((line) => line.label);
    // Tool-call activity (eventType/toolName per-event rows) DOES leave in the
    // metadata lane; tool inputs/file contents and prompts/completions do NOT.
    expect(synced).toEqual([
      "Session shape, timing & cost",
      "Tool-call activity (names & counts)",
    ]);
    expect(local).toEqual([
      "Tool inputs & file contents",
      "Prompts & completions",
    ]);
  });

  it("Redacted advertises metadata-only egress today and flags redaction as forthcoming", () => {
    const redacted = DATA_SYNC_LEVEL_COPY[DataSyncLevelValue.Redacted];
    const syncedLabels = redacted.dataLines
      .filter((line) => line.kind === "sync")
      .map((line) => line.label);
    // The redaction lane is not plumbed, so redacted must sync no more than
    // metadata does today.
    expect(syncedLabels).toEqual([
      "Session shape, timing & cost",
      "Tool-call activity (names & counts)",
    ]);
    expect(
      redacted.caveat && METADATA_ONLY_CAVEAT_RE.test(redacted.caveat)
    ).toBeTruthy();
  });
});
