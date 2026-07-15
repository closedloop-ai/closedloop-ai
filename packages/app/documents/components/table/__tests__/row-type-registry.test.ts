import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  DocumentStatus,
  DocumentType,
  FeatureStatus,
} from "@repo/api/src/types/document";
import { GitHubPRState } from "@repo/api/src/types/github";
import { ProjectStatus } from "@repo/api/src/types/project";
import {
  getRowTypeConfig,
  isDocumentRowItem,
  isRowItemCompleted,
  isTerminalSessionStatus,
} from "@repo/app/documents/components/table/row-type-registry";
import {
  makeArtifact,
  makeFeatureArtifact,
  makePlanArtifact,
  makeRawArtifact,
} from "@repo/app/shared/test-fixtures/documents";
import { makeProject } from "@repo/app/shared/test-fixtures/project";
import { SESSION_STATUS } from "@closedloop-ai/loops-api/session-status";
import { describe, expect, it } from "vitest";

describe("getRowTypeConfig", () => {
  it("returns null for project rows (not artifacts)", () => {
    expect(
      getRowTypeConfig({ kind: "project", data: makeProject() })
    ).toBeNull();
  });

  it("derives document config from the subtype (badge, route, capabilities)", () => {
    const prd = getRowTypeConfig({ kind: "document", data: makeArtifact() });
    expect(prd?.badgeLabel).toBe("PRD");
    expect(prd?.route).toBe("/prds/PRD-1");
    expect(prd?.editable).toBe(true);
    expect(prd?.deletable).toBe(true);

    const plan = getRowTypeConfig({
      kind: "document",
      data: makePlanArtifact(),
    });
    expect(plan?.badgeLabel).toBe("Plan");
    expect(plan?.route).toBe("/implementation-plans/PLAN-1");

    const feature = getRowTypeConfig({
      kind: "document",
      data: makeFeatureArtifact(),
    });
    expect(feature?.badgeLabel).toBe("Feature");
    expect(feature?.route).toBe("/features/FEAT-1");
    // Delete dialog copy comes from the registry (PLN-874 Task 3.5):
    // Features delete as "Feature", other document subtypes as "Document",
    // both with the dialog's default body.
    expect(feature?.deleteDialogTitle).toBe("Feature");
    expect(prd?.deleteDialogTitle).toBe("Document");
    expect(prd?.deleteDialogDescription).toBeNull();

    const template = getRowTypeConfig({
      kind: "document",
      data: makeArtifact({ type: DocumentType.Template }),
    });
    expect(template?.badgeLabel).toBe("Template");
    // Templates have no editor page.
    expect(template?.route).toBeNull();
  });

  it("configures branch rows as read-only Pull Request rows routed to the build page", () => {
    const config = getRowTypeConfig({
      kind: "branch",
      data: makeRawArtifact(ArtifactType.Branch, {
        id: "br-1",
        status: "MERGED",
      }),
    });
    expect(config?.badgeLabel).toBe("Pull Request");
    expect(config?.route).toBe("/build/br-1");
    expect(config?.editable).toBe(false);
    expect(config?.deletable).toBe(true);
    expect(config?.statusIcon).toBe("complete");
    expect(config?.statusLabel).toBe("Merged");
    // Branch deletes only remove the Closedloop record — the dialog copy
    // must say so and must not imply the GitHub PR/branch is touched.
    expect(config?.deleteDialogTitle).toBe("Pull Request from Closedloop");
    expect(config?.deleteDialogDescription?.("My PR")).toContain(
      'removes "My PR" from Closedloop only'
    );
  });

  it("configures session rows: navigable to the session detail page, not deletable", () => {
    const config = getRowTypeConfig({
      kind: "session",
      data: makeRawArtifact(ArtifactType.Session, { id: "ses-1" }),
    });
    expect(config?.badgeLabel).toBe("Session");
    // The SESSION artifact id is the agent-session id.
    expect(config?.route).toBe("/sessions/ses-1");
    expect(config?.editable).toBe(false);
    // No session-delete endpoint exists (DELETE /branches/:id is BRANCH-scoped).
    expect(config?.deletable).toBe(false);
  });

  it("maps free-form session statuses onto status icons", () => {
    const iconFor = (status: string) =>
      getRowTypeConfig({
        kind: "session",
        data: makeRawArtifact(ArtifactType.Session, { status }),
      })?.statusIcon;

    expect(iconFor("completed")).toBe("complete");
    expect(iconFor("failed")).toBe("wont-do");
    expect(iconFor("error")).toBe("wont-do");
    expect(iconFor(SESSION_STATUS.ABANDONED)).toBe("wont-do");
    expect(iconFor("waiting")).toBe("in-review");
    expect(iconFor("active")).toBe("in-progress");
    expect(iconFor("some-new-harness-state")).toBe("in-progress");
  });

  it("maps branch statuses onto status labels", () => {
    const labelFor = (status: string) =>
      getRowTypeConfig({
        kind: "branch",
        data: makeRawArtifact(ArtifactType.Branch, { status }),
      })?.statusLabel;

    expect(labelFor(GitHubPRState.Open)).toBe("Open");
    expect(labelFor(GitHubPRState.Merged)).toBe("Merged");
    expect(labelFor(GitHubPRState.Closed)).toBe("Closed");
    expect(labelFor("ACTIVE")).toBe("Active");
  });

  it("maps free-form session statuses onto status labels", () => {
    const labelFor = (status: string) =>
      getRowTypeConfig({
        kind: "session",
        data: makeRawArtifact(ArtifactType.Session, { status }),
      })?.statusLabel;

    expect(labelFor(SESSION_STATUS.COMPLETED)).toBe("Completed");
    expect(labelFor(SESSION_STATUS.WAITING)).toBe("Waiting");
    expect(labelFor(SESSION_STATUS.ACTIVE)).toBe("Active");
    expect(labelFor(SESSION_STATUS.ERROR)).toBe("Failed");
    expect(labelFor(SESSION_STATUS.ABANDONED)).toBe("Abandoned");
    expect(labelFor("some-new-harness-state")).toBe("Some new harness state");
  });
});

describe("isTerminalSessionStatus", () => {
  it("pattern-matches terminal variants the same way the status-icon mapper does", () => {
    expect(isTerminalSessionStatus("completed")).toBe(true);
    expect(isTerminalSessionStatus(SESSION_STATUS.ABANDONED)).toBe(true);
    expect(isTerminalSessionStatus("failed")).toBe(true);
    expect(isTerminalSessionStatus("error")).toBe(true);
    expect(isTerminalSessionStatus("execution_failed")).toBe(true);
    expect(isTerminalSessionStatus("timeout_error")).toBe(true);
    expect(isTerminalSessionStatus("active")).toBe(false);
    expect(isTerminalSessionStatus("waiting")).toBe(false);
  });
});

describe("isRowItemCompleted", () => {
  it("evaluates completion against each row kind's status vocabulary", () => {
    // Documents hide only on EXECUTED / OBSOLETE — an APPROVED document is still
    // in flight (awaiting execution) and stays visible.
    expect(
      isRowItemCompleted({
        kind: "document",
        data: makeArtifact({ status: DocumentStatus.Approved }),
      })
    ).toBe(false);
    expect(
      isRowItemCompleted({
        kind: "document",
        data: makeArtifact({ status: DocumentStatus.Executed }),
      })
    ).toBe(true);
    expect(
      isRowItemCompleted({
        kind: "document",
        data: makeArtifact({ status: DocumentStatus.Obsolete }),
      })
    ).toBe(true);
    expect(
      isRowItemCompleted({
        kind: "document",
        data: makeArtifact({ status: DocumentStatus.Draft }),
      })
    ).toBe(false);
    // Features keep their own terminal vocabulary (DONE / CANCELED).
    expect(
      isRowItemCompleted({
        kind: "document",
        data: makeFeatureArtifact({ status: FeatureStatus.Done }),
      })
    ).toBe(true);
    expect(
      isRowItemCompleted({
        kind: "document",
        data: makeFeatureArtifact({ status: FeatureStatus.Canceled }),
      })
    ).toBe(true);
    expect(
      isRowItemCompleted({
        kind: "document",
        data: makeFeatureArtifact({ status: FeatureStatus.InProgress }),
      })
    ).toBe(false);
    expect(
      isRowItemCompleted({
        kind: "branch",
        data: makeRawArtifact(ArtifactType.Branch, {
          status: GitHubPRState.Merged,
        }),
      })
    ).toBe(true);
    expect(
      isRowItemCompleted({
        kind: "branch",
        data: makeRawArtifact(ArtifactType.Branch, {
          status: GitHubPRState.Open,
        }),
      })
    ).toBe(false);
    // Sessions use the pattern-matched terminal definition, so harness
    // variants like "execution_failed" count as completed too.
    expect(
      isRowItemCompleted({
        kind: "session",
        data: makeRawArtifact(ArtifactType.Session, {
          status: "execution_failed",
        }),
      })
    ).toBe(true);
    expect(
      isRowItemCompleted({
        kind: "session",
        data: makeRawArtifact(ArtifactType.Session, {
          status: SESSION_STATUS.ABANDONED,
        }),
      })
    ).toBe(true);
    expect(
      isRowItemCompleted({
        kind: "session",
        data: makeRawArtifact(ArtifactType.Session, { status: "active" }),
      })
    ).toBe(false);
    // Projects are never hidden — even a COMPLETED project is not "completed"
    // in hide-completed terms.
    expect(
      isRowItemCompleted({
        kind: "project",
        data: makeProject({ status: ProjectStatus.Completed }),
      })
    ).toBe(false);
  });
});

describe("isDocumentRowItem", () => {
  it("narrows to document rows only", () => {
    expect(isDocumentRowItem({ kind: "document", data: makeArtifact() })).toBe(
      true
    );
    expect(
      isDocumentRowItem({
        kind: "branch",
        data: makeRawArtifact(ArtifactType.Branch),
      })
    ).toBe(false);
    expect(
      isDocumentRowItem({
        kind: "session",
        data: makeRawArtifact(ArtifactType.Session),
      })
    ).toBe(false);
  });
});
