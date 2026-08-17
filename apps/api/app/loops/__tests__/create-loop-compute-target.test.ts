/**
 * ISS-5731 — `POST /loops` creates a Loop *record* and never dispatches, but it
 * used to drop `computeTargetId` on the floor: `CreateLoopRequest` declares the
 * field and `loopsService.create` writes it to the row, yet `createLoopValidator`
 * omitted it, so Zod stripped it and the caller got a 2xx describing a loop it
 * had not asked for.
 *
 * That silent drop is not cosmetic. `resolveProvider` keys entirely off
 * `computeTargetId`: with it the loop belongs to the desktop provider, whose
 * `ingestArtifacts` reads `loop.uploadedArtifacts`; without it the loop belongs
 * to the ECS provider, which ingests from S3 and returns early when there is no
 * `s3StateKey`. A caller pinning a machine therefore got a loop that silently
 * ingested nothing on completion.
 *
 * These tests pin both halves of the fix: the field survives to the service,
 * and the route enforces the same ownership rule `resolveComputeTarget` applies
 * to an explicit hint (org AND user — an org-only check would let one user pin
 * another's machine). They also pin the deliberate *absence* of an online-ness
 * requirement, which is a dispatch precondition this route must not inherit.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks (must come before imports) ---

let mockAuthContext: import("@/lib/auth/with-auth").AuthContext;

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => unknown) =>
    (request: unknown, context: { params?: unknown }) =>
      handler(mockAuthContext, request, context?.params),
}));

vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: { findOwnedById: vi.fn() },
}));

vi.mock("../service", async () => {
  const actual =
    await vi.importActual<typeof import("../service")>("../service");
  return {
    ...actual,
    loopsService: { ...actual.loopsService, create: vi.fn() },
  };
});

// Partial: `uuidOrSlug` is used by the validators module at import time.
vi.mock("@/lib/identifier-utils", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/identifier-utils")>();
  return {
    ...actual,
    resolveDocumentId: vi.fn(),
    resolveProjectId: vi.fn(),
  };
});

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  },
}));

// --- Imports (after mocks) ---

import { LoopStatus } from "@repo/api/src/types/loop";
import { computeTargetsService } from "@/app/compute-targets/service";
import { resolveDocumentId } from "@/lib/identifier-utils";
import { POST } from "../route";
import { loopsService } from "../service";

const ORGANIZATION_ID = "org-1";
const USER_ID = "user-1";
const DOCUMENT_ID = "11111111-1111-4111-8111-111111111111";
const COMPUTE_TARGET_ID = "22222222-2222-4222-8222-222222222222";
const LOOP_ID = "33333333-3333-4333-8333-333333333333";

function buildRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/loops", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function postLoop(body: Record<string, unknown>) {
  // biome-ignore lint/suspicious/noExplicitAny: route handler params shim
  const response = await (POST as any)(buildRequest(body), { params: {} });
  return { response, body: await response.json() };
}

describe("POST /loops computeTargetId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = {
      user: { id: USER_ID, organizationId: ORGANIZATION_ID },
      // biome-ignore lint/suspicious/noExplicitAny: partial auth context fixture
    } as any;
    vi.mocked(resolveDocumentId).mockResolvedValue(DOCUMENT_ID);
    vi.mocked(loopsService.create).mockResolvedValue({
      loopId: LOOP_ID,
      status: LoopStatus.Pending,
    });
  });

  it("passes an owned computeTargetId through to loopsService.create", async () => {
    vi.mocked(computeTargetsService.findOwnedById).mockResolvedValue(
      // biome-ignore lint/suspicious/noExplicitAny: partial compute target fixture
      { id: COMPUTE_TARGET_ID, isOnline: false } as any
    );

    const { response } = await postLoop({
      command: "EVALUATE_FEATURE",
      documentId: DOCUMENT_ID,
      computeTargetId: COMPUTE_TARGET_ID,
    });

    expect(response.status).toBe(200);
    expect(computeTargetsService.findOwnedById).toHaveBeenCalledWith(
      COMPUTE_TARGET_ID,
      ORGANIZATION_ID,
      USER_ID
    );
    // The whole point: the field reaches the service rather than being stripped.
    expect(loopsService.create).toHaveBeenCalledWith(
      ORGANIZATION_ID,
      USER_ID,
      expect.objectContaining({ computeTargetId: COMPUTE_TARGET_ID })
    );
  });

  it("accepts an offline target — this route creates a record, it does not dispatch", async () => {
    vi.mocked(computeTargetsService.findOwnedById).mockResolvedValue(
      // biome-ignore lint/suspicious/noExplicitAny: partial compute target fixture
      { id: COMPUTE_TARGET_ID, isOnline: false } as any
    );

    const { response } = await postLoop({
      command: "EVALUATE_FEATURE",
      documentId: DOCUMENT_ID,
      computeTargetId: COMPUTE_TARGET_ID,
    });

    expect(response.status).toBe(200);
    expect(loopsService.create).toHaveBeenCalled();
  });

  it("404s and creates nothing when the target is not owned by this user/org", async () => {
    vi.mocked(computeTargetsService.findOwnedById).mockResolvedValue(null);

    const { response } = await postLoop({
      command: "EVALUATE_FEATURE",
      documentId: DOCUMENT_ID,
      computeTargetId: COMPUTE_TARGET_ID,
    });

    expect(response.status).toBe(404);
    expect(loopsService.create).not.toHaveBeenCalled();
  });

  it("does not look up a target when none is requested", async () => {
    const { response } = await postLoop({
      command: "EVALUATE_FEATURE",
      documentId: DOCUMENT_ID,
    });

    expect(response.status).toBe(200);
    expect(computeTargetsService.findOwnedById).not.toHaveBeenCalled();
    const createInput = vi.mocked(loopsService.create).mock.calls[0]?.[2];
    expect(createInput).toBeDefined();
    expect(createInput).not.toHaveProperty("computeTargetId");
  });

  it("rejects a non-uuid computeTargetId before any lookup", async () => {
    const { response } = await postLoop({
      command: "EVALUATE_FEATURE",
      documentId: DOCUMENT_ID,
      computeTargetId: "not-a-uuid",
    });

    expect(response.status).toBe(400);
    expect(computeTargetsService.findOwnedById).not.toHaveBeenCalled();
    expect(loopsService.create).not.toHaveBeenCalled();
  });
});
