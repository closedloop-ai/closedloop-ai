import {
  type Artifact,
  type ArtifactLinkEndpoint,
  ArtifactSubtype,
  ArtifactType,
  LinkType,
} from "@repo/api/src/types/artifact";
import { Priority } from "@repo/api/src/types/common";
import {
  DocumentStatus,
  DocumentType,
  IssueStatus,
  SnapshotSource,
} from "@repo/api/src/types/document";
import {
  type DocumentStatusMutationCapability,
  DocumentStatusMutationOperation,
} from "@repo/api/src/types/document-status-mutation";
import type {
  DetailedArtifact,
  ProjectTreeDetailsResponse,
} from "@repo/api/src/types/project-tree";
import { TagColor } from "@repo/api/src/types/tag";
import type { BasicUser } from "@repo/api/src/types/user";
import { describe, expect, it } from "vitest";
import {
  collectDocumentRowsFromTree,
  documentRowFromArtifact,
  endpointToDocument,
} from "../artifact-row-adapter";

const PROJECT = { id: "proj-1", name: "Project One" };
const UNKNOWN_PRIORITY = "BLOCKER";

function makeArtifact(overrides: Partial<DetailedArtifact>): DetailedArtifact {
  const base: Artifact = {
    id: "a-1",
    organizationId: "org-1",
    projectId: "proj-1",
    type: ArtifactType.Document,
    subtype: ArtifactSubtype.Prd,
    name: "Some PRD",
    slug: "PRD-1",
    status: DocumentStatus.Draft,
    priority: Priority.High,
    assigneeId: "user-1",
    assignee: null,
    dueDate: null,
    externalUrl: null,
    sortOrder: 1000,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    createdById: null,
    updatedAt: new Date("2026-06-02T00:00:00.000Z"),
  };
  return { ...base, ...overrides };
}

describe("documentRowFromArtifact", () => {
  it("maps a document artifact onto the table row shape", () => {
    const row = documentRowFromArtifact(
      makeArtifact({
        tags: [{ id: "t1", name: "infra", color: TagColor.Red }],
      }),
      PROJECT
    );

    expect(row).toEqual({
      id: "a-1",
      slug: "PRD-1",
      title: "Some PRD",
      type: DocumentType.Prd,
      status: DocumentStatus.Draft,
      rawStatus: DocumentStatus.Draft,
      priority: Priority.High,
      assigneeId: "user-1",
      assignee: null,
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedAt: new Date("2026-06-02T00:00:00.000Z"),
      projectId: "proj-1",
      sortOrder: 1000,
      tags: [{ id: "t1", name: "infra", color: TagColor.Red }],
      project: PROJECT,
    });
  });

  it("passes an unset priority through instead of folding it to Medium", () => {
    // BEHAVIOUR CHANGE (ISS-9665). The comment this replaced claimed
    // "documents are always created with a priority" — the create validator
    // makes it optional and the column has no default, so an omitted priority
    // has always persisted as NULL and this row was reporting Medium for it.
    expect(
      documentRowFromArtifact(makeArtifact({ priority: null }), PROJECT)
        ?.priority
    ).toBe(null);
  });

  it.each([Priority.Low, Priority.Medium, Priority.High, Priority.Urgent])(
    "still reports a real priority the tree artifact carries: %s",
    (priority) => {
      expect(
        documentRowFromArtifact(makeArtifact({ priority }), PROJECT)?.priority
      ).toBe(priority);
    }
  );

  it("passes a version-skewed tree priority token through as unknown data", () => {
    expect(
      documentRowFromArtifact(
        makeArtifact({ priority: UNKNOWN_PRIORITY as Priority }),
        PROJECT
      )?.priority
    ).toBe(UNKNOWN_PRIORITY);
  });

  it.each([
    [ArtifactSubtype.Prd, DocumentType.Prd],
    [ArtifactSubtype.ImplementationPlan, DocumentType.ImplementationPlan],
    [ArtifactSubtype.Feature, DocumentType.Feature],
    [ArtifactSubtype.Template, DocumentType.Template],
  ])("maps subtype %s to document type %s", (subtype, expected) => {
    const row = documentRowFromArtifact(makeArtifact({ subtype }), null);
    expect(row?.type).toBe(expected);
  });

  it("returns null for non-document artifacts and documents without subtype", () => {
    expect(
      documentRowFromArtifact(
        makeArtifact({ type: ArtifactType.Branch, subtype: null }),
        null
      )
    ).toBeNull();
    expect(
      documentRowFromArtifact(makeArtifact({ subtype: null }), null)
    ).toBeNull();
  });

  it("falls back to Draft for an out-of-contract status string", () => {
    const row = documentRowFromArtifact(
      makeArtifact({ status: "SOMETHING_NEW" }),
      null
    );
    expect(row?.status).toBe(DocumentStatus.Draft);
  });
});

describe("collectDocumentRowsFromTree", () => {
  it("collects each document artifact once across roots and children, newest first", () => {
    const child = makeArtifact({
      id: "a-2",
      slug: "FEA-2",
      subtype: ArtifactSubtype.Feature,
      createdAt: new Date("2026-06-05T00:00:00.000Z"),
    });
    const tree: ProjectTreeDetailsResponse = {
      nodes: [
        {
          root: makeArtifact({}),
          children: [
            {
              ...child,
              linkType: LinkType.Produces,
              depth: 1,
              parentId: "a-1",
            },
          ],
        },
        // Branch root and a duplicate child appearance are both ignored.
        {
          root: makeArtifact({
            id: "br-1",
            type: ArtifactType.Branch,
            subtype: null,
          }),
          children: [
            {
              ...child,
              linkType: LinkType.Produces,
              depth: 1,
              parentId: "br-1",
            },
          ],
        },
      ],
      externalParents: [],
    };

    const rows = collectDocumentRowsFromTree(tree, PROJECT);

    expect(rows.map((r) => r.id)).toEqual(["a-2", "a-1"]);
  });

  it("returns an empty list for an undefined tree", () => {
    expect(collectDocumentRowsFromTree(undefined, null)).toEqual([]);
  });
});

const ENDPOINT_ASSIGNEE: BasicUser = {
  id: "user-1",
  email: "kerensa.whitlock@closedloop.ai",
  firstName: "Kerensa",
  lastName: "Whitlock",
  avatarUrl: null,
};

function makeEndpoint(
  overrides: Partial<ArtifactLinkEndpoint>
): ArtifactLinkEndpoint {
  const base: ArtifactLinkEndpoint = {
    id: "doc-1",
    organizationId: "org-1",
    projectId: "proj-1",
    type: ArtifactType.Document,
    subtype: ArtifactSubtype.Feature,
    name: "Parent Feature",
    slug: "FEA-1",
    status: IssueStatus.InProgress,
    priority: Priority.High,
    assigneeId: "user-1",
    assignee: ENDPOINT_ASSIGNEE,
    dueDate: null,
    externalUrl: null,
    sortOrder: 1000,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    createdById: "user-2",
    updatedAt: new Date("2026-06-02T00:00:00.000Z"),
  };
  return { ...base, ...overrides };
}

describe("endpointToDocument", () => {
  it("maps a resolved-link endpoint onto the Document shape", () => {
    expect(endpointToDocument(makeEndpoint({}))).toEqual({
      id: "doc-1",
      organizationId: "org-1",
      projectId: "proj-1",
      type: DocumentType.Feature,
      title: "Parent Feature",
      slug: "FEA-1",
      fileName: null,
      rawStatus: IssueStatus.InProgress,
      status: IssueStatus.InProgress,
      priority: Priority.High,
      latestVersion: 1,
      createdById: "user-2",
      assigneeId: "user-1",
      assignee: ENDPOINT_ASSIGNEE,
      approverId: null,
      approver: null,
      repositorySnapshot: { repositories: [], source: SnapshotSource.None },
      templateForType: null,
      sortOrder: 1000,
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedAt: new Date("2026-06-02T00:00:00.000Z"),
    });
  });

  it("maps a PRD subtype endpoint to the PRD document type", () => {
    const doc = endpointToDocument(
      makeEndpoint({
        subtype: ArtifactSubtype.Prd,
        status: DocumentStatus.Approved,
      })
    );
    expect(doc.type).toBe(DocumentType.Prd);
    expect(doc.status).toBe(DocumentStatus.Approved);
    expect(doc.rawStatus).toBe(DocumentStatus.Approved);
  });

  it("retains an unrecognized endpoint status beside the safe fallback", () => {
    const doc = endpointToDocument(makeEndpoint({ status: "future-state" }));

    expect(doc.status).toBe(IssueStatus.Backlog);
    expect(doc.rawStatus).toBe("future-state");
  });

  it("retains the endpoint's status-write capability", () => {
    const statusMutation: DocumentStatusMutationCapability = {
      allowedStatuses: [IssueStatus.InProgress, IssueStatus.Done],
      expectedStatusByIdField: "expectedStatusById",
      expectedStatusField: "expectedStatus",
      permissions: {
        [DocumentStatusMutationOperation.Bulk]: false,
        [DocumentStatusMutationOperation.Single]: true,
      },
    };

    expect(
      endpointToDocument(makeEndpoint({ statusMutation })).statusMutation
    ).toEqual(statusMutation);
  });

  it("defaults a null subtype to Feature", () => {
    expect(endpointToDocument(makeEndpoint({ subtype: null })).type).toBe(
      DocumentType.Feature
    );
  });

  it("falls back to empty defaults for the fields the endpoint omits", () => {
    const doc = endpointToDocument(
      makeEndpoint({ slug: null, priority: null, createdById: null })
    );
    expect(doc.slug).toBe("");
    expect(doc.createdById).toBe("");
  });

  it("passes an unset priority through instead of folding it to Medium", () => {
    // BEHAVIOUR CHANGE (ISS-9665). This adapter used to answer `MEDIUM` for an
    // endpoint reporting `null`, so the same artifact showed one priority on a
    // detail page's linked-artifact row and another on `/search`. The operator's
    // ruling is that "no priority" is a real state, so the adapter reports what
    // the endpoint reported. What a SURFACE renders for that null is gated by
    // `ARTIFACT_PRIORITY_UNSET_FLAG_KEY`, not decided here.
    expect(endpointToDocument(makeEndpoint({ priority: null })).priority).toBe(
      null
    );
  });

  it.each([Priority.Low, Priority.Medium, Priority.High, Priority.Urgent])(
    "still reports a real priority the endpoint carries: %s",
    (priority) => {
      expect(endpointToDocument(makeEndpoint({ priority })).priority).toBe(
        priority
      );
    }
  );

  it("passes a version-skewed endpoint priority token through as unknown data", () => {
    // The sibling of the case above: a mapper blanket-nulled rather than
    // un-folded would pass that one and fail this. A newer API token is preserved
    // for the UI layer to label as unknown instead of misreporting "No priority".
    expect(
      endpointToDocument(
        makeEndpoint({ priority: UNKNOWN_PRIORITY as Priority })
      ).priority
    ).toBe(UNKNOWN_PRIORITY);
  });

  it("falls back to Backlog for an out-of-contract feature status", () => {
    const doc = endpointToDocument(makeEndpoint({ status: "SOMETHING_NEW" }));
    expect(doc.status).toBe(IssueStatus.Backlog);
  });

  // ISS-7732: these two must be able to fail independently. Passing the
  // hydrated user through satisfies the first; keeping a genuinely absent
  // assignee absent satisfies the second. Hardcoding either value fails one.
  it("carries the hydrated assignee through for an assigned endpoint", () => {
    const doc = endpointToDocument(
      makeEndpoint({ assigneeId: "user-1", assignee: ENDPOINT_ASSIGNEE })
    );
    expect(doc.assignee).toEqual(ENDPOINT_ASSIGNEE);
    expect(doc.assigneeId).toBe("user-1");
  });

  it("keeps assignee null for a genuinely unassigned endpoint", () => {
    const doc = endpointToDocument(
      makeEndpoint({ assigneeId: null, assignee: null })
    );
    expect(doc.assignee).toBeNull();
    expect(doc.assigneeId).toBeNull();
  });

  // ISS-7732 deploy skew: `assignee` is additive on the wire, so an API build
  // that predates it omits the KEY — not `null`. Two things are proven here.
  // Compile time: `makeSkewedEndpoint` returns an `ArtifactLinkEndpoint` built
  // without the key, which only typechecks while the shared contract keeps
  // `assignee` optional; making it required again fails `tsc` on this line.
  // Runtime: the adapter must hand `ArtifactRow` a `BasicUser | null`, so the
  // missing value is normalized to `null` here rather than passed through as
  // `undefined` into a slot the `Document` shape promises is never undefined.
  it("normalizes an absent assignee key to null", () => {
    const skewed = makeSkewedEndpoint();
    expect("assignee" in skewed).toBe(false);

    const doc = endpointToDocument(skewed);

    expect(doc.assignee).toBeNull();
  });
});

/** An endpoint as an API build from before ISS-7732 serializes it: no key. */
function makeSkewedEndpoint(): ArtifactLinkEndpoint {
  const { assignee: _omitted, ...withoutAssignee } = makeEndpoint({});
  return withoutAssignee;
}
