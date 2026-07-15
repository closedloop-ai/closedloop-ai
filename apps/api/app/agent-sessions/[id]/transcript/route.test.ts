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

vi.mock("../../route-helpers", () => ({
  getAgentSessionViewerScope: vi.fn(),
}));

vi.mock("../../transcript-read-service", () => ({
  transcriptReadService: { findTranscriptAccess: vi.fn() },
}));

import { getAgentSessionViewerScope } from "../../route-helpers";
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
      },
    ],
  };
}

describe("GET /agent-sessions/[id]/transcript", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
    vi.mocked(getAgentSessionViewerScope).mockResolvedValue({
      monitoringEnabled: true,
    });
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

  it("blocks when monitoring is disabled", async () => {
    vi.mocked(getAgentSessionViewerScope).mockResolvedValue({
      monitoringEnabled: false,
    });

    const response = await GET(
      createMockRequest({
        url: `http://localhost:3002/agent-sessions/${SESSION_ID}/transcript`,
      }),
      createMockRouteContext({ id: SESSION_ID })
    );

    expect(response.status).toBe(403);
    expect(transcriptReadService.findTranscriptAccess).not.toHaveBeenCalled();
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
