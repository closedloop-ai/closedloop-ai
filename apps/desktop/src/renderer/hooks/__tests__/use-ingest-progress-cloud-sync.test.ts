/**
 * @file use-ingest-progress-cloud-sync.test.ts
 * @description FEA-2733 — the renderer's projection of the main-process
 * cloud-sync snapshot (`parseCloudSync`) and its mapping to the compact
 * "History Sync" status label/tone (`describeCloudSyncStatus`). Both are pure,
 * so this runs on the renderer (jsdom/vitest) lane without any IPC or render.
 */
import { describe, expect, it } from "vitest";
import {
  type CloudSyncProgress,
  describeCloudSyncStatus,
  parseCloudSync,
} from "../use-ingest-progress";

const CAUGHT_UP: CloudSyncProgress = {
  identified: true,
  pendingBackfillSessions: 0,
  pendingIncrementalSessions: 0,
  backfilling: false,
  caughtUp: true,
  deadLetteredSessions: 0,
};

describe("parseCloudSync", () => {
  it("returns null when the payload is absent or has no cloudSync field", () => {
    // Before the first poll resolves, or on an older main process without the
    // field, the projection degrades to null → indicator hidden (not a
    // spurious "up to date").
    expect(parseCloudSync(null)).toBeNull();
    expect(parseCloudSync("nope")).toBeNull();
    expect(parseCloudSync({})).toBeNull();
    expect(parseCloudSync({ cloudSync: null })).toBeNull();
  });

  it("returns the cloud-sync projection verbatim for a well-formed snapshot", () => {
    const cloudSync = {
      identified: true,
      pendingBackfillSessions: 12,
      pendingIncrementalSessions: 3,
      backfilling: true,
      caughtUp: false,
      deadLetteredSessions: 1,
    };
    expect(parseCloudSync({ cloudSync })).toEqual(cloudSync);
  });
});

describe("describeCloudSyncStatus", () => {
  it("is a muted dash when there is no snapshot or no cloud identity", () => {
    expect(describeCloudSyncStatus(null)).toMatchObject({
      label: "—",
      tone: "muted",
    });
    expect(
      describeCloudSyncStatus({ ...CAUGHT_UP, identified: false })
    ).toMatchObject({ label: "—", tone: "muted" });
  });

  it("shows the backfill count while the first-connect walk drains", () => {
    const status = describeCloudSyncStatus({
      ...CAUGHT_UP,
      caughtUp: false,
      backfilling: true,
      pendingBackfillSessions: 42,
    });
    expect(status.tone).toBe("pending");
    expect(status.label).toBe("Syncing (42)");
    expect(status.detail).toBe("Syncing your history to the cloud");
  });

  it("tints the in-progress backfill label a warning when sessions are already dead-lettered", () => {
    // Review (mikeangstadt): a poison row on a long walk must not hide behind a
    // clean "Syncing (N)" until the terminal summary — surface it mid-backfill.
    const status = describeCloudSyncStatus({
      ...CAUGHT_UP,
      caughtUp: false,
      backfilling: true,
      pendingBackfillSessions: 42,
      deadLetteredSessions: 3,
    });
    expect(status.tone).toBe("warning");
    expect(status.label).toBe("Syncing (42)");
    expect(status.detail).toContain("3");
  });

  it("settles to 'Up to date' when caught up with no dead-letters", () => {
    expect(describeCloudSyncStatus(CAUGHT_UP)).toMatchObject({
      label: "Up to date",
      tone: "success",
    });
  });

  it("warns when caught up but some sessions were dead-lettered", () => {
    const status = describeCloudSyncStatus({
      ...CAUGHT_UP,
      deadLetteredSessions: 2,
    });
    expect(status.tone).toBe("warning");
    expect(status.label).toBe("Synced with issues");
    expect(status.detail).toContain("2");
  });

  it("shows an indeterminate 'Syncing…' while incremental changes drain", () => {
    expect(
      describeCloudSyncStatus({
        ...CAUGHT_UP,
        caughtUp: false,
        pendingIncrementalSessions: 5,
      })
    ).toMatchObject({ label: "Syncing…", tone: "pending" });
  });

  it("shows 'Checking…' in the brief pre-walk window (identified, nothing enumerated yet)", () => {
    expect(
      describeCloudSyncStatus({ ...CAUGHT_UP, caughtUp: false })
    ).toMatchObject({ label: "Checking…", tone: "muted" });
  });
});
