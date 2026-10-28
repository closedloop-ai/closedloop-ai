import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { Result } from "@repo/api/src/types/result";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const USER = {
  id: "33333333-3333-4333-8333-333333333333",
  organizationId: "44444444-4444-4444-8444-444444444444",
};

const mocks = vi.hoisted(() => ({
  batchMoveArtifacts: vi.fn(),
  captureBatchMoveActivity: vi.fn(),
  emitBatchMoveSideEffects: vi.fn(),
}));

const tx = {} as never;

vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withDb: Object.assign(vi.fn(), {
    tx: vi.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
  }),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest) =>
      handler({ user: USER, authMethod: "session" }, request),
}));

vi.mock("../service", () => ({
  artifactLinksService: { batchMoveArtifacts: mocks.batchMoveArtifacts },
}));

vi.mock("@/lib/batch-move-side-effects", () => ({
  captureBatchMoveActivity: mocks.captureBatchMoveActivity,
  emitBatchMoveSideEffects: mocks.emitBatchMoveSideEffects,
}));

import { POST } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.batchMoveArtifacts.mockResolvedValue(
    Result.ok({
      movedArtifacts: [SOURCE_ID],
      projectChanges: [
        { artifactId: SOURCE_ID, before: null, after: TARGET_PROJECT_ID },
      ],
    })
  );
});

describe("POST /artifact-links/batch-move provenance", () => {
  it("commits an unknown future surface with provenance omitted", async () => {
    const response = await POST(request("command_palette"), undefined as never);

    expect(response.status).toBe(200);
    expect(mocks.batchMoveArtifacts).toHaveBeenCalledTimes(1);
    expect(mocks.captureBatchMoveActivity).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ surface: undefined })
    );
    expect(mocks.emitBatchMoveSideEffects).toHaveBeenCalledWith(
      expect.objectContaining({ surface: undefined })
    );
  });

  it("preserves a known first-party bulk surface", async () => {
    const response = await POST(
      request(ArtifactStatusEditSurface.Bulk),
      undefined as never
    );

    expect(response.status).toBe(200);
    expect(mocks.captureBatchMoveActivity).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ surface: ArtifactStatusEditSurface.Bulk })
    );
    expect(mocks.emitBatchMoveSideEffects).toHaveBeenCalledWith(
      expect.objectContaining({ surface: ArtifactStatusEditSurface.Bulk })
    );
  });
});

function request(surface: string): NextRequest {
  return new NextRequest("http://localhost/artifact-links/batch-move", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      artifactId: SOURCE_ID,
      targetProjectId: TARGET_PROJECT_ID,
      includeDownstream: false,
      surface,
    }),
  });
}
