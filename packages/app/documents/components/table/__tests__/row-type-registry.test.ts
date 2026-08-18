import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  DocumentStatus,
  DocumentType,
  IssueStatus,
} from "@repo/api/src/types/document";
import { GitHubPRState } from "@repo/api/src/types/github";
import { ProjectStatus } from "@repo/api/src/types/project";
import {
  DISPLAYED_SESSION_STATUS,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
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
    expect(feature?.badgeLabel).toBe("Issue");
    expect(feature?.route).toBe("/issues/FEAT-1");
    // Delete dialog copy comes from the registry (PLN-874 Task 3.5):
    // Features (FEATURE subtype) delete as "Issue", other document subtypes as
    // "Document", both with the dialog's default body.
    expect(feature?.deleteDialogTitle).toBe("Issue");
    expect(prd?.deleteDialogTitle).toBe("Document");
    expect(prd?.deleteDialogDescription).toBeNull();

    const template = getRowTypeConfig({
      kind: "document",
      data: makeArtifact({ type: DocumentType.Template }),
    });
    expect(template?.badgeLabel).toBe("Template");
    // Templates have no editor page.
    expect(template?.route).toBeNull();

    // ISS-4382: DOC rows are now navigable — they route to the DOC editor at
    // /documents/:slug, so a Documents-index row is clickable.
    const doc = getRowTypeConfig({
      kind: "document",
      data: makeArtifact({ type: DocumentType.Doc, slug: "onboarding" }),
    });
    expect(doc?.route).toBe("/documents/onboarding");
    expect(doc?.deleteDialogTitle).toBe("Document");
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

    // ISS-4586: completed/abandoned collapse into `inactive`, which takes the
    // "complete" (finished) icon. `error` keeps the wont-do icon; waiting keeps
    // in-review; active keeps in-progress.
    //
    // ISS-5592 (2026-08-15) retired the `failed` alias, so it now takes the
    // in-flight icon like any spelling this build cannot read — asserted below
    // alongside the other unrecognized value, not here.
    expect(iconFor(SESSION_STATUS.INACTIVE)).toBe("complete");
    expect(iconFor("error")).toBe("wont-do");
    expect(iconFor("waiting")).toBe("in-review");
    expect(iconFor("active")).toBe("in-progress");
    // Unknown → active (in-flight), never a fabricated terminal icon (shafty023 P2).
    expect(iconFor("some-new-harness-state")).toBe("in-progress");
    expect(iconFor("failed")).toBe("in-progress");
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

    // ISS-4586: completed/abandoned/unknown all read "Inactive"; waiting stays
    // "Waiting", error reads "Failed" — one label per displayed state.
    expect(labelFor(SESSION_STATUS.INACTIVE)).toBe("Inactive");
    expect(labelFor(DISPLAYED_SESSION_STATUS.WAITING)).toBe("Waiting");
    expect(labelFor(SESSION_STATUS.ACTIVE)).toBe("Active");
    expect(labelFor(SESSION_STATUS.ERROR)).toBe("Failed");
    // Unknown → active (in-flight), never "Inactive" (shafty023 P2).
    expect(labelFor("some-new-harness-state")).toBe("Active");
  });
});

describe("isTerminalSessionStatus", () => {
  // ISS-5592: this case asserted PATTERN matching -- `failed`,
  // `execution_failed` and `timeout_error` were terminal by way of two
  // `includes()` arms. The expectation changed with the code: terminality is
  // now decided by the canonical fold alone, so a spelling this build does not
  // recognise is not terminal here, exactly as it is not terminal anywhere
  // else. The arms were an open-set scan standing in for a closed vocabulary,
  // and the hide-completed filter was the only surface that honored them.
  it("decides terminality by the canonical fold", () => {
    expect(isTerminalSessionStatus("error")).toBe(true);
    expect(isTerminalSessionStatus("inactive")).toBe(true);
    expect(isTerminalSessionStatus("ERROR")).toBe(true);
    expect(isTerminalSessionStatus("active")).toBe(false);
    expect(isTerminalSessionStatus("waiting")).toBe(false);
  });

  it("no longer treats an unrecognised spelling as terminal", () => {
    // These three were the whole reason the substring arms existed. They are
    // unrecognised spellings, so they fold to `active` and read "Unknown" on
    // every other surface; this table now agrees instead of hiding them.
    expect(isTerminalSessionStatus("failed")).toBe(false);
    expect(isTerminalSessionStatus("execution_failed")).toBe(false);
    expect(isTerminalSessionStatus("timeout_error")).toBe(false);
  });

  it("does not match the substring false positives the arms admitted", () => {
    // The negative test the harness-discrimination rule asks for. Each of these
    // contains "fail" or "error" and means the OPPOSITE of terminal; under the
    // removed arms all four were classified as finished runs and hidden.
    expect(isTerminalSessionStatus("no_error")).toBe(false);
    expect(isTerminalSessionStatus("error_recovery")).toBe(false);
    expect(isTerminalSessionStatus("failover")).toBe(false);
    expect(isTerminalSessionStatus("unfailed")).toBe(false);
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
        data: makeFeatureArtifact({ status: IssueStatus.Done }),
      })
    ).toBe(true);
    expect(
      isRowItemCompleted({
        kind: "document",
        data: makeFeatureArtifact({ status: IssueStatus.Canceled }),
      })
    ).toBe(true);
    expect(
      isRowItemCompleted({
        kind: "document",
        data: makeFeatureArtifact({ status: IssueStatus.InProgress }),
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
    // ISS-5592: sessions use the CANONICAL fold, so an unrecognised harness
    // variant is not completed. This asserted the opposite while the substring
    // arms existed; the expectation moved with them, and the row now stays
    // visible here exactly as it reads Active/Unknown everywhere else.
    expect(
      isRowItemCompleted({
        kind: "session",
        data: makeRawArtifact(ArtifactType.Session, {
          status: "execution_failed",
        }),
      })
    ).toBe(false);
    expect(
      isRowItemCompleted({
        kind: "session",
        data: makeRawArtifact(ArtifactType.Session, {
          status: SESSION_STATUS.ERROR,
        }),
      })
    ).toBe(true);
    expect(
      isRowItemCompleted({
        kind: "session",
        data: makeRawArtifact(ArtifactType.Session, {
          status: SESSION_STATUS.INACTIVE,
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
