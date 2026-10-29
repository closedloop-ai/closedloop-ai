/**
 * A comment hit anchored on a document routes to that document: the search
 * service gives the hit the document's slug, read from the requester's org.
 */
import { ArtifactType } from "@repo/api/src/types/artifact";
import { DOCUMENT_ROUTE_PREFIX } from "@repo/api/src/types/document";
import { searchHitRoute } from "@repo/api/src/types/search";
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
  Prisma: {
    empty: { strings: [""], values: [] },
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings: [...strings],
      values,
    }),
    join: (items: unknown[], separator = ",") => ({ join: items, separator }),
    QueryMode: { insensitive: "insensitive" },
  },
}));

import {
  baseParams,
  candidate,
  installDb,
  ORG,
} from "@/__tests__/support/search/search-fts-service.test-fixtures";
import { searchFtsService } from "./search-fts-service";

const DOCUMENT_ID = "dddddddd-0000-0000-0000-000000000001";
const COMMENT_ID = "cccccccc-0000-0000-0000-000000000001";

/** Prisma's semantics: an absent `where` key constrains nothing. */
type ArtifactWhere = {
  id: { in: string[] };
  organizationId?: string;
  type?: string;
};

describe("searchUnified on a comment anchored on a document", () => {
  beforeEach(() => vi.clearAllMocks());

  function installDocumentComment(documentOrganizationId: string) {
    const db = installDb({
      candidates: [
        candidate({
          entity_type: SearchEntityType.Comment,
          entity_id: COMMENT_ID,
          entity_subtype: ArtifactType.Document,
          anchor_entity_id: DOCUMENT_ID,
        }),
      ],
      visible: { [SearchEntityType.Comment]: [COMMENT_ID] },
    });
    db.artifact.findMany.mockImplementation(
      (args: { where: ArtifactWhere }) => {
        const { where } = args;
        const matches =
          where.id.in.includes(DOCUMENT_ID) &&
          (where.organizationId === undefined ||
            where.organizationId === documentOrganizationId) &&
          (where.type === undefined || where.type === ArtifactType.Document);
        return Promise.resolve(
          matches ? [{ id: DOCUMENT_ID, slug: "PRD-42" }] : []
        );
      }
    );
  }

  it("routes the hit to its document by the document's slug", async () => {
    installDocumentComment(ORG);

    const { results } = await searchFtsService.searchUnified(baseParams());

    expect(results.map(searchHitRoute)).toEqual([
      `/${DOCUMENT_ROUTE_PREFIX}/PRD-42`,
    ]);
  });

  it("leaves the hit a non-link when the document is another org's", async () => {
    installDocumentComment("22222222-2222-2222-2222-222222222222");

    const { results } = await searchFtsService.searchUnified(baseParams());

    expect(results.map((hit) => hit.entityId)).toEqual([COMMENT_ID]);
    expect(results.map(searchHitRoute)).toEqual([null]);
  });
});
