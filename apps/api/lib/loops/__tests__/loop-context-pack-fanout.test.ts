/**
 * FEA-3299 regression: the context-pack read must not fan out one pooled pg
 * connection per context ref.
 *
 * `loop.contextRefs` is caller-supplied (`POST /api/loops`) and, for rows
 * persisted before MAX_CONTEXT_REFS existed, carries no cap at all — the column
 * is raw-cast JSON on read. Two separate branches of `buildContextPackInMemory`
 * fan out over that same array, and they run concurrently as siblings of one
 * `Promise.all`. Unbounded, a single loop launch demanded ~2N pooled
 * connections against a pool of 20 and starved every other route (PRD-528).
 *
 * These tests drive the real `buildContextPackInMemory` rather than the two
 * fan-out helpers in isolation, because the bug being pinned is precisely that
 * the two *combine*: bounding each branch separately still peaks at 2x the
 * intended limit. Testing them one at a time would pass while the request as a
 * whole remained over budget.
 */
import { LoopCommand } from "@repo/api/src/types/loop";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DB_FANOUT_MAX_CONCURRENCY } from "@/lib/db-fanout";

const mocks = vi.hoisted(() => ({
  findByIdSimple: vi.fn(),
  getLatest: vi.fn(),
  listWithSignedUrlsByDocument: vi.fn(),
  findLoopById: vi.fn(),
  findTemplate: vi.fn(),
  listAgentsForContextPack: vi.fn(),
  isFeatureFlagEnabledForDistinctId: vi.fn(),
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@repo/database", () => ({ withDb: mocks.withDb }));

vi.mock("@repo/analytics/feature-flags", () => ({
  isFeatureFlagEnabledForDistinctId: mocks.isFeatureFlagEnabledForDistinctId,
}));

vi.mock("@/app/documents/document-service", () => ({
  documentService: { findByIdSimple: mocks.findByIdSimple },
}));

vi.mock("@/app/documents/document-version-service", () => ({
  documentVersionService: { getLatest: mocks.getLatest },
}));

vi.mock("@/app/documents/attachments-service", () => ({
  ATTACHMENT_SIGNED_URL_MAX_FILES: 20,
  attachmentsService: {
    listWithSignedUrlsByDocument: mocks.listWithSignedUrlsByDocument,
  },
}));

vi.mock("@/app/loops/service", () => ({
  loopsService: { findById: mocks.findLoopById },
}));

vi.mock("@/app/templates/service", () => ({
  documentTemplatesService: { findActiveByType: mocks.findTemplate },
}));

vi.mock("@/app/catalog/service", () => ({
  listAgentsForContextPack: mocks.listAgentsForContextPack,
}));

import { buildContextPackInMemory } from "../loop-context-pack";

const ORG_ID = "org-1";

// Sized off the bound, not hardcoded: refs must always exceed
// DB_FANOUT_MAX_CONCURRENCY or the assertion has no power — with refs <= the
// bound an unbounded fan-out would satisfy it too.
const REF_COUNT = DB_FANOUT_MAX_CONCURRENCY * 2 + 2;

/**
 * One shared in-flight counter across BOTH fan-outs, so the assertion measures
 * what the pool actually sees for a single request.
 *
 * Yields several microtasks inside the tracked window so overlapping calls are
 * observed as concurrent before any settles.
 */
function trackPeak() {
  const state = { inFlight: 0, peak: 0 };
  const enter = async <T>(value: T): Promise<T> => {
    state.inFlight += 1;
    state.peak = Math.max(state.peak, state.inFlight);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    state.inFlight -= 1;
    return value;
  };
  return { enter, state };
}

function buildLoop(refCount: number) {
  return {
    id: "loop-1",
    userId: "user-1",
    command: LoopCommand.Plan,
    prompt: "do the thing",
    documentId: null,
    documentVersion: null,
    parentLoopId: null,
    repo: null,
    contextRefs: Array.from({ length: refCount }, (_, i) => ({
      sourceId: `ref-${i}`,
      include: "summary" as const,
    })),
  };
}

describe("buildContextPackInMemory context-ref fan-out (FEA-3299)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findLoopById.mockResolvedValue(null);
    mocks.findTemplate.mockResolvedValue(null);
    mocks.listAgentsForContextPack.mockResolvedValue({
      agents: [],
      repoConfigs: [],
    });
    mocks.isFeatureFlagEnabledForDistinctId.mockResolvedValue(false);
    mocks.withDb.mockImplementation((cb: (db: unknown) => unknown) => cb({}));
  });

  it("bounds peak in-flight pooled reads across BOTH context-ref fan-outs", async () => {
    const { enter, state } = trackPeak();

    // Both fan-outs feed the same counter: `fetchContextRefArtifacts` (via
    // documentService/documentVersionService) and `collectContextRefAttachments`
    // (via attachmentsService) run concurrently over the same refs array.
    mocks.findByIdSimple.mockImplementation((id: string) =>
      enter({ id, type: "DOCUMENT", subtype: "PRD", slug: id, title: id })
    );
    mocks.getLatest.mockImplementation(() => enter({ content: "body" }));
    mocks.listWithSignedUrlsByDocument.mockImplementation(() => enter([]));

    await buildContextPackInMemory(buildLoop(REF_COUNT), ORG_ID);

    // Unbounded, this peaks around 2 * REF_COUNT (24). With a limiter per branch
    // instead of one shared limiter it peaks at 2 * 5 = 10. Only a shared budget
    // holds it at 5.
    expect(state.peak).toBeLessThanOrEqual(DB_FANOUT_MAX_CONCURRENCY);
    expect(state.peak).toBeGreaterThan(1);
  });

  it("still reads every context ref exactly once", async () => {
    mocks.findByIdSimple.mockImplementation((id: string) =>
      Promise.resolve({
        id,
        type: "DOCUMENT",
        subtype: "PRD",
        slug: id,
        title: id,
      })
    );
    mocks.getLatest.mockResolvedValue({ content: "body" });
    mocks.listWithSignedUrlsByDocument.mockResolvedValue([]);

    const pack = await buildContextPackInMemory(buildLoop(REF_COUNT), ORG_ID);

    // Bounding concurrency must not drop work.
    expect(mocks.findByIdSimple).toHaveBeenCalledTimes(REF_COUNT);
    expect(mocks.listWithSignedUrlsByDocument).toHaveBeenCalledTimes(REF_COUNT);
    expect(pack.artifacts).toHaveLength(REF_COUNT);
  });

  it("preserves contextRefs order in the assembled artifacts", async () => {
    // Later refs resolve first; the pack must still list them in ref order,
    // because prompt assembly depends on it.
    mocks.findByIdSimple.mockImplementation(async (id: string) => {
      const index = Number(id.split("-")[1]);
      await new Promise((resolve) => setTimeout(resolve, REF_COUNT - index));
      return { id, type: "DOCUMENT", subtype: "PRD", slug: id, title: id };
    });
    mocks.getLatest.mockResolvedValue({ content: "body" });
    mocks.listWithSignedUrlsByDocument.mockResolvedValue([]);

    const pack = await buildContextPackInMemory(buildLoop(REF_COUNT), ORG_ID);

    expect(pack.artifacts.map((a) => a.id)).toEqual(
      Array.from({ length: REF_COUNT }, (_, i) => `ref-${i}`)
    );
  });

  it("keeps per-ref attachment failures isolated rather than failing the launch", async () => {
    // The bounded mapper is fail-fast, so the pre-existing per-ref catch must
    // stay INSIDE the mapper. If it ever moves out, one bad ref would abort the
    // whole context pack.
    mocks.findByIdSimple.mockImplementation((id: string) =>
      Promise.resolve({
        id,
        type: "DOCUMENT",
        subtype: "PRD",
        slug: id,
        title: id,
      })
    );
    mocks.getLatest.mockResolvedValue({ content: "body" });
    mocks.listWithSignedUrlsByDocument.mockImplementation((sourceId: string) =>
      sourceId === "ref-3"
        ? Promise.reject(new Error("attachment boom"))
        : Promise.resolve([])
    );

    const pack = await buildContextPackInMemory(buildLoop(REF_COUNT), ORG_ID);

    expect(pack.artifacts).toHaveLength(REF_COUNT);
  });
});
