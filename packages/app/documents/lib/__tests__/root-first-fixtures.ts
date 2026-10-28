import { ArtifactType } from "@repo/api/src/types/artifact";
import type { DocumentWithProject } from "@repo/api/src/types/document";
import { DocumentType } from "@repo/api/src/types/document";
import type { ProjectStatus } from "@repo/api/src/types/project";
import type { SessionStatus } from "@repo/api/src/types/session-status";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import {
  createMockDocument,
  makeRawArtifact,
} from "@repo/app/shared/test-fixtures/documents";
import { makeProject } from "@repo/app/shared/test-fixtures/project";

/**
 * Row builders for the ISS-9437 root-first suites, shared so the fold test, the
 * section-order test and the partition proof build the same mixed table rather
 * than three that drift.
 *
 * Every builder widens `status` to `string` on purpose: `Artifact.status` is a
 * freeform column carrying four vocabularies here, and a value in none of them
 * is the routine input these suites are about.
 */

export function documentRow(
  id: string,
  status: string,
  type: DocumentType = DocumentType.Prd
): DocumentRowItem {
  return {
    kind: "document",
    data: {
      ...createMockDocument({ id, title: id, slug: id, type }),
      status,
    } as DocumentWithProject,
  };
}

/** An ISSUE row — the same `document` row kind, read against `IssueStatus`. */
export function issueRow(id: string, status: string): DocumentRowItem {
  return documentRow(id, status, DocumentType.Feature);
}

export function projectRow(id: string, status: ProjectStatus): DocumentRowItem {
  return {
    kind: "project",
    data: makeProject({ id, name: id, status }),
  };
}

export function branchRow(id: string, status: string): DocumentRowItem {
  return {
    kind: "branch",
    data: makeRawArtifact(ArtifactType.Branch, { id, name: id, status }),
  };
}

/**
 * A session row. `displayedSessionStatus` is the field the SERVER used to
 * derive for the ISS-8694 enrichment. ISS-10364 made that enrichment
 * permanently inert (`resolveServedSessionDisplayStatus` always answers
 * `undefined` now, regardless of what a raw payload carries here). The param
 * stays `string`-typed and is cast past the production `SessionStatus` field
 * type at the call site — a legacy/version-skewed wire payload is not bound
 * by this build's type, and that is exactly the shape these tests simulate.
 */
export function sessionRow(
  id: string,
  status: string,
  displayedSessionStatus?: string
): DocumentRowItem {
  return {
    kind: "session",
    data: makeRawArtifact(ArtifactType.Session, {
      id,
      name: id,
      status,
      ...(displayedSessionStatus !== undefined && {
        displayedSessionStatus: displayedSessionStatus as SessionStatus,
      }),
    }),
  };
}
