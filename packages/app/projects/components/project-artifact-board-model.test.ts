import { ArtifactSubtype, ArtifactType } from "@repo/api/src/types/artifact";
import { ARTIFACT_STATUS_ROOT } from "@repo/api/src/types/artifact-status";
import { ARTIFACT_STATUS_DISPLAY_LABELS } from "@repo/api/src/types/artifact-status-display";
import { Priority } from "@repo/api/src/types/common";
import { DocumentStatus, IssueStatus } from "@repo/api/src/types/document";
import {
  PROJECT_ARTIFACT_LANE_POLICY_VERSION,
  type ProjectArtifactLanePolicy,
  ProjectArtifactLanePolicyReason,
} from "@repo/api/src/types/project-artifact-lane-policy";
import {
  ProjectArtifactPlacementGroupField,
  ProjectArtifactPlacementPosition,
  ProjectArtifactPlacementSource,
} from "@repo/api/src/types/project-artifact-placement";
import type {
  DetailedArtifact,
  ProjectTreeDetailsResponse,
} from "@repo/api/src/types/project-tree";
import {
  LEGACY_WAITING_WIRE_STATUS,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import { GroupByMode } from "@repo/app/documents/lib/group-by";
import {
  ArtifactBoardDropPosition,
  ArtifactBoardSelectionIntent,
} from "@repo/app/shared/components/generic-artifact-surface/artifact-board/artifact-board-model";
import { GenericArtifactKind } from "@repo/app/shared/components/generic-artifact-surface/generic-artifact-status";
import { DocumentColumn } from "@repo/app/shared/hooks/use-column-visibility";
import { describe, expect, it } from "vitest";
import { ProjectArtifactBoardField } from "./project-artifact-board";
import {
  boardMoveRequest,
  crossProjectBoardMoveRequest,
  orderProjectBoardLanes,
  projectBoardFieldsFromListColumns,
  projectBoardItems,
  projectBoardLanePolicyResult,
  projectBoardLanes,
  projectBoardManualOrderAllowsTarget,
  projectBoardSelection,
  projectBoardSharedStatusItems,
  projectBoardSharedStatusLanes,
  projectBoardSharedStatusRootFromRaw,
  projectBoardSharedStatusTargets,
  projectBoardTypeLabel,
  projectBoardVisibleFields,
} from "./project-artifact-board-model";

function artifact(
  id: string,
  status: IssueStatus = IssueStatus.Todo
): DetailedArtifact {
  return {
    assignee: null,
    assigneeId: null,
    createdAt: new Date("2026-10-19T00:00:00.000Z"),
    createdById: null,
    dueDate: null,
    externalUrl: null,
    id,
    name: id,
    organizationId: "00000000-0000-4000-8000-000000000010",
    priority: Priority.Medium,
    projectId: "00000000-0000-4000-8000-000000000011",
    slug: `ISS-${id}`,
    sortOrder: 1024,
    status,
    subtype: ArtifactSubtype.Feature,
    type: ArtifactType.Document,
    updatedAt: new Date("2026-10-19T00:00:00.000Z"),
  };
}

function tree(rootIds: readonly string[]): ProjectTreeDetailsResponse {
  return {
    externalParents: [],
    nodes: rootIds.map((id) => ({ children: [], root: artifact(id) })),
  };
}

describe("PRD-724 AC-001/AC-004 Project board derivation", () => {
  it("keeps descendants attached while lanes contain roots only", () => {
    const source = tree(["root"]);
    source.nodes[0]?.children.push({
      ...artifact("child", IssueStatus.Done),
      depth: 1,
      linkType: "PRODUCES",
      parentId: "root",
    });
    const items = projectBoardItems(source, GroupByMode.Status);
    expect(items.map((item) => [item.id, item.rootId])).toEqual([
      ["root", "root"],
      ["child", "root"],
    ]);
    expect(
      projectBoardLanes(items, GroupByMode.Status)
        .flatMap((lane) => lane.rootIds)
        .filter((id) => id === "child")
    ).toEqual([]);
  });

  it("maps Options columns and leaves grouped-field omission to the champion", () => {
    expect(
      projectBoardVisibleFields([
        DocumentColumn.Priority,
        DocumentColumn.Assignee,
        DocumentColumn.Tags,
      ])
    ).toEqual([
      ProjectArtifactBoardField.Status,
      ProjectArtifactBoardField.Priority,
      ProjectArtifactBoardField.Owner,
      ProjectArtifactBoardField.Tags,
    ]);
  });
});

describe("ISS-12929 724-F4 portable project Options to card fields", () => {
  it("maps every list column the card shares, PRD-595 baseline included", () => {
    expect(
      projectBoardFieldsFromListColumns(
        new Set([
          "owner",
          "collaborators",
          "relatedSessions",
          "comments",
          "updated",
          "currentVersion",
          "tags",
          "priority",
          "parent",
        ])
      )
    ).toEqual([
      ProjectArtifactBoardField.Status,
      ProjectArtifactBoardField.Priority,
      ProjectArtifactBoardField.Owner,
      ProjectArtifactBoardField.Collaborators,
      ProjectArtifactBoardField.Tags,
      ProjectArtifactBoardField.RelatedSessions,
      ProjectArtifactBoardField.Comments,
      ProjectArtifactBoardField.Updated,
      ProjectArtifactBoardField.CurrentVersion,
    ]);
  });

  it("drops a field whose column Options hides", () => {
    expect(
      projectBoardFieldsFromListColumns(new Set(["owner", "comments"]))
    ).toEqual([
      ProjectArtifactBoardField.Status,
      ProjectArtifactBoardField.Owner,
      ProjectArtifactBoardField.Comments,
    ]);
  });
});

describe("ISS-12929 724-F9 card type label", () => {
  it("labels each artifact type with its own shipped label", () => {
    const deployment = {
      ...artifact("deployment"),
      slug: null,
      subtype: null,
      type: ArtifactType.Deployment,
    };
    expect(projectBoardTypeLabel(deployment)).toBe(
      GenericArtifactKind.Deployment
    );
    expect(
      projectBoardTypeLabel({ ...deployment, type: ArtifactType.Branch })
    ).toBe("Pull Request");
    expect(
      projectBoardTypeLabel({ ...deployment, type: ArtifactType.Session })
    ).toBe("Session");
  });
});

describe("ISS-12908 shared status board lanes", () => {
  it("keeps the flag-off raw lanes and folds flag-on cards into five ranked roots without changing raw labels", () => {
    const source = tree(["issue", "document"]);
    source.nodes[0]!.root.status = IssueStatus.Triage;
    source.nodes[1]!.root.status = DocumentStatus.Draft;
    source.nodes[1]!.root.subtype = ArtifactSubtype.Prd;

    const rawItems = projectBoardItems(source, GroupByMode.Status);
    const rawLanes = projectBoardLanes(rawItems, GroupByMode.Status);
    expect(rawLanes.map((lane) => lane.id)).toContain(IssueStatus.Triage);
    expect(rawLanes.map((lane) => lane.id)).toContain(DocumentStatus.Draft);

    const sharedItems = projectBoardSharedStatusItems(source);
    const sharedLanes = projectBoardSharedStatusLanes(sharedItems, [
      "issue",
      "document",
    ]);
    expect(sharedLanes.map((lane) => lane.id)).toEqual(
      Object.values(ARTIFACT_STATUS_ROOT)
    );
    expect(sharedLanes.map((lane) => lane.label)).toEqual(
      Object.values(ARTIFACT_STATUS_ROOT).map(
        (root) => ARTIFACT_STATUS_DISPLAY_LABELS[root]
      )
    );
    expect(
      sharedLanes.find((lane) => lane.id === ARTIFACT_STATUS_ROOT.Todo)?.rootIds
    ).toEqual(["issue"]);
    expect(
      sharedLanes.find((lane) => lane.id === ARTIFACT_STATUS_ROOT.InProgress)
        ?.rootIds
    ).toEqual(["document"]);
    expect(
      sharedItems.find((item) => item.id === "issue")?.fieldValues.status
    ).toBe(rawItems.find((item) => item.id === "issue")?.fieldValues.status);
    expect(
      sharedItems.find((item) => item.id === "document")?.fieldValues.status
    ).toBe(rawItems.find((item) => item.id === "document")?.fieldValues.status);
  });

  it("resolves Issue root moves to valid raw statuses and refuses server-disallowed targets", () => {
    const source = tree(["issue"]);
    expect(
      projectBoardSharedStatusTargets(
        source,
        ["issue"],
        ARTIFACT_STATUS_ROOT.InReview
      )
    ).toEqual({ issue: IssueStatus.InReview });
    source.nodes[0]!.root.statusMutation = {
      allowedStatuses: [IssueStatus.Todo],
      expectedStatusField: "expectedStatus",
      expectedStatusByIdField: "expectedStatusById",
    };
    expect(
      projectBoardSharedStatusTargets(
        source,
        ["issue"],
        ARTIFACT_STATUS_ROOT.InReview
      )
    ).toBeNull();
  });

  it("resolves an unambiguous Document move and refuses ambiguous Document roots", () => {
    const source = tree(["document"]);
    source.nodes[0]!.root.status = DocumentStatus.Draft;
    source.nodes[0]!.root.subtype = ArtifactSubtype.Prd;
    expect(
      projectBoardSharedStatusTargets(
        source,
        ["document"],
        ARTIFACT_STATUS_ROOT.InReview
      )
    ).toEqual({ document: DocumentStatus.InReview });
    expect(
      projectBoardSharedStatusTargets(
        source,
        ["document"],
        ARTIFACT_STATUS_ROOT.Done
      )
    ).toBeNull();
  });

  it("keeps the response rootIds order across mixed raw-status buckets", () => {
    const source = tree(["first", "third", "second"]);
    source.nodes[0]!.root.status = IssueStatus.Todo;
    source.nodes[1]!.root.status = IssueStatus.Todo;
    source.nodes[2]!.root.status = IssueStatus.Triage;
    const items = projectBoardSharedStatusItems(source);

    expect(
      projectBoardSharedStatusLanes(items, ["first", "second", "third"]).find(
        (lane) => lane.id === ARTIFACT_STATUS_ROOT.Todo
      )?.rootIds
    ).toEqual(["first", "second", "third"]);
  });

  it("folds a legacy waiting session count into the same root as its card", () => {
    const source = tree(["active", "waiting"]);
    source.nodes[0]!.root.type = ArtifactType.Session;
    source.nodes[0]!.root.subtype = null;
    source.nodes[0]!.root.status = SESSION_STATUS.ACTIVE;
    source.nodes[1]!.root.type = ArtifactType.Session;
    source.nodes[1]!.root.subtype = null;
    source.nodes[1]!.root.status = LEGACY_WAITING_WIRE_STATUS;

    expect(
      projectBoardSharedStatusLanes(projectBoardSharedStatusItems(source), [
        "active",
        "waiting",
      ]).find((lane) => lane.id === ARTIFACT_STATUS_ROOT.InProgress)?.rootIds
    ).toEqual(["active", "waiting"]);
    expect(
      projectBoardSharedStatusRootFromRaw(LEGACY_WAITING_WIRE_STATUS)
    ).toBe(ARTIFACT_STATUS_ROOT.InProgress);
  });

  it("resolves mixed selected Issue and Document raw targets independently", () => {
    const source = tree(["backlog", "progress", "document"]);
    source.nodes[0]!.root.status = IssueStatus.Backlog;
    source.nodes[1]!.root.status = IssueStatus.InProgress;
    source.nodes[2]!.root.status = DocumentStatus.Draft;
    source.nodes[2]!.root.subtype = ArtifactSubtype.Prd;

    expect(
      projectBoardSharedStatusTargets(
        source,
        ["backlog", "progress"],
        ARTIFACT_STATUS_ROOT.Todo
      )
    ).toEqual({ backlog: IssueStatus.Backlog, progress: IssueStatus.Todo });
    expect(
      projectBoardSharedStatusTargets(
        source,
        ["progress", "document"],
        ARTIFACT_STATUS_ROOT.InReview
      )
    ).toEqual({
      progress: IssueStatus.InReview,
      document: DocumentStatus.InReview,
    });
  });

  it("evaluates lane policy against each selected artifact's raw target", () => {
    const source = tree(["backlog", "progress"]);
    source.nodes[0]!.root.status = IssueStatus.Backlog;
    source.nodes[1]!.root.status = IssueStatus.InProgress;
    const items = projectBoardItems(source, GroupByMode.Status);
    const targets = projectBoardSharedStatusTargets(
      source,
      ["backlog", "progress"],
      ARTIFACT_STATUS_ROOT.Todo
    );
    expect(targets).toEqual({
      backlog: IssueStatus.Backlog,
      progress: IssueStatus.Todo,
    });
    expect(
      projectBoardLanePolicyResult({
        items,
        policy: {
          field: ProjectArtifactPlacementGroupField.Status,
          revision: "policy-v1",
          transitions: { [IssueStatus.InProgress]: [IssueStatus.Done] },
          version: PROJECT_ARTIFACT_LANE_POLICY_VERSION,
        },
        rootIds: ["backlog", "progress"],
        targetLaneId: IssueStatus.Backlog,
        targetLaneIdsByRootId: targets ?? undefined,
      })
    ).toEqual({
      allowed: false,
      reason: ProjectArtifactLanePolicyReason.UnsupportedTransition,
    });
  });
});

describe("PRD-724 AC-002 Project P4 adapter", () => {
  it("CT-18 counts selected roots and carries the policy revision to P4", () => {
    const source = tree(["root", "second"]);
    const items = projectBoardItems(source, GroupByMode.Status);
    const policy: ProjectArtifactLanePolicy = {
      field: ProjectArtifactPlacementGroupField.Status,
      revision: "policy-v1",
      transitions: { [IssueStatus.Todo]: [IssueStatus.InProgress] },
      version: PROJECT_ARTIFACT_LANE_POLICY_VERSION,
      wipLimitByLane: { [IssueStatus.InProgress]: 1 },
    };
    expect(
      projectBoardLanePolicyResult({
        expectedPolicyRevision: policy.revision,
        items,
        policy,
        rootIds: ["root", "second"],
        targetLaneId: IssueStatus.InProgress,
      })
    ).toEqual({
      allowed: false,
      reason: ProjectArtifactLanePolicyReason.WipLimitReached,
    });
    expect(
      boardMoveRequest({
        groupBy: GroupByMode.Status,
        lanePolicy: policy,
        move: {
          rootIds: ["root"],
          sourceLaneId: IssueStatus.Todo,
          target: {
            laneId: IssueStatus.InProgress,
            position: ArtifactBoardDropPosition.End,
          },
        },
        projectId: "project",
        source: ProjectArtifactPlacementSource.Pointer,
        targetLaneRootIds: [],
      }).lanePatch?.expectedPolicyRevision
    ).toBe(policy.revision);
  });

  it("CT-09 keeps unknown lanes stable after the persisted lane order", () => {
    expect(
      orderProjectBoardLanes(
        [{ id: "todo" }, { id: "done" }, { id: "unknown" }],
        ["done", "todo"]
      ).map((lane) => lane.id)
    ).toEqual(["done", "todo", "unknown"]);
  });

  it("CT-09 disables only in-lane manual ordering", () => {
    const item = { laneId: "todo" };
    expect(
      projectBoardManualOrderAllowsTarget(
        item,
        {
          laneId: "todo",
          position: ArtifactBoardDropPosition.End,
        },
        false
      )
    ).toBe(false);
    expect(
      projectBoardManualOrderAllowsTarget(
        item,
        {
          laneId: "done",
          position: ArtifactBoardDropPosition.End,
        },
        false
      )
    ).toBe(true);
  });

  it("builds one exact menu/keyboard-compatible move request", () => {
    const request = boardMoveRequest({
      groupBy: GroupByMode.Status,
      move: {
        rootIds: ["root"],
        sourceLaneId: IssueStatus.Todo,
        target: {
          laneId: IssueStatus.Done,
          position: ArtifactBoardDropPosition.Before,
          referenceRootId: "reference",
        },
      },
      projectId: "project",
      source: ProjectArtifactPlacementSource.Keyboard,
      targetLaneRootIds: ["reference"],
    });
    expect(request).toMatchObject({
      destinationProjectId: "project",
      lanePatch: { field: "status", value: IssueStatus.Done },
      position: ProjectArtifactPlacementPosition.Before,
      source: ProjectArtifactPlacementSource.Keyboard,
      sourceArtifactIds: ["root"],
      targetArtifactId: "reference",
    });
  });

  it("places at lane end relative to the last root outside the moving set", () => {
    const request = boardMoveRequest({
      groupBy: GroupByMode.Status,
      move: {
        rootIds: ["root"],
        sourceLaneId: IssueStatus.Todo,
        target: {
          laneId: IssueStatus.Todo,
          position: ArtifactBoardDropPosition.End,
        },
      },
      projectId: "project",
      source: ProjectArtifactPlacementSource.Pointer,
      targetLaneRootIds: ["other", "root"],
    });

    expect(request).toMatchObject({
      position: ProjectArtifactPlacementPosition.After,
      targetArtifactId: "other",
    });
  });

  it("resolves a selected reference before sending the board move", () => {
    const request = boardMoveRequest({
      groupBy: GroupByMode.Status,
      move: {
        rootIds: ["first", "second"],
        sourceLaneId: IssueStatus.Todo,
        target: {
          laneId: IssueStatus.Todo,
          position: ArtifactBoardDropPosition.Before,
          referenceRootId: "second",
        },
      },
      projectId: "project",
      source: ProjectArtifactPlacementSource.Pointer,
      targetLaneRootIds: ["first", "second", "stationary"],
    });

    expect(request).toMatchObject({
      position: ProjectArtifactPlacementPosition.Before,
      sourceArtifactIds: ["first", "second"],
      targetArtifactId: "stationary",
    });
  });

  it("uses the canonical root placement for cross-project moves", () => {
    const request = crossProjectBoardMoveRequest({
      destinationProjectId: "00000000-0000-4000-8000-000000000020",
      selectedRootIds: ["root"],
    });
    expect(request.destinationProjectId).toBe(
      "00000000-0000-4000-8000-000000000020"
    );
    expect(request.sourceArtifactIds).toEqual(["root"]);
    expect(request.position).toBe(ProjectArtifactPlacementPosition.Root);
  });

  it("preserves range and toggle selection semantics", () => {
    const anchor = { current: "root" };
    expect(
      projectBoardSelection(
        ["root"],
        ["root", "middle", "last"],
        "last",
        ArtifactBoardSelectionIntent.Range,
        anchor
      )
    ).toEqual(["root", "middle", "last"]);
    expect(
      projectBoardSelection(
        ["root", "middle"],
        ["root", "middle", "last"],
        "middle",
        ArtifactBoardSelectionIntent.Toggle,
        anchor
      )
    ).toEqual(["root"]);
  });
});
