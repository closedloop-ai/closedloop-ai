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
  withAnyAuth: (handler: any) => async (request: any, context: any) =>
    handler(mockAuthContext, request, context.params),
}));

vi.mock("../../transcript-read-service", () => ({
  transcriptReadService: { findTranscriptAccess: vi.fn() },
}));

import { transcriptReadService } from "../../transcript-read-service";
import { GET } from "./route";

const SESSION_ID = "session-1";

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
    const response = await GET(
      createMockRequest({
        url: `http://localhost:3002/agent-sessions/${SESSION_ID}/transcript`,
      }),
      createMockRouteContext({ id: SESSION_ID })
    );

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

  // FEA-4155 (wongk review #3789): the transcript read dropped the winding-down
  // `DESKTOP_AGENT_SESSION_SYNC` monitoring gate in lockstep with the detail
  // route, so a transcript for an in-org session resolves for any caller and
  // never 403s as the flag winds down. Org-scoping still gates cross-org access
  // (the next case proves the 404-no-leak path, AC10).
  it("returns descriptors without a monitoring-flag gate (FEA-4155)", async () => {
    const response = await GET(
      createMockRequest({
        url: `http://localhost:3002/agent-sessions/${SESSION_ID}/transcript`,
      }),
      createMockRouteContext({ id: SESSION_ID })
    );

    expect(response.status).toBe(200);
    expect(transcriptReadService.findTranscriptAccess).toHaveBeenCalledWith({
      id: SESSION_ID,
      organizationId: "test-org-id",
    });
  });

  it("maps a session outside org scope to 404 (no content leak, AC10)", async () => {
    vi.mocked(transcriptReadService.findTranscriptAccess).mockResolvedValue(
      null
    );

    const response = await GET(
      createMockRequest({
        url: `http://localhost:3002/agent-sessions/${SESSION_ID}/transcript`,
      }),
      createMockRouteContext({ id: SESSION_ID })
    );

    expect(response.status).toBe(404);
  });
});
