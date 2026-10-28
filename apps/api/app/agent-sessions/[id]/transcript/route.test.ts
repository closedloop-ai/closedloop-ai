import {
  type TranscriptAccessResponse,
  TranscriptAvailability,
} from "@repo/api/src/types/desktop-transcripts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../../../../__tests__/utils/auth-helpers";

let mockAuthContext: AuthContext;

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    async (request: unknown, context: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, context.params),
}));

vi.mock("../../transcript-read-service", () => ({
  transcriptReadService: { findTranscriptAccess: vi.fn() },
}));

import { transcriptReadService } from "../../transcript-read-service";
import { GET } from "./route";

const SESSION_ID = "01997d8e-3b2e-7c6a-8f1a-1b2c3d4e5f60";
const NOT_A_UUID = "not-a-uuid";

function getAs(id: string, search = "") {
  return GET(
    createMockRequest({
      url: `http://localhost:3002/agent-sessions/${id}/transcript${search}`,
    }),
    createMockRouteContext({ id })
  );
}

function accessResponse(): TranscriptAccessResponse {
  return {
    sessionId: SESSION_ID,
    files: [
      {
        fileKey: "main",
        availability: TranscriptAvailability.Available,
        url: "https://s3/main",
        byteSize: 1024,
        rawSha256: "a".repeat(64),
        uploadedAt: "2026-07-08T12:00:00.000Z",
        lastObservedAt: "2026-07-08T12:00:00.000Z",
        permanentFailureReason: null,
      },
    ],
  };
}

describe("GET /agent-sessions/[id]/transcript", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
    vi.mocked(transcriptReadService.findTranscriptAccess).mockResolvedValue(
      accessResponse()
    );
  });

  it("returns transcript descriptors for an authorized caller", async () => {
    const response = await getAs(SESSION_ID);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: accessResponse(),
    });
    expect(transcriptReadService.findTranscriptAccess).toHaveBeenCalledWith({
      id: SESSION_ID,
      organizationId: "test-org-id",
    });
  });

  // FEA-4155 (whitlockk review #3789): the transcript read dropped the winding-down
  // `DESKTOP_AGENT_SESSION_SYNC` monitoring gate in lockstep with the detail
  // route, so a transcript for an in-org session resolves for any caller and
  // never 403s as the flag winds down. Org-scoping still gates cross-org access
  // (the next case proves the 404-no-leak path, AC10).
  it("returns descriptors without a monitoring-flag gate (FEA-4155)", async () => {
    const response = await getAs(SESSION_ID);

    expect(response.status).toBe(200);
    expect(transcriptReadService.findTranscriptAccess).toHaveBeenCalledWith({
      id: SESSION_ID,
      organizationId: "test-org-id",
    });
  });

  // ISS-10436: the transcript read looks the id up as `@db.Uuid`, so a
  // non-UUID id used to raise P2023 and fall out of `withAuth` as a 500.
  it("answers 404 for an id that is not a UUID, before the service is asked", async () => {
    const response = await getAs(NOT_A_UUID);

    expect(response.status).toBe(404);
    expect(transcriptReadService.findTranscriptAccess).not.toHaveBeenCalled();
  });

  it("hands a v7 UUID to the service unchanged", async () => {
    const response = await getAs(SESSION_ID);

    expect(response.status).toBe(200);
    expect(transcriptReadService.findTranscriptAccess).toHaveBeenCalledTimes(1);
    expect(transcriptReadService.findTranscriptAccess).toHaveBeenCalledWith({
      id: SESSION_ID,
      organizationId: "test-org-id",
    });
  });

  it("maps a session outside org scope to 404 (no content leak, AC10)", async () => {
    vi.mocked(transcriptReadService.findTranscriptAccess).mockResolvedValue(
      null
    );

    const response = await getAs(SESSION_ID);

    expect(response.status).toBe(404);
  });

  // ISS-12276: the client names the file it is about to read so only that
  // file's URL is presigned.
  it("forwards a requested fileKey to the service", async () => {
    const response = await getAs(SESSION_ID, "?fileKey=subagent%3Aabc");

    expect(response.status).toBe(200);
    expect(transcriptReadService.findTranscriptAccess).toHaveBeenCalledWith({
      id: SESSION_ID,
      organizationId: "test-org-id",
      fileKey: "subagent:abc",
    });
  });

  // ISS-12276 (version skew): a fileKey this server cannot parse degrades to
  // the unscoped read instead of refusing the request.
  it("drops a malformed fileKey instead of refusing the request", async () => {
    const response = await getAs(SESSION_ID, "?fileKey=subagent%3Aa%2Fb");

    expect(response.status).toBe(200);
    expect(transcriptReadService.findTranscriptAccess).toHaveBeenCalledWith({
      id: SESSION_ID,
      organizationId: "test-org-id",
    });
  });
});
