/**
 * FEA-3951 regression: an evergreen Document (DocumentType.Doc) referenced by a
 * FEAT/PRD via a `LinkType.RelatesTo` link must be folded into the loop context
 * pack so its content feeds the same context surfaces the FEAT/PRD already
 * drives (plan/loop generation) — not merely rendered as a link.
 *
 * These tests drive the real `buildContextPackInMemory` and assert the built
 * pack CONTAINS the referenced document's content. @repo/database and the
 * services are mocked — no live DB.
 */
import { LinkType } from "@repo/api/src/types/artifact";
import { DocumentType } from "@repo/api/src/types/document";
import { LoopCommand } from "@repo/api/src/types/loop";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findByIdSimple: vi.fn(),
  getLatest: vi.fn(),
  getByVersion: vi.fn(),
  listWithSignedUrlsByDocument: vi.fn(),
  findLoopById: vi.fn(),
  findTemplate: vi.fn(),
  listAgentsForContextPack: vi.fn(),
  findSourceLinks: vi.fn(),
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@repo/database", () => ({ withDb: mocks.withDb }));

vi.mock("@/app/documents/document-service", () => ({
  documentService: {
    findByIdSimple: mocks.findByIdSimple,
    findSlugById: vi.fn(),
  },
}));

vi.mock("@/app/documents/document-version-service", () => ({
  documentVersionService: {
    getLatest: mocks.getLatest,
    getByVersion: mocks.getByVersion,
  },
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
  documentTemplatesService: { findOrgTemplate: mocks.findTemplate },
}));

vi.mock("@/app/catalog/service", () => ({
  listAgentsForContextPack: mocks.listAgentsForContextPack,
}));

vi.mock("@/app/artifact-links/service", () => ({
  artifactLinksService: { findSourceLinks: mocks.findSourceLinks },
}));

import { buildContextPackInMemory } from "../loop-context-pack";
import type { LoopForContextPack } from "../loop-context-pack-types";

const ORG_ID = "org-1";
const PRIMARY_DOC_ID = "feat-1";
const EVERGREEN_DOC_ID = "doc-evergreen-1";
const EVERGREEN_DOC_CONTENT = "Brand voice: always ship with a smile.";

function buildLoop(
  overrides: Partial<LoopForContextPack> = {}
): LoopForContextPack {
  return {
    id: "loop-1",
    userId: "user-1",
    // EXECUTE includes the primary artifact and skips PLAN's version-1 user
    // context read, keeping this test focused on the RelatesTo path.
    command: LoopCommand.Execute,
    prompt: "do the thing",
    documentId: PRIMARY_DOC_ID,
    documentVersion: null,
    parentLoopId: null,
    repo: null,
    contextRefs: null,
    ...overrides,
  };
}

function evergreenDoc() {
  return {
    id: EVERGREEN_DOC_ID,
    type: DocumentType.Doc,
    subtype: DocumentType.Doc,
    slug: "DOC-1",
    title: "Company Brand Guide",
  };
}

describe("buildContextPackInMemory — referenced evergreen Documents (FEA-3951)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findLoopById.mockResolvedValue(null);
    mocks.findTemplate.mockResolvedValue(null);
    mocks.listAgentsForContextPack.mockResolvedValue({
      agents: [],
      repoConfigs: [],
    });
    mocks.listWithSignedUrlsByDocument.mockResolvedValue([]);
    mocks.withDb.mockImplementation((cb: (db: unknown) => unknown) => cb({}));
    // Default: no RelatesTo links.
    mocks.findSourceLinks.mockResolvedValue([]);
  });

  it("folds a RelatesTo-linked evergreen Document's content into the pack", async () => {
    mocks.findSourceLinks.mockResolvedValue([
      {
        id: "link-1",
        sourceId: EVERGREEN_DOC_ID,
        targetId: PRIMARY_DOC_ID,
        linkType: LinkType.RelatesTo,
      },
    ]);
    mocks.findByIdSimple.mockImplementation((id: string) => {
      if (id === EVERGREEN_DOC_ID) {
        return Promise.resolve(evergreenDoc());
      }
      // Primary FEAT artifact.
      return Promise.resolve({
        id: PRIMARY_DOC_ID,
        type: DocumentType.Feature,
        subtype: DocumentType.Feature,
        slug: "FEAT-1",
        title: "The Feature",
      });
    });
    mocks.getLatest.mockImplementation((id: string) =>
      id === EVERGREEN_DOC_ID
        ? Promise.resolve({ content: EVERGREEN_DOC_CONTENT })
        : Promise.resolve({ content: "primary body" })
    );

    const pack = await buildContextPackInMemory(buildLoop(), ORG_ID);

    // Org-scoping: the link lookup must be scoped to the caller's org.
    expect(mocks.findSourceLinks).toHaveBeenCalledWith(
      ORG_ID,
      PRIMARY_DOC_ID,
      LinkType.RelatesTo
    );

    // The evergreen DOC travels via `supportingArtifacts` ONLY — never the
    // top-level `artifacts` wire array, whose Desktop schema
    // (`LoopRequestBody.artifacts[].type`) is `z.enum(LoopArtifactType)` =
    // PRD/IMPLEMENTATION_PLAN/FEATURE and would fail-parse on a DOC (wongk).
    expect(pack.artifacts.some((a) => a.id === EVERGREEN_DOC_ID)).toBe(false);
    const evergreen = pack.supportingArtifacts?.find(
      (a) => a.id === EVERGREEN_DOC_ID
    );
    expect(evergreen).toBeDefined();
    expect(evergreen?.content).toContain(EVERGREEN_DOC_CONTENT);
    // Wrapped in the untrusted boundary (DocumentType.Doc is now a wrap type).
    expect(evergreen?.content).toContain("BEGIN UNTRUSTED DOC");
    expect(evergreen?.content).toContain("END UNTRUSTED DOC");
  });

  it("skips a RelatesTo source that is not an evergreen Document", async () => {
    // A RelatesTo link to a PRD (not a DOC) must not be folded in here — PRD
    // context travels the loop's contextRefs path instead.
    mocks.findSourceLinks.mockResolvedValue([
      {
        id: "link-1",
        sourceId: "prd-1",
        targetId: PRIMARY_DOC_ID,
        linkType: LinkType.RelatesTo,
      },
    ]);
    mocks.findByIdSimple.mockImplementation((id: string) => {
      if (id === "prd-1") {
        return Promise.resolve({
          id: "prd-1",
          type: DocumentType.Prd,
          subtype: DocumentType.Prd,
          slug: "PRD-1",
          title: "A PRD",
        });
      }
      return Promise.resolve({
        id: PRIMARY_DOC_ID,
        type: DocumentType.Feature,
        subtype: DocumentType.Feature,
        slug: "FEAT-1",
        title: "The Feature",
      });
    });
    mocks.getLatest.mockResolvedValue({ content: "primary body" });

    const pack = await buildContextPackInMemory(buildLoop(), ORG_ID);

    expect(pack.artifacts.some((a) => a.id === "prd-1")).toBe(false);
  });

  it("does not query links when the loop has no primary document", async () => {
    const pack = await buildContextPackInMemory(
      buildLoop({ documentId: null }),
      ORG_ID
    );

    expect(mocks.findSourceLinks).not.toHaveBeenCalled();
    expect(pack.artifacts).toHaveLength(0);
  });

  it("degrades to no evergreen docs (loop still builds) when the link lookup throws", async () => {
    // Fail-open: the enrichment sits on the launch-critical Promise.all, so a
    // transient link read must NOT reject the whole loop (apps/api/lib/loops/
    // AGENTS.md fail-open rule; wongk review).
    mocks.findSourceLinks.mockRejectedValue(new Error("transient link read"));
    mocks.findByIdSimple.mockResolvedValue(null);

    const pack = await buildContextPackInMemory(buildLoop(), ORG_ID);

    expect(pack.command).toBe(LoopCommand.Execute);
    expect(
      (pack.supportingArtifacts ?? []).some((a) => a.type === DocumentType.Doc)
    ).toBe(false);
  });

  it("degrades to no evergreen docs when a per-document version read throws", async () => {
    mocks.findSourceLinks.mockResolvedValue([
      {
        id: "link-1",
        sourceId: EVERGREEN_DOC_ID,
        targetId: PRIMARY_DOC_ID,
        linkType: LinkType.RelatesTo,
      },
    ]);
    // Only the evergreen doc resolves; the primary stays absent so the throwing
    // version read is exercised solely on the enrichment path.
    mocks.findByIdSimple.mockImplementation((id: string) =>
      Promise.resolve(id === EVERGREEN_DOC_ID ? evergreenDoc() : null)
    );
    mocks.getLatest.mockRejectedValue(new Error("transient version read"));

    const pack = await buildContextPackInMemory(buildLoop(), ORG_ID);

    expect(pack.command).toBe(LoopCommand.Execute);
    expect(
      (pack.supportingArtifacts ?? []).some((a) => a.type === DocumentType.Doc)
    ).toBe(false);
  });

  it("filters to DOC sources BEFORE the cap so DOCs behind newer non-DOC links survive", async () => {
    // 21 non-DOC RelatesTo sources newest-first, then one real DOC. The old code
    // sliced the first 20 source ids before filtering by type, dropping the DOC
    // (link #22). After the fix, non-DOC sources are filtered out first, so the
    // DOC survives the 20-doc cap (codex P1 + wongk).
    const nonDocLinks = Array.from({ length: 21 }, (_, i) => ({
      id: `link-${i}`,
      sourceId: `prd-${i}`,
      targetId: PRIMARY_DOC_ID,
      linkType: LinkType.RelatesTo,
    }));
    mocks.findSourceLinks.mockResolvedValue([
      ...nonDocLinks,
      {
        id: "link-doc",
        sourceId: EVERGREEN_DOC_ID,
        targetId: PRIMARY_DOC_ID,
        linkType: LinkType.RelatesTo,
      },
    ]);
    mocks.findByIdSimple.mockImplementation((id: string) => {
      if (id === EVERGREEN_DOC_ID) {
        return Promise.resolve(evergreenDoc());
      }
      if (id === PRIMARY_DOC_ID) {
        return Promise.resolve({
          id: PRIMARY_DOC_ID,
          type: DocumentType.Feature,
          subtype: DocumentType.Feature,
          slug: "FEAT-1",
          title: "The Feature",
        });
      }
      // Every prd-* source is a non-DOC (PRD) relates-to link.
      return Promise.resolve({
        id,
        type: DocumentType.Prd,
        subtype: DocumentType.Prd,
        slug: id,
        title: id,
      });
    });
    mocks.getLatest.mockResolvedValue({ content: EVERGREEN_DOC_CONTENT });

    const pack = await buildContextPackInMemory(buildLoop(), ORG_ID);

    const docs = (pack.supportingArtifacts ?? []).filter(
      (a) => a.type === DocumentType.Doc
    );
    expect(docs).toHaveLength(1);
    expect(docs[0]?.id).toBe(EVERGREEN_DOC_ID);
  });

  it("drops evergreen docs once the aggregate byte budget is exceeded", async () => {
    // Two ~400 KB docs; the 512 KB budget admits the first and drops the second
    // so an oversized linked Doc can't blow the inline dispatch body (wongk).
    const bigBody = "x".repeat(400 * 1024);
    mocks.findSourceLinks.mockResolvedValue([
      {
        id: "link-a",
        sourceId: "doc-a",
        targetId: PRIMARY_DOC_ID,
        linkType: LinkType.RelatesTo,
      },
      {
        id: "link-b",
        sourceId: "doc-b",
        targetId: PRIMARY_DOC_ID,
        linkType: LinkType.RelatesTo,
      },
    ]);
    mocks.findByIdSimple.mockImplementation((id: string) => {
      if (id === PRIMARY_DOC_ID) {
        return Promise.resolve(null);
      }
      return Promise.resolve({
        id,
        type: DocumentType.Doc,
        subtype: DocumentType.Doc,
        slug: id,
        title: id,
      });
    });
    mocks.getLatest.mockResolvedValue({ content: bigBody });

    const pack = await buildContextPackInMemory(buildLoop(), ORG_ID);

    const docs = (pack.supportingArtifacts ?? []).filter(
      (a) => a.type === DocumentType.Doc
    );
    expect(docs).toHaveLength(1);
    expect(docs[0]?.id).toBe("doc-a");
  });
});
