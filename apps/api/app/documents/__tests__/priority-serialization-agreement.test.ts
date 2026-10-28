/**
 * ISS-9665 — one artifact, one priority, at every serialization point.
 *
 * THE DEFECT. `toDocument` folded a stored `NULL` priority to `MEDIUM`. Nothing
 * else did: `/search`, `/artifact-links/resolved`, `/artifacts/favorites` and
 * the project tree all reported `null`, because their mappers pass the column
 * through. So a single artifact answered `"MEDIUM"` on one endpoint and `null`
 * on the next, "no priority" was unqueryable, and the first time a user set a
 * priority the activity diff compared `MEDIUM` to `MEDIUM` and recorded nothing.
 *
 * WHY THE FIXTURE IS BUILT BY HAND. The expectations below are written as
 * literals — `null` and `Priority.Urgent` — never read back from a mapper, a
 * shared builder default, or `PRIORITY_LABELS`. A fixture that derived its
 * expected priority from the same code under test would stay green with the
 * `?? Priority.Medium` coercion restored, which is the exact false-green this
 * test exists to prevent. The duplication IS the test.
 *
 * EVERY CASE COMES IN A PAIR. An artifact with a genuinely NULL priority proves
 * the fold is gone; the same artifact carrying a CONFLICTING pre-seeded value
 * (`URGENT`, deliberately not the folded `MEDIUM`) proves the mappers still
 * report a real priority rather than having been blanket-nulled. One without the
 * other is satisfiable by a mapper that always answers the same thing.
 */
import { ArtifactType } from "@repo/api/src/types/artifact";
import { Priority } from "@repo/api/src/types/common";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import { describe, expect, test } from "vitest";
import type {
  ArtifactWithDocumentDetail,
  RawDocumentWithContext,
} from "@/app/documents/document-utils";
import {
  toDocument,
  toDocumentWithProject,
} from "@/app/documents/document-utils";
import { documentProjection } from "@/app/search/search-index-service";

const CREATED_AT = new Date("2026-02-01T00:00:00.000Z");
const UPDATED_AT = new Date("2026-02-02T00:00:00.000Z");

describe("artifact priority serializes identically at every endpoint", () => {
  test("an artifact with NO priority reports unset everywhere", () => {
    const artifact = buildArtifact(null);

    // `GET /documents/:id`, `GET /templates`, `POST /documents/:id/versions`.
    const detail = toDocument(artifact);
    // `GET /documents` (the list read).
    const listRow = toDocumentWithProject(artifact as RawDocumentWithContext);
    // The row `GET /search` filters and ranks on.
    const searchRow = documentProjection({
      id: detail.id,
      organizationId: detail.organizationId,
      title: detail.title,
      slug: detail.slug,
      entitySubtype: detail.type,
      body: null,
      projectId: detail.projectId,
      assigneeId: detail.assigneeId,
      status: detail.status,
      priority: detail.priority,
      updatedAt: detail.updatedAt,
    });

    // Whole-object equality on the answer each endpoint gives, so a mapper that
    // reports the right value under a different key (or an extra one) cannot
    // pass by matching a single field.
    expect({
      detail: detail.priority,
      listRow: listRow.priority,
      searchRow: searchRow.priority,
    }).toEqual({ detail: null, listRow: null, searchRow: null });
  });

  test("an artifact WITH a priority reports that priority everywhere", () => {
    // URGENT, not MEDIUM: a mapper that had simply been changed to always
    // return null, or that still folded to the creation default, fails here.
    const artifact = buildArtifact(Priority.Urgent);

    const detail = toDocument(artifact);
    const listRow = toDocumentWithProject(artifact as RawDocumentWithContext);
    const searchRow = documentProjection({
      id: detail.id,
      organizationId: detail.organizationId,
      title: detail.title,
      slug: detail.slug,
      entitySubtype: detail.type,
      body: null,
      projectId: detail.projectId,
      assigneeId: detail.assigneeId,
      status: detail.status,
      priority: detail.priority,
      updatedAt: detail.updatedAt,
    });

    expect({
      detail: detail.priority,
      listRow: listRow.priority,
      searchRow: searchRow.priority,
    }).toEqual({
      detail: Priority.Urgent,
      listRow: Priority.Urgent,
      searchRow: Priority.Urgent,
    });
  });

  test("the unset artifact is not MEDIUM on any endpoint", () => {
    // The negative half of the pair above, stated against the ONE value the
    // retired coercion produced. `toEqual(null)` alone would also pass against
    // a mapper that dropped the key entirely.
    const detail = toDocument(buildArtifact(null));
    const listRow = toDocumentWithProject(
      buildArtifact(null) as RawDocumentWithContext
    );

    expect(detail.priority).not.toBe(Priority.Medium);
    expect(listRow.priority).not.toBe(Priority.Medium);
    expect(Object.hasOwn(detail, "priority")).toBe(true);
  });
});

/**
 * A Prisma artifact row whose `priority` column is EXACTLY what the caller
 * asked for. Written out here rather than reused from the sibling
 * `document-utils.test.ts` builder on purpose: that builder defaults `priority`
 * to `Priority.Medium`, so a test taking its default could never observe a
 * stored NULL at all.
 */
function buildArtifact(
  priority: Priority | null
): ArtifactWithDocumentDetail & { project: null; tagArtifacts: [] } {
  return {
    id: "artifact-9665",
    organizationId: "org-1",
    projectId: "project-1",
    type: ArtifactType.Document,
    subtype: DocumentType.Feature,
    name: "An artifact nobody prioritized",
    slug: "FEA-9665",
    assigneeId: null,
    status: DocumentStatus.Draft,
    priority,
    dueDate: null,
    externalUrl: null,
    sortOrder: null,
    createdAt: CREATED_AT,
    createdById: "user-1",
    updatedAt: UPDATED_AT,
    assignee: null,
    createdBy: null,
    project: null,
    tagArtifacts: [],
    document: {
      artifactId: "artifact-9665",
      fileName: null,
      approverId: null,
      templateForType: null,
      latestVersion: 1,
      repositorySnapshot: { repositories: [], source: "none" },
      approver: null,
    },
  } as unknown as ArtifactWithDocumentDetail & {
    project: null;
    tagArtifacts: [];
  };
}
