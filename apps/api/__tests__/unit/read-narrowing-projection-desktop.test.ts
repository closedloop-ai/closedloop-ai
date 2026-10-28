import { DesktopCommandStatus } from "@repo/api/src/types/compute-target";
import { TranscriptUploadStatus } from "@repo/api/src/types/desktop-transcripts";
import { DesktopDeviceSessionStatus } from "@repo/api/src/types/onboarding";
import { TranscriptSkipReason } from "@repo/api/src/types/transcript-skip-reason-constants";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const actual =
    await vi.importActual<typeof import("@repo/database")>("@repo/database");
  return {
    ...actual,
    withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  };
});

vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: { findOwnedById: vi.fn() },
}));

import {
  createModelDouble,
  type ModelDouble,
  type Row,
} from "@/__tests__/support/read-narrowing-projection.test-db";
import { computeTargetsService } from "@/app/compute-targets/service";
import { desktopAuthorizeService } from "@/app/desktop/authorize/service";
import { desktopDeviceOnboardingService } from "@/app/desktop/device-onboarding/service";
import { desktopOnboardingAttemptsService } from "@/app/desktop/onboarding-attempt/service";
import { desktopSessionService } from "@/app/desktop/session/service";
import { transcriptSyncService } from "@/app/desktop/transcripts/service";
import { TranscriptRateLimiter } from "@/app/desktop/transcripts/transcript-rate-limit";
import { hashToken } from "@/lib/auth/token-hash";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import {
  mockWithDbAll,
  mockWithDbCall,
  mockWithDbTx,
} from "../utils/db-helpers";

/**
 * Query narrowing for the desktop control plane (ISS-9188, ISS-9195).
 *
 * Mostly reads, plus the one WRITE whose RETURNING is itself a response body:
 * `approve`. It lives here rather than in a file of its own because the double
 * projects `update` through `select` exactly as it does a read, and the device
 * session fixture is shared — a second file would fork that fixture.
 *
 * Every case drives the production entry point against `createModelDouble`,
 * which projects the stored row through the query's `select` the way Postgres
 * does. That is what makes these assertions falsifiable: with a `select`
 * removed, the double hands back EVERY fixture column and the
 * `returnedColumns` expectation below fails. A characterization test written
 * against a plain `mockResolvedValue` would pass either way, because an
 * unselected read returns a superset and the mappers name their fields.
 *
 * Fixture rows therefore carry non-null values in the columns the production
 * code must NOT receive — a null and an absent column serialize identically, so
 * a null there would make the whole file unfalsifiable.
 */

const COMPUTE_TARGET_ID = "22222222-2222-4222-8222-222222222222";
const DEVICE_SESSION_ID = "33333333-3333-4333-8333-333333333333";
const COMMAND_ID = "44444444-4444-4444-8444-444444444444";
const SESSION_DETAIL_ID = "55555555-5555-4555-8555-555555555555";
const SHA256 = "a".repeat(64);
const DEVICE_SESSION_SECRET = "device-session-secret";
const AUTHORIZATION_CODE = "authorization-code";
const NOW = new Date("2026-01-01T00:00:00.000Z");

const DEVICE_SESSION_EXCHANGE_COLUMNS = [
  "id",
  "status",
  "expiresAt",
  "userId",
  "organizationId",
  "onboardingAttemptId",
  "gatewayId",
  "gatewayPublicKeyPem",
  "machineName",
  "platform",
  "desktopVersion",
];

const DEVICE_SESSION_CLAIM_COLUMNS = [
  "id",
  "status",
  "expiresAt",
  "webAppOrigin",
  "gatewayId",
];

const DEVICE_SESSION_APPROVAL_COLUMNS = [
  "status",
  "machineName",
  "platform",
  "webAppOrigin",
];

const DEVICE_SESSION_LOOKUP_COLUMNS = [
  "userCode",
  "machineName",
  "platform",
  "webAppOrigin",
  "status",
  "createdAt",
  "expiresAt",
];

const DEVICE_SESSION_POLL_COLUMNS = [
  "id",
  "status",
  "expiresAt",
  "onboardingAttemptId",
  "webAppOrigin",
];

const AUTHORIZATION_CODE_REDEEM_COLUMNS = [
  "id",
  "userId",
  "organizationId",
  "gatewayId",
  "boundPublicKey",
  "codeChallenge",
  "redirectUri",
  "expiresAt",
  "redeemedAt",
];

const ATTEMPT_STATUS_COLUMNS = [
  "attemptId",
  "expiresAt",
  "consumedAt",
  "computeTargetId",
  "gatewayId",
];

const TRANSCRIPT_SYNC_ROW_COLUMNS = [
  "id",
  "uploadStatus",
  "permanentFailureReason",
  "rawSha256",
  "storedEtag",
  "syncedByteOffset",
  "sessionDetailId",
  "pendingUploadId",
  "pendingUploadStartedAt",
];

const COMMAND_EVENT_COLUMNS = [
  "commandId",
  "sequence",
  "eventType",
  "eventPayload",
  "createdAt",
];

/** Every `desktop_onboarding_device_sessions` column, secrets included. */
function deviceSessionRow(overrides: Row = {}): Row {
  return {
    id: DEVICE_SESSION_ID,
    deviceSessionSecretHash: hashToken(DEVICE_SESSION_SECRET),
    userCode: "ABCD1234",
    requestIpHash: "hash-of-the-request-ip",
    webAppOrigin: "https://app.example.com",
    gatewayId: "gateway-1",
    gatewayPublicKeyPem: "-----BEGIN PUBLIC KEY-----",
    machineName: "laptop",
    platform: "darwin",
    desktopVersion: "1.2.3",
    desktopSecurityUpgradeProtocolVersion: 1,
    status: DesktopDeviceSessionStatus.Pending,
    userId: null,
    organizationId: null,
    onboardingAttemptId: null,
    deniedAt: null,
    approvedAt: null,
    expiresAt: new Date("2026-01-01T01:00:00.000Z"),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

/** Every `desktop_authorization_codes` column, the code hash included. */
function authorizationCodeRow(overrides: Row = {}): Row {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    codeHash: hashToken(AUTHORIZATION_CODE),
    userId: "77777777-7777-4777-8777-777777777777",
    organizationId: "88888888-8888-4888-8888-888888888888",
    gatewayId: "gateway-1",
    boundPublicKey: "-----BEGIN PUBLIC KEY-----",
    codeChallenge: "challenge",
    redirectUri: "http://127.0.0.1:1234/callback",
    expiresAt: new Date("2026-01-01T00:00:30.000Z"),
    redeemedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

/** Every `desktop_onboarding_attempts` column. */
function onboardingAttemptRow(overrides: Row = {}): Row {
  return {
    attemptId: "attempt-1",
    userId: "77777777-7777-4777-8777-777777777777",
    organizationId: "88888888-8888-4888-8888-888888888888",
    webAppOrigin: "https://app.example.com",
    expiresAt: new Date("2026-01-01T01:00:00.000Z"),
    consumedAt: null,
    flowType: "desktop_first_connect",
    computeTargetId: COMPUTE_TARGET_ID,
    gatewayId: null,
    ...overrides,
  };
}

/** Every `session_transcripts` column. */
function transcriptRow(overrides: Row = {}): Row {
  return {
    id: "99999999-9999-4999-8999-999999999999",
    organizationId: "88888888-8888-4888-8888-888888888888",
    computeTargetId: COMPUTE_TARGET_ID,
    externalSessionId: "ext-session-1",
    sessionDetailId: SESSION_DETAIL_ID,
    sourceHarness: "claude",
    fileKey: "transcript.jsonl",
    objectStorageKey: "org/target/session/transcript.jsonl",
    uploadStatus: TranscriptUploadStatus.Uploaded,
    permanentFailureReason: null,
    rawSha256: SHA256,
    crc64nvme: "crc",
    rawByteSize: 128n,
    storedEtag: "etag-1",
    syncedByteOffset: 128n,
    sourceMtime: new Date("2026-01-01T00:00:00.000Z"),
    sourcePathHash: "path-hash",
    pendingUploadId: null,
    pendingUploadStartedAt: null,
    firstSeenAt: new Date("2026-01-01T00:00:00.000Z"),
    lastObservedAt: new Date("2026-01-01T00:00:00.000Z"),
    uploadedAt: new Date("2026-01-01T00:00:00.000Z"),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

const TRANSCRIPT_IDENTITY = {
  computeTargetId: COMPUTE_TARGET_ID,
  externalSessionId: "ext-session-1",
  fileKey: "transcript.jsonl",
};

const TRANSCRIPT_AUTH = {
  organizationId: "88888888-8888-4888-8888-888888888888",
  userId: "77777777-7777-4777-8777-777777777777",
  clerkUserId: "user_clerk_1",
};

/** Deps that let the shared transcript front door admit a request. */
function transcriptDeps() {
  return {
    now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    // A fresh limiter per call, so the shared module-level instance's window
    // cannot leak between cases and reject a later one.
    rateLimiter: new TranscriptRateLimiter(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.mocked(computeTargetsService.findOwnedById).mockResolvedValue({
    id: COMPUTE_TARGET_ID,
  } as Awaited<ReturnType<typeof computeTargetsService.findOwnedById>>);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("desktop onboarding + session credential reads", () => {
  it("exchange reads only the columns it validates and binds, never the device-session secret hash", async () => {
    const desktopOnboardingDeviceSession = createModelDouble([
      // Approved but expired, so `exchange` rejects right after the read — the
      // narrowing is what this asserts, not the credential issuance path.
      deviceSessionRow({
        status: DesktopDeviceSessionStatus.Approved,
        expiresAt: new Date("2020-01-01T00:00:00.000Z"),
      }),
    ]);
    mockWithDbAll({ desktopOnboardingDeviceSession });

    const result = await desktopSessionService.exchange({
      deviceSessionId: DEVICE_SESSION_ID,
      deviceSessionSecret: DEVICE_SESSION_SECRET,
      request: new Request("https://api.example.com/desktop/session/exchange"),
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(result.ok).toBe(false);
    expect(desktopOnboardingDeviceSession.returnedColumns).toEqual([
      DEVICE_SESSION_EXCHANGE_COLUMNS,
    ]);
  });

  it("approve claims on five columns and RETURNS only the four the approval page renders, never the secret hash", async () => {
    const desktopOnboardingDeviceSession = createModelDouble([
      deviceSessionRow(),
    ]);
    mockWithDbTx({ desktopOnboardingDeviceSession });
    mockWithDbCall({
      desktopOnboardingAttempt: {
        create: vi.fn().mockResolvedValue({ attemptId: "attempt-1" }),
      },
    });

    const approved = await desktopDeviceOnboardingService.approve({
      userCode: "ABCD1234",
      userId: "77777777-7777-4777-8777-777777777777",
      organizationId: "88888888-8888-4888-8888-888888888888",
    });

    // ISS-9195: asserted on the resolved row, not only on `returnedColumns`,
    // because this row IS the approve route's response body — the double
    // projects it exactly as `RETURNING` does, so an unnarrowed write hands
    // back every fixture column and both expectations below fail.
    expect(approved).toEqual({
      status: DesktopDeviceSessionStatus.Approved,
      machineName: "laptop",
      platform: "darwin",
      webAppOrigin: "https://app.example.com",
    });
    expect(desktopOnboardingDeviceSession.returnedColumns).toEqual([
      DEVICE_SESSION_CLAIM_COLUMNS,
      DEVICE_SESSION_APPROVAL_COLUMNS,
    ]);
  });

  it("deny claims the row and reads back only the seven lookup columns, never the secret hash", async () => {
    const desktopOnboardingDeviceSession = createModelDouble([
      deviceSessionRow(),
    ]);
    mockWithDbAll({ desktopOnboardingDeviceSession });

    const denied = await desktopDeviceOnboardingService.deny({
      userCode: "ABCD1234",
      userId: "77777777-7777-4777-8777-777777777777",
      organizationId: "88888888-8888-4888-8888-888888888888",
    });

    // ISS-9268: asserted on the resolved row, not only on `returnedColumns`,
    // because this row IS what `deny` hands the approve route. The double
    // projects it exactly as Postgres does, so with the `select` removed the
    // whole 20-column fixture comes back and both expectations below fail.
    expect(denied).toEqual({
      userCode: "ABCD1234",
      machineName: "laptop",
      platform: "darwin",
      webAppOrigin: "https://app.example.com",
      status: DesktopDeviceSessionStatus.Denied,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      expiresAt: new Date("2026-01-01T01:00:00.000Z"),
    });
    // `updateMany` returns a count alone, so the lookup is the only read here.
    expect(desktopOnboardingDeviceSession.returnedColumns).toEqual([
      DEVICE_SESSION_LOOKUP_COLUMNS,
    ]);
  });

  it("the session lookup reads only the columns the browser approval page renders", async () => {
    const desktopOnboardingDeviceSession = createModelDouble([
      deviceSessionRow(),
    ]);
    mockWithDbAll({ desktopOnboardingDeviceSession });

    const row = await desktopDeviceOnboardingService.getByUserCode("ABCD1234");

    expect(row).toEqual({
      userCode: "ABCD1234",
      machineName: "laptop",
      platform: "darwin",
      webAppOrigin: "https://app.example.com",
      status: DesktopDeviceSessionStatus.Pending,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      expiresAt: new Date("2026-01-01T01:00:00.000Z"),
    });
    expect(desktopOnboardingDeviceSession.returnedColumns).toEqual([
      DEVICE_SESSION_LOOKUP_COLUMNS,
    ]);
  });

  it("poll reads only the columns its status answer is folded from", async () => {
    const desktopOnboardingDeviceSession = createModelDouble([
      deviceSessionRow({
        status: DesktopDeviceSessionStatus.Approved,
        onboardingAttemptId: "attempt-1",
        expiresAt: new Date("2026-01-01T01:00:00.000Z"),
      }),
    ]);
    mockWithDbAll({ desktopOnboardingDeviceSession });

    const polled = await desktopDeviceOnboardingService.poll({
      deviceSessionId: DEVICE_SESSION_ID,
      deviceSessionSecret: DEVICE_SESSION_SECRET,
    });

    expect(polled).toEqual({
      status: DesktopDeviceSessionStatus.Approved,
      onboardingAttemptId: "attempt-1",
      webAppOrigin: "https://app.example.com",
      expiresAt: "2026-01-01T01:00:00.000Z",
    });
    expect(desktopOnboardingDeviceSession.returnedColumns).toEqual([
      DEVICE_SESSION_POLL_COLUMNS,
    ]);
  });

  it("redeem reads only the bindings it verifies, never the stored code hash", async () => {
    const desktopAuthorizationCode = createModelDouble([
      // Already redeemed, so `redeem` rejects immediately after the read.
      authorizationCodeRow({
        redeemedAt: new Date("2026-01-01T00:00:10.000Z"),
      }),
    ]);
    mockWithDbAll({ desktopAuthorizationCode });

    const result = await desktopAuthorizeService.redeem({
      code: AUTHORIZATION_CODE,
      codeVerifier: "verifier",
      gatewayId: "gateway-1",
      redirectUri: "http://127.0.0.1:1234/callback",
      request: new Request("https://api.example.com/desktop/authorize/token"),
      now: new Date("2026-01-01T00:00:20.000Z"),
    });

    expect(result.ok).toBe(false);
    expect(desktopAuthorizationCode.returnedColumns).toEqual([
      AUTHORIZATION_CODE_REDEEM_COLUMNS,
    ]);
  });

  it("getStatus reads only the five columns its provisioning answer is built from", async () => {
    const desktopOnboardingAttempt = createModelDouble([
      onboardingAttemptRow(),
    ]);
    mockWithDbAll({ desktopOnboardingAttempt });

    const status = await desktopOnboardingAttemptsService.getStatus(
      "attempt-1",
      "88888888-8888-4888-8888-888888888888",
      "77777777-7777-4777-8777-777777777777"
    );

    expect(status).toEqual({
      onboardingAttemptId: "attempt-1",
      expiresAt: "2026-01-01T01:00:00.000Z",
      computeTargetId: COMPUTE_TARGET_ID,
      status: "pending",
    });
    expect(desktopOnboardingAttempt.returnedColumns).toEqual([
      ATTEMPT_STATUS_COLUMNS,
    ]);
  });
});

describe("transcript sync reads", () => {
  it("the plan fast path reads only the sync columns", async () => {
    const sessionTranscript = createModelDouble([transcriptRow()]);
    mockWithDbCall({ sessionTranscript });

    const result = await transcriptSyncService.planSync({
      ...TRANSCRIPT_AUTH,
      request: {
        ...TRANSCRIPT_IDENTITY,
        sourceHarness: "claude",
        sourcePathHash: "path-hash",
        planEndOffset: 128,
        sha256: SHA256,
        crc64nvme: "crc",
        sourceMtime: undefined,
      },
      deps: transcriptDeps(),
    });

    expect(result).toEqual({
      ok: true,
      value: { mode: "noop", syncedByteOffset: 128, storedEtag: "etag-1" },
    });
    expect(sessionTranscript.returnedColumns).toEqual([
      TRANSCRIPT_SYNC_ROW_COLUMNS,
    ]);
  });

  it("the plan transaction read is narrowed too", async () => {
    // The pooled fast-path read sees no row, so the transaction read is the one
    // under assertion. Two doubles, because they are two different clients.
    mockWithDbCall({ sessionTranscript: createModelDouble([]) });
    const sessionTranscript = createModelDouble([transcriptRow()]);
    mockWithDbTx({ sessionTranscript });

    const result = await transcriptSyncService.planSync({
      ...TRANSCRIPT_AUTH,
      request: {
        ...TRANSCRIPT_IDENTITY,
        sourceHarness: "claude",
        sourcePathHash: "path-hash",
        planEndOffset: 128,
        sha256: SHA256,
        crc64nvme: "crc",
        sourceMtime: undefined,
      },
      deps: transcriptDeps(),
    });

    expect(result).toEqual({
      ok: true,
      value: { mode: "noop", syncedByteOffset: 128, storedEtag: "etag-1" },
    });
    expect(sessionTranscript.returnedColumns).toEqual([
      TRANSCRIPT_SYNC_ROW_COLUMNS,
    ]);
  });

  it("the idempotent complete read is narrowed", async () => {
    const sessionTranscript = createModelDouble([transcriptRow()]);
    mockWithDbTx({ sessionTranscript });

    const result = await transcriptSyncService.complete({
      ...TRANSCRIPT_AUTH,
      request: {
        ...TRANSCRIPT_IDENTITY,
        mode: "fullPut",
        planEndOffset: 128,
        sha256: SHA256,
        crc64nvme: "crc",
      },
      deps: transcriptDeps(),
    });

    expect(result).toEqual({
      ok: true,
      value: {
        status: TranscriptUploadStatus.Uploaded,
        syncedByteOffset: 128,
        storedEtag: "etag-1",
        sessionDetailId: SESSION_DETAIL_ID,
      },
    });
    expect(sessionTranscript.returnedColumns).toEqual([
      TRANSCRIPT_SYNC_ROW_COLUMNS,
    ]);
  });

  it("the skip read is narrowed", async () => {
    const sessionTranscript = createModelDouble([transcriptRow()]);
    mockWithDbTx({ sessionTranscript });

    const result = await transcriptSyncService.markPermanentlySkipped({
      ...TRANSCRIPT_AUTH,
      request: {
        ...TRANSCRIPT_IDENTITY,
        sourceHarness: "claude",
        reason: TranscriptSkipReason.TooLarge,
      },
      deps: transcriptDeps(),
    });

    expect(result).toEqual({
      ok: true,
      value: {
        status: TranscriptUploadStatus.Uploaded,
        permanentFailureReason: TranscriptSkipReason.TooLarge,
        sessionDetailId: SESSION_DETAIL_ID,
      },
    });
    expect(sessionTranscript.returnedColumns).toEqual([
      TRANSCRIPT_SYNC_ROW_COLUMNS,
    ]);
  });
});

describe("desktop command event reads", () => {
  it("getCommandEvents pins its RETURNING list to the five columns the wire mapper reads", async () => {
    const desktopCommandEvent: ModelDouble = createModelDouble([
      {
        commandId: COMMAND_ID,
        sequence: 1,
        eventType: "chunk",
        eventPayload: { text: "hello" },
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);
    mockWithDbCall({
      desktopCommand: {
        findFirst: vi.fn().mockResolvedValue({
          id: COMMAND_ID,
          computeTargetId: COMPUTE_TARGET_ID,
          operationId: "op-1",
          status: DesktopCommandStatus.Running,
          requestPayload: { operationId: "op-1", method: "POST", path: "/x" },
          error: null,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          startedAt: null,
          finishedAt: null,
          lastSequenceAcked: 0,
          idempotencyKey: null,
          requestFingerprint: "fp",
        }),
      },
      desktopCommandEvent,
      $queryRaw: vi.fn().mockResolvedValue([{ sequence: 1, bytes: 16 }]),
    });

    const events = await desktopCommandStore.getCommandEvents(
      COMPUTE_TARGET_ID,
      COMMAND_ID
    );

    expect(events).toEqual([
      {
        commandId: COMMAND_ID,
        sequence: 1,
        eventType: "chunk",
        data: { text: "hello" },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    expect(desktopCommandEvent.returnedColumns).toEqual([
      COMMAND_EVENT_COLUMNS,
    ]);
  });
});
