/**
 * Tests for loopsService.ingestRunnerEvent replay handling.
 *
 * ingestRunnerEvent is the gatekeeper for runner-driven event ingestion: it
 * checks loop existence + terminal status and detects replays. It does NOT
 * persist the event — the orchestrator is the sole writer of the canonical
 * row (see Fix A from PR #1188 comment triage). Persistence is therefore
 * not asserted here; orchestrator threading is covered by sibling tests.
 *
 * Covers:
 * - Scenario 1: inserted path — returns ok+inserted without writing the
 *   canonical event row
 * - Scenario 2: replay path — composite eventId already present in
 *   LoopEvent table → returns ok=false/code=REPLAY without throwing
 * - Scenario 3: ignored / not-found paths
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  databaseModuleMock,
  type LoopsServiceHandles,
  resetLoopsServiceHandles,
} from "../fixtures/loops-service-mocks";

// --- Hoisted mocks ---

const handles = vi.hoisted<LoopsServiceHandles>(() => ({
  loopCreate: vi.fn(),
  loopCount: vi.fn(),
  loopFindFirst: vi.fn(),
  loopFindMany: vi.fn(),
  loopFindUnique: vi.fn(),
  loopUpdateMany: vi.fn(),
  loopEventCreate: vi.fn(),
  loopEventFindUnique: vi.fn(),
  orgFindUnique: vi.fn(),
  repoFindMany: vi.fn(),
}));

vi.mock("@repo/database", () => databaseModuleMock(handles));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// --- Imports (after mocks) ---

import { LoopStatus } from "@repo/api/src/types/loop";
import { IngestRunnerEventErrorCode } from "@/app/loops/loop-ingest-types";
import { loopsService } from "@/app/loops/service";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LOOP_ID = "loop-abc-123";
const ORG_ID = "org-xyz-456";
const TOKEN_JTI = "jti-runner-001";
const NONCE = "11111111-1111-4111-8111-111111111111";
const COMPOSITE_EVENT_ID = `${TOKEN_JTI}:${NONCE}`;

const baseEvent = {
  type: "output",
  data: {
    chunk: "hello world",
    timestamp: "2026-02-17T00:00:00.000Z",
  },
};

type LoopRow = "exists" | "null";
type ReplayRow = "none" | "found";

/**
 * Wire the DB mock for a scenario. `loop` selects the row returned by
 * `loop.findUnique`. `replay` selects whether a prior matching `LoopEvent`
 * row exists for the composite eventId.
 */
function setupScenario({
  loop = "exists",
  status = LoopStatus.Running,
  replay = "none",
}: {
  loop?: LoopRow;
  status?: string;
  replay?: ReplayRow;
} = {}): void {
  if (loop === "null") {
    handles.loopFindUnique.mockResolvedValue(null);
  } else {
    handles.loopFindUnique.mockResolvedValue({
      status,
      activeTokenJti: TOKEN_JTI,
      organizationId: ORG_ID,
    });
  }

  handles.loopEventFindUnique.mockResolvedValue(
    replay === "found" ? { id: "existing-evt" } : null
  );
}

beforeEach(() => {
  resetLoopsServiceHandles(handles);
});

// ---------------------------------------------------------------------------
// Scenario 1: inserted path
// ---------------------------------------------------------------------------

describe("ingestRunnerEvent — Scenario 1: inserted path", () => {
  it("returns ok+inserted and does NOT persist the event", async () => {
    setupScenario();

    const result = await loopsService.ingestRunnerEvent({
      loopId: LOOP_ID,
      tokenJti: TOKEN_JTI,
      nonce: NONCE,
      event: baseEvent,
      organizationId: ORG_ID,
    });

    expect(result).toEqual({
      ok: true,
      outcome: "inserted",
    });
    // Persistence is delegated to the orchestrator (Fix A).
    expect(handles.loopEventCreate).not.toHaveBeenCalled();
  });

  it("looks up the LoopEvent by the composite (loopId, eventSource, eventId) unique key", async () => {
    setupScenario();

    await loopsService.ingestRunnerEvent({
      loopId: LOOP_ID,
      tokenJti: TOKEN_JTI,
      nonce: NONCE,
      event: baseEvent,
      organizationId: ORG_ID,
    });

    expect(handles.loopEventFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          loopId_eventSource_eventId: {
            loopId: LOOP_ID,
            eventSource: "runner",
            eventId: COMPOSITE_EVENT_ID,
          },
        },
      })
    );
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: replay path
// ---------------------------------------------------------------------------

describe("ingestRunnerEvent — Scenario 2: replay path", () => {
  it("returns ok=false/code=REPLAY when a row with the composite eventId already exists", async () => {
    setupScenario({ replay: "found" });

    const result = await loopsService.ingestRunnerEvent({
      loopId: LOOP_ID,
      tokenJti: TOKEN_JTI,
      nonce: NONCE,
      event: baseEvent,
      organizationId: ORG_ID,
    });

    expect(result).toEqual({
      ok: false,
      code: IngestRunnerEventErrorCode.Replay,
    });
    expect(handles.loopEventCreate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: ignored / not-found paths
// ---------------------------------------------------------------------------

describe("ingestRunnerEvent — Scenario 3: ignored path (terminal loop)", () => {
  it.each([
    LoopStatus.Completed,
    LoopStatus.Failed,
    LoopStatus.Cancelled,
    LoopStatus.TimedOut,
  ])("returns ok+ignored without consulting LoopEvent when loop is %s", async (terminalStatus) => {
    setupScenario({ status: terminalStatus });

    const result = await loopsService.ingestRunnerEvent({
      loopId: LOOP_ID,
      tokenJti: TOKEN_JTI,
      nonce: NONCE,
      event: baseEvent,
      organizationId: ORG_ID,
    });

    expect(result).toEqual({
      ok: true,
      outcome: "ignored",
    });
    expect(handles.loopEventFindUnique).not.toHaveBeenCalled();
    expect(handles.loopEventCreate).not.toHaveBeenCalled();
  });

  it("returns ok=false/code=LOOP_NOT_FOUND when the loop does not exist", async () => {
    setupScenario({ loop: "null" });

    const result = await loopsService.ingestRunnerEvent({
      loopId: LOOP_ID,
      tokenJti: TOKEN_JTI,
      nonce: NONCE,
      event: baseEvent,
      organizationId: ORG_ID,
    });

    expect(result).toEqual({
      ok: false,
      code: IngestRunnerEventErrorCode.LoopNotFound,
    });
    expect(handles.loopEventFindUnique).not.toHaveBeenCalled();
    expect(handles.loopEventCreate).not.toHaveBeenCalled();
  });

  it.each([
    LoopStatus.Failed,
    LoopStatus.TimedOut,
  ])("proceeds to replay check for SupportBundleUploaded on %s loops (crash-recovery exemption)", async (terminalStatus) => {
    setupScenario({ status: terminalStatus });

    const supportBundleEvent = {
      type: "support_bundle_uploaded",
      data: {
        url: "https://example.com/bundle.zip",
        timestamp: "2026-02-17T00:00:00.000Z",
      },
    };

    const result = await loopsService.ingestRunnerEvent({
      loopId: LOOP_ID,
      tokenJti: TOKEN_JTI,
      nonce: NONCE,
      event: supportBundleEvent,
      organizationId: ORG_ID,
    });

    expect(result).toEqual({
      ok: true,
      outcome: "inserted",
    });
    expect(handles.loopEventFindUnique).toHaveBeenCalled();
    expect(handles.loopEventCreate).not.toHaveBeenCalled();
  });
});
